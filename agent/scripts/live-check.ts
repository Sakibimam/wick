import { createPublicClient, decodeErrorResult, encodeFunctionData, formatUnits, http, parseAbiItem, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { quoteUsdcForW0g, readMarket } from "../src/price.js";
import { fundingAbi, quoteCcipFee, ZERO_G_PAYMENT_LAYER } from "../src/funding.js";

const zeroGChain = { id: 16661, name: "0G Mainnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [process.env.ZG_RPC_URL || "https://evmrpc.0g.ai"] } } } as const;
const baseClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com") });
const zeroGClient = createPublicClient({ chain: zeroGChain, transport: http(process.env.ZG_RPC_URL || "https://evmrpc.0g.ai") });
const trim = (s: string) => s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
const revertData = (e: any, seen = new Set<object>()): Hex | undefined => { if (!e || typeof e !== "object" || seen.has(e)) return undefined; seen.add(e); if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data; return revertData(e.cause, seen) ?? revertData(e.error, seen); };
async function main() {
  const market = await readMarket(baseClient);
  const quote = await quoteUsdcForW0g(baseClient, { usdcAmountIn: 5_000_000n, fee: market.fee });
  const recipient = (process.env.AGENT_ADDRESS || "0x0000000000000000000000000000000000000001") as Address;
  const fee = await quoteCcipFee(baseClient, { agent: recipient, w0gAmount: 10n ** 18n });
  const account = privateKeyToAccount(generatePrivateKey());
  const amount = 10n ** 15n;
  await zeroGClient.call({ account, to: ZERO_G_PAYMENT_LAYER, data: encodeFunctionData({ abi: fundingAbi.payment, functionName: "depositFor", args: [account.address] }), value: amount, stateOverride: [{ address: account.address, balance: amount }] });
  let zeroName = "";
  try {
    await zeroGClient.call({ account, to: ZERO_G_PAYMENT_LAYER, data: encodeFunctionData({ abi: fundingAbi.payment, functionName: "depositFor", args: [account.address] }), value: 0n, stateOverride: [{ address: account.address, balance: amount }] });
  } catch (e) { const data = revertData(e); if (data) zeroName = decodeErrorResult({ abi: fundingAbi.payment, data }).errorName; }
  if (zeroName !== "ZeroAmount") throw new Error(`expected decoded ZeroAmount error, received ${zeroName || "no decodable revert"}`);
  const latest = await zeroGClient.getBlockNumber();
  const lookback = BigInt(process.env.PAYMENT_LOG_LOOKBACK_BLOCKS || "100000");
  if (lookback <= 0n) throw new Error("PAYMENT_LOG_LOOKBACK_BLOCKS must be positive");
  const start = latest > lookback ? latest - lookback : 0n;
  const event = parseAbiItem("event Deposited(address indexed from,address indexed user,uint256 amount)");
  let found: { user: Address } | undefined;
  for (let end = latest; end >= start; ) {
    const begin = end - start > 9999n ? end - 9999n : start;
    const logs = await zeroGClient.getLogs({ address: ZERO_G_PAYMENT_LAYER, event, fromBlock: begin, toBlock: end });
    if (logs.length) { const log = logs.sort((a, b) => a.blockNumber! < b.blockNumber! ? -1 : a.blockNumber! > b.blockNumber! ? 1 : a.logIndex! - b.logIndex!).at(-1)!; found = { user: log.args.user! }; break; }
    if (begin === start) break;
    end = begin - 1n;
  }
  if (!found) throw new Error(`no Deposited event found in ${lookback} block window`);
  const balance = await zeroGClient.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [found.user] });
  const mid = trim(market.mid.toFixed(8));
  const q = trim(formatUnits(quote.amountOut, 18));
  process.stdout.write([`W0G_USDC_MID=${mid}`, `QUOTE_5USDC_W0G=${q}`, `CCIP_FEE_WEI=${fee}`, "DEPOSITFOR_SIM=OK", "DEPOSITFOR_ZERO=REVERT ZeroAmount", `PAYMENT_BALANCE=${balance}`].join("\n") + "\n");
}
main().catch(e => { process.stderr.write(`live-check failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
