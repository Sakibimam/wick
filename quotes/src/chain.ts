// Base reads and the two settlement paths. Every read goes to the system of record: the board, the router, Aqua and USDC.
import { createPublicClient, createWalletClient, fallback, getAddress, http, parseAbi, parseEventLogs, parseSignature, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import order from "../../web/lib/live-order.json";
import { USDC, type Authorization, type PaymentPayload, type PaymentRequirements } from "./x402";

export const W0G: Address = getAddress("0x23cd099eB438CcA50349EE2BC809196b1ae00861");
const AQUA: Address = getAddress("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
const ROUTER: Address = getAddress("0x111111338c5091e8440b67b168bae16a668ac0de");
const TAKER_TRAITS_EXACT_IN: Hex = `0x${"0".repeat(40)}0041`;
const liveOrder = { maker: getAddress(order.order.maker), traits: BigInt(order.order.traits), data: order.order.data as Hex };

const abi = parseAbi([
  "function getQuote(address maker,address tokenIn,address tokenOut) view returns ((address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId))",
  "function quote((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) view returns (uint256 amountIn,uint256 amountOut,bytes32 orderHash)",
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
]);

export type ChainEnv = { BASE_RPC_URL?: string; BOARD_ADDRESS: string; MAKER: string; STATUS_URL?: string; FACILITATOR_URL?: string; SETTLE_MODE?: string; RELAYER_PK?: string };

export type LiveQuote = {
  board: Address; maker: Address; tokenIn: Address; tokenOut: Address;
  rateE18: string; expiry: string; nonce: string; inferenceId: Hex; requestId: string | null; postedTx: Hex | null;
  amountIn: string; routerAmountOut: string; strategyDepthOut: string; amountOut: string; orderHash: Hex; readAtBlock: string;
};

// mainnet.base.org answers Cloudflare egress with 429; publicnode first, the configured RPC and drpc behind it.
const transport = (env: ChainEnv) => {
  const urls = [...new Set([env.BASE_RPC_URL || "https://base-rpc.publicnode.com", ...(isLocal(env.BASE_RPC_URL) ? [] : ["https://base-rpc.publicnode.com", "https://base.drpc.org"])])];
  return fallback(urls.map((u) => http(u, { retryCount: 0, batch: true })), { retryCount: 1 });
};
const isLocal = (u?: string) => !!u && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(u);
// Built per request: a shared viem client shares in-flight promises across Worker requests.
export const publicClient = (env: ChainEnv) => createPublicClient({ chain: base, transport: transport(env), batch: { multicall: true }, pollingInterval: 2_000 });

/** The board quote for the pair, the router's amountOut for this size, capped at what the strategy holds of tokenOut. Null when no live quote exists. */
export async function readQuote(env: ChainEnv, tokenIn: Address, amountIn: bigint, nowSec: number): Promise<LiveQuote | null> {
  const c = publicClient(env);
  const board = getAddress(env.BOARD_ADDRESS);
  const maker = getAddress(env.MAKER);
  const tokenOut = tokenIn === USDC ? W0G : USDC;
  const [q, depth, block] = await Promise.all([
    c.readContract({ address: board, abi, functionName: "getQuote", args: [maker, tokenIn, tokenOut] }),
    c.readContract({ address: AQUA, abi, functionName: "safeBalances", args: [maker, ROUTER, order.strategyHash as Hex, W0G, USDC] }),
    c.getBlockNumber(),
  ]);
  if (q.expiry <= BigInt(nowSec)) return null;
  const [, routerOut, orderHash] = await c.readContract({ address: ROUTER, abi, functionName: "quote", args: [liveOrder, tokenIn, tokenOut, amountIn, TAKER_TRAITS_EXACT_IN] });
  const depthOut = tokenOut === W0G ? depth[0] : depth[1];
  const posted = await postedBy(env, q.inferenceId);
  return {
    board, maker, tokenIn, tokenOut,
    rateE18: q.rateE18.toString(), expiry: q.expiry.toString(), nonce: q.nonce.toString(), inferenceId: q.inferenceId,
    requestId: posted?.requestId ?? null, postedTx: posted?.postedTx ?? null,
    amountIn: amountIn.toString(), routerAmountOut: routerOut.toString(), strategyDepthOut: depthOut.toString(),
    amountOut: (routerOut < depthOut ? routerOut : depthOut).toString(), orderHash, readAtBlock: block.toString(),
  };
}

/** The 0G Compute request id behind an inferenceId, from the main site's status document (inferenceId = keccak256(requestId + tokenIn + tokenOut)). */
async function postedBy(env: ChainEnv, inferenceId: Hex): Promise<{ requestId: string | null; postedTx: Hex | null } | null> {
  if (!env.STATUS_URL) return null;
  try {
    const res = await fetch(env.STATUS_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) { console.warn(`status read ${res.status}`); return null; }
    const s = (await res.json()) as { quotes?: Array<{ inferenceId: string; requestId: string | null; postedTx?: Hex }> };
    const hit = s.quotes?.find((x) => x.inferenceId.toLowerCase() === inferenceId.toLowerCase());
    return hit ? { requestId: hit.requestId, postedTx: hit.postedTx ?? null } : null;
  } catch (e) {
    console.warn(`status read failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export const authorizationUsed = (env: ChainEnv, a: Authorization) =>
  publicClient(env).readContract({ address: USDC, abi, functionName: "authorizationState", args: [getAddress(a.from), a.nonce] });

/** Submits the authorization: through the x402 facilitator (it pays gas), or with the operator's relayer key. Returns the tx hash. */
export async function settle(env: ChainEnv, p: PaymentPayload, req: PaymentRequirements): Promise<Hex> {
  if (env.SETTLE_MODE === "relayer") {
    if (!env.RELAYER_PK) throw new Error("relayer_key_not_set");
    const account = privateKeyToAccount(env.RELAYER_PK as Hex);
    const wallet = createWalletClient({ account, chain: { ...base, fees: { maxPriorityFeePerGas: 1_000_000n } }, transport: transport(env) });
    const a = p.payload.authorization;
    const { v, r, s, yParity } = parseSignature(p.payload.signature);
    return wallet.writeContract({
      address: USDC, abi, functionName: "transferWithAuthorization",
      args: [getAddress(a.from), getAddress(a.to), BigInt(a.value), BigInt(a.validAfter), BigInt(a.validBefore), a.nonce, Number(v ?? BigInt(yParity + 27)), r, s],
    });
  }
  const url = (env.FACILITATOR_URL || "https://facilitator.payai.network").replace(/\/+$/, "");
  const res = await fetch(`${url}/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ x402Version: 1, paymentPayload: p, paymentRequirements: req }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as { success?: boolean; transaction?: string; errorReason?: string } | null;
  if (!body?.success || !body.transaction || !/^0x[0-9a-fA-F]{64}$/.test(body.transaction)) throw new Error(`facilitator_settle_failed: ${body?.errorReason ?? `http ${res.status}`}`);
  return body.transaction as Hex;
}

/** The post-condition only a completed payment produces: a mined, successful tx carrying the exact USDC Transfer payer to payTo. */
export async function confirm(env: ChainEnv, tx: Hex, a: Authorization): Promise<{ block: bigint }> {
  const receipt = await publicClient(env).waitForTransactionReceipt({ hash: tx, timeout: 45_000, retryCount: 6 });
  if (receipt.status !== "success") throw new Error(`settlement_reverted: ${tx}`);
  const paid = parseEventLogs({ abi, eventName: "Transfer", logs: receipt.logs.filter((l) => getAddress(l.address) === USDC) })
    .some((l) => l.args.from === getAddress(a.from) && l.args.to === getAddress(a.to) && l.args.value === BigInt(a.value));
  if (!paid) throw new Error(`settlement_missing_transfer: ${tx}`);
  return { block: receipt.blockNumber };
}
