// One mainnet pass of the agent's core verb on Base: live 0G inference -> agent-signed EIP-712 quotes posted to the
// board -> a fill through the deployed AquaSwapVMRouter against the live Aqua strategy. Spends real gas.
// The fill is sent from the maker's own wallet (a self-fill), so it proves execution, not outside demand.
import { createPublicClient, erc20Abi, formatUnits, http, keccak256, toHex, type Address, type Hex } from "viem";
import { base } from "viem/chains";
import { askBrain } from "../src/brain.js";
import { readMarket, USDC, W0G } from "../src/price.js";
import { directionalRates } from "../src/runtime.js";
import { localSigner, signQuote } from "../src/signer.js";
import { post, boardAbi } from "../src/poster.js";
import { quote as routerQuote, swap, type ShippedOrder } from "../src/taker.js";
import { parseAbi } from "viem";

const BOARD = (process.env.BOARD_ADDRESS || "0x309933CE439Da6A059593d73B8c82E8C8447C3F8") as Address;
const FILL_USDC = BigInt(process.env.FILL_USDC || "100000");
const TTL = Number(process.env.QUOTE_TTL_SECONDS || "900");
const rpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";
// Base priority fees sit near 0.001 gwei; pin it so a near-empty gas wallet never inherits a 1 gwei node default.
const baseLowFee = { ...base, fees: { defaultPriorityFee: BigInt(process.env.PRIORITY_FEE_WEI || "1000000") } };
const orderPath = new URL("../../.progress/live-order.json", import.meta.url);
const shipped = JSON.parse(await Bun.file(orderPath).text());
const order: ShippedOrder = { maker: shipped.order.maker, traits: BigInt(shipped.order.traits), data: shipped.order.data };

const raw = process.env.AGENT_PK || (await Bun.file(new URL("../../contracts/.env", import.meta.url)).text()).match(/^DEPLOYER_PK=(.+)$/m)?.[1];
const key = raw?.trim().replace(/^["']|["']$/g, "");
if (!key) throw new Error("no agent key");
const { account, wallet } = localSigner(key.startsWith("0x") ? key : `0x${key}`, baseLowFee);
const client = createPublicClient({ chain: baseLowFee, transport: http(rpc) });
const nonceAbi = parseAbi(["function lastNonce(address) view returns (uint64)", "function getAgent(address) view returns (address)"]);

if ((await client.readContract({ address: BOARD, abi: nonceAbi, functionName: "getAgent", args: [order.maker] })).toLowerCase() !== account.address.toLowerCase()) throw new Error("signer is not the registered agent for this maker");
const market = await readMarket(client);
const [wbal, ubal] = await Promise.all([W0G, USDC].map(t => client.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [order.maker] })));
const brain = await askBrain({ mid: market.mid, recentMids: [market.mid], inventory: { w0g: Number(formatUnits(wbal, 18)), usdc: Number(formatUnits(ubal, 6)) }, budgetTier: "NORMAL" });
console.log(`INFERENCE request_id=${brain.requestId} model=${brain.model} spreadBps=${brain.spreadBps} costMicroUsd=${brain.costMicroUsd} mid=${market.mid}`);

const rates = directionalRates(brain.rateE18, brain.spreadBps);
let nonce = await client.readContract({ address: BOARD, abi: nonceAbi, functionName: "lastNonce", args: [order.maker] });
const expiry = BigInt(Math.floor(Date.now() / 1000) + TTL);
for (const [tokenIn, tokenOut, rateE18] of [[USDC, W0G, rates.usdcToW0g], [W0G, USDC, rates.w0gToUsdc]] as const) {
  nonce++;
  const q = { maker: order.maker, tokenIn, tokenOut, rateE18, expiry, nonce, inferenceId: keccak256(toHex(brain.requestId + tokenIn + tokenOut)) };
  const sig = await signQuote(wallet, 8453, BOARD, q);
  const sent = await post(client, wallet, BOARD, q, sig);
  console.log(`POSTED ${tokenIn === USDC ? "USDC->W0G" : "W0G->USDC"} tx=${sent.hash} rateE18=${rateE18} expiry=${expiry} inferenceId=${q.inferenceId}`);
}

const preview = await routerQuote(client, order, { tokenIn: USDC, tokenOut: W0G, amountIn: FILL_USDC });
console.log(`ROUTER_QUOTE usdcIn=${formatUnits(preview.amountIn, 6)} w0gOut=${formatUnits(preview.amountOut, 18)} orderHash=${preview.orderHash}`);
const fill = await swap(client, wallet, order, { tokenIn: USDC, tokenOut: W0G, amountIn: FILL_USDC });
console.log(`FILL tx=${fill.hash} status=${fill.receipt.status} gasUsed=${fill.receipt.gasUsed}`);
