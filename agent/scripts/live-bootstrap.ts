// Mainnet bootstrap on Base: swap a USDC slice to W0G on Uniswap v3 and register the agent on the board.
// Spends real gas. Every step is idempotent: it reads chain state first and skips work already done.
import { createPublicClient, createWalletClient, http, erc20Abi, formatUnits, parseAbi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { fundingAbi, SWAP_ROUTER } from "../src/funding.js";
import { QUOTER_V2, quoterAbi, USDC, W0G } from "../src/price.js";

const BOARD = (process.env.BOARD_ADDRESS || "0x309933CE439Da6A059593d73B8c82E8C8447C3F8") as Address;
const USDC_IN = BigInt(process.env.BOOTSTRAP_USDC_IN || "400000");
const SLIPPAGE_BPS = 100n;
const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";

async function makerKey(): Promise<Hex> {
  const fromEnv = process.env.AGENT_PK || process.env.DEPLOYER_PK;
  const raw = fromEnv || (await Bun.file(new URL("../../contracts/.env", import.meta.url)).text()).match(/^DEPLOYER_PK=(.+)$/m)?.[1];
  const k = raw?.trim().replace(/^["']|["']$/g, "");
  if (!k) throw new Error("no maker key: set AGENT_PK or DEPLOYER_PK in contracts/.env");
  return (k.startsWith("0x") ? k : `0x${k}`) as Hex;
}

const account = privateKeyToAccount(await makerKey());
const client = createPublicClient({ chain: base, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: base, transport: http(rpc) });
const boardAbi = parseAbi(["function setAgent(address agent)", "function getAgent(address maker) view returns (address)"]);
// Explicit EIP-1559 fees: a near-empty gas wallet must not inherit a node's 1 gwei priority default.
const PRIORITY_WEI = BigInt(process.env.PRIORITY_FEE_WEI || "1000000");
const fees = async () => { const b = (await client.getBlock()).baseFeePerGas ?? 0n; return { maxPriorityFeePerGas: PRIORITY_WEI, maxFeePerGas: b * 2n + PRIORITY_WEI }; };
const confirm = async (label: string, hash: Hex) => {
  const r = await client.waitForTransactionReceipt({ hash, retryCount: 10, pollingInterval: 2_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}_TX=${hash} gasUsed=${r.gasUsed}`);
};

console.log(`MAKER=${account.address}`);
const [usdcBal, w0gBal] = await Promise.all([USDC, W0G].map(t => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })));
console.log(`BEFORE usdc=${formatUnits(usdcBal, 6)} w0g=${formatUnits(w0gBal, 18)}`);

if (w0gBal === 0n) {
  if (usdcBal < USDC_IN) throw new Error(`need ${formatUnits(USDC_IN, 6)} USDC, have ${formatUnits(usdcBal, 6)}`);
  const sim = await client.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, amountIn: USDC_IN, fee: 3000, sqrtPriceLimitX96: 0n }] });
  const expected = sim.result[0];
  const minOut = expected * (10_000n - SLIPPAGE_BPS) / 10_000n;
  console.log(`QUOTE usdcIn=${formatUnits(USDC_IN, 6)} w0gOut=${formatUnits(expected, 18)} minOut=${formatUnits(minOut, 18)}`);
  const allowance = () => client.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [account.address, SWAP_ROUTER] });
  if ((await allowance()) < USDC_IN) await confirm("APPROVE_USDC_ROUTER", await wallet.writeContract({ address: USDC, abi: fundingAbi.erc20, functionName: "approve", args: [SWAP_ROUTER, USDC_IN], ...(await fees()) }));
  else console.log("SKIP approve: allowance already set");
  // Public Base RPCs are load-balanced; wait until the node we hit sees the allowance before simulating the swap.
  for (let i = 0; (await allowance()) < USDC_IN; i++) { if (i >= 15) throw new Error("allowance not visible after 30 s"); await Bun.sleep(2_000); }
  await confirm("UNISWAP_SWAP", await wallet.writeContract({ address: SWAP_ROUTER, abi: fundingAbi.router, functionName: "exactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, fee: 3000, recipient: account.address, amountIn: USDC_IN, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }], ...(await fees()) }));
} else console.log("SKIP swap: maker already holds W0G");

const current = await client.readContract({ address: BOARD, abi: boardAbi, functionName: "getAgent", args: [account.address] });
if (current.toLowerCase() !== account.address.toLowerCase()) await confirm("SET_AGENT", await wallet.writeContract({ address: BOARD, abi: boardAbi, functionName: "setAgent", args: [account.address], ...(await fees()) }));
else console.log("SKIP setAgent: agent already registered");

const [u2, w2] = await Promise.all([USDC, W0G].map(t => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })));
console.log(`AFTER usdc=${formatUnits(u2, 6)} w0g=${formatUnits(w2, 18)} usdcRaw=${u2} w0gRaw=${w2}`);
