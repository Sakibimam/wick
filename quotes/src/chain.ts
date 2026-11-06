// Base reads and the two settlement paths. Every read goes to the system of record: the board, the router, Aqua and USDC.
import { createPublicClient, createWalletClient, fallback, getAddress, http, parseAbi, parseEventLogs, parseSignature, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
// The v2 order the site ships; bundled at build time so a deploy carries exactly the strategy it was built against.
import order from "../../web/worker/live-order-v2.json";
import { USDC, type Authorization, type PaymentPayload, type PaymentRequirements } from "./x402";

export const W0G: Address = getAddress("0x23cd099eB438CcA50349EE2BC809196b1ae00861");
const AQUA: Address = getAddress("0x1111113ccf1426a8e30e2bff5e005d929bf6a90a");
const ROUTER: Address = getAddress("0x111111338c5091e8440b67b168bae16a668ac0de");
const TAKER_TRAITS_EXACT_IN: Hex = `0x${"0".repeat(40)}0041`;
const liveOrder = { maker: getAddress(order.order.maker), traits: BigInt(order.order.traits), data: order.order.data as Hex };

export const abi = parseAbi([
  "function getQuote(address maker,address tokenIn,address tokenOut) view returns ((uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId))",
  "function isQuoteCurrent(address maker,address tokenIn,address tokenOut) view returns (bool)",
  "function quote((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) view returns (uint256 amountIn,uint256 amountOut,bytes32 orderHash)",
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
  "function authorizationState(address authorizer,bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)",
  "event Transfer(address indexed from,address indexed to,uint256 value)",
  "event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)",
]);

export type ChainEnv = { BASE_RPC_URL?: string; BOARD_ADDRESS: string; MAKER: string; STATUS_URL?: string; FACILITATOR_URL?: string; SETTLE_MODE?: string; RELAYER_PK?: string };

export type LiveQuote = {
  board: Address; maker: Address; tokenIn: Address; tokenOut: Address;
  rateE18: string; maxAmountIn: string; expiry: string; epoch: string; nonce: string; inferenceId: Hex; requestId: string | null; postedTx: Hex | null;
  requestedAmountIn: string; amountIn: string; depthLimited: boolean;
  routerAmountOut: string; strategyDepthOut: string; amountOut: string; orderHash: Hex; readAtBlock: string;
};

export const MAX_TTL = 900n;
const FEE_BPS = BigInt(order.pair.feeBps);
const BPS = 10_000n;
export const ORDER_HASH = order.strategyHash as Hex;

const CLOCK_SKEW = 60n;
/** A posted quote is sellable while now < expiry, and no further out than the board's MAX_TTL lets a post reach (plus Worker clock skew). */
export const fresh = (expiry: bigint, nowSec: number) => expiry > BigInt(nowSec) && expiry <= BigInt(nowSec) + MAX_TTL + CLOCK_SKEW;

/** The input the extruction will fill: the ask, capped at the quote's maxAmountIn and at the input whose output fits the strategy's tokenOut balance.
 *  Same inversion as web/worker/api.ts depthCap, so a quote sold here never names a size the swap reverts on (AmountInTooLarge, InsufficientDepth). */
export function fillable(asked: bigint, rateE18: bigint, maxAmountIn: bigint, depthOut: bigint): bigint {
  if (rateE18 === 0n) return 0n;
  const byDepth = (((depthOut * BPS) / (BPS - FEE_BPS)) * 10n ** 18n) / rateE18;
  const cap = byDepth < maxAmountIn ? byDepth : maxAmountIn;
  return asked < cap ? asked : cap;
}

const pairOf = (tokenIn: Address) => ({ tokenIn, tokenOut: tokenIn === USDC ? W0G : USDC });

// mainnet.base.org answers Cloudflare egress with 429; publicnode first, the configured RPC and drpc behind it.
const transport = (env: ChainEnv) => {
  const urls = [...new Set([env.BASE_RPC_URL || "https://base-rpc.publicnode.com", ...(isLocal(env.BASE_RPC_URL) ? [] : ["https://base-rpc.publicnode.com", "https://base.drpc.org"])])];
  return fallback(urls.map((u) => http(u, { retryCount: 0, batch: true })), { retryCount: 1 });
};
const isLocal = (u?: string) => !!u && /^https?:\/\/(127\.0\.0\.1|localhost)/.test(u);
// Built per request: a shared viem client shares in-flight promises across Worker requests.
export const publicClient = (env: ChainEnv) => createPublicClient({ chain: base, transport: transport(env), batch: { multicall: true }, pollingInterval: 2_000 });

/** The v2 board quote for the pair and the router's amountOut for the fillable size. Null when no current, unexpired, fillable quote exists. */
export async function readQuote(env: ChainEnv, tokenIn: Address, amountIn: bigint, nowSec: number): Promise<LiveQuote | null> {
  const c = publicClient(env);
  const board = getAddress(env.BOARD_ADDRESS);
  const maker = getAddress(env.MAKER);
  const { tokenOut } = pairOf(tokenIn);
  const [q, current, depth, block] = await Promise.all([
    c.readContract({ address: board, abi, functionName: "getQuote", args: [maker, tokenIn, tokenOut] }),
    c.readContract({ address: board, abi, functionName: "isQuoteCurrent", args: [maker, tokenIn, tokenOut] }),
    c.readContract({ address: AQUA, abi, functionName: "safeBalances", args: [maker, ROUTER, ORDER_HASH, W0G, USDC] }),
    c.getBlockNumber(),
  ]);
  if (!current || !fresh(q.expiry, nowSec)) return null;
  const depthOut = tokenOut === W0G ? depth[0] : depth[1];
  const fill = fillable(amountIn, q.rateE18, q.maxAmountIn, depthOut);
  if (fill === 0n) return null;
  const [, routerOut, orderHash] = await c.readContract({ address: ROUTER, abi, functionName: "quote", args: [liveOrder, tokenIn, tokenOut, fill, TAKER_TRAITS_EXACT_IN] });
  const posted = await postedBy(env, q.inferenceId);
  return {
    board, maker, tokenIn, tokenOut,
    rateE18: q.rateE18.toString(), maxAmountIn: q.maxAmountIn.toString(), expiry: q.expiry.toString(), epoch: q.epoch.toString(), nonce: q.nonce.toString(), inferenceId: q.inferenceId,
    requestId: posted?.requestId ?? null, postedTx: posted?.postedTx ?? null,
    requestedAmountIn: amountIn.toString(), amountIn: fill.toString(), depthLimited: fill < amountIn,
    routerAmountOut: routerOut.toString(), strategyDepthOut: depthOut.toString(),
    amountOut: (routerOut < depthOut ? routerOut : depthOut).toString(), orderHash, readAtBlock: block.toString(),
  };
}

export type Health = { board: Address; orderHash: Hex; quoteFresh: boolean; expiry: string; readAtBlock: string };

/** Both directions of the v2 pair: fresh only when each is current in the maker's epoch and unexpired. expiry is the earlier of the two. */
export async function readHealth(env: ChainEnv, nowSec: number): Promise<Health> {
  const c = publicClient(env);
  const board = getAddress(env.BOARD_ADDRESS);
  const maker = getAddress(env.MAKER);
  const dirs = [pairOf(USDC), pairOf(W0G)];
  const [reads, block] = await Promise.all([
    Promise.all(dirs.map(({ tokenIn, tokenOut }) => Promise.all([
      c.readContract({ address: board, abi, functionName: "getQuote", args: [maker, tokenIn, tokenOut] }),
      c.readContract({ address: board, abi, functionName: "isQuoteCurrent", args: [maker, tokenIn, tokenOut] }),
    ]))),
    c.getBlockNumber(),
  ]);
  const expiry = reads.map(([q]) => q.expiry).reduce((a, b) => (a < b ? a : b));
  return { board, orderHash: ORDER_HASH, quoteFresh: reads.every(([q, cur]) => cur && fresh(q.expiry, nowSec)), expiry: expiry.toString(), readAtBlock: block.toString() };
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

type SettlementReceipt = { status: "success" | "reverted"; blockNumber: bigint; logs: { address: Address; topics: readonly Hex[] | Hex[]; data: Hex }[] };
/** The post-condition only this payment produces: a mined, successful tx carrying the exact USDC Transfer payer to payTo AND
 *  USDC's AuthorizationUsed for this payer and nonce, so a facilitator cannot answer with some other tx that moved the same amount. */
export function checkSettlement(tx: Hex, receipt: SettlementReceipt, a: Authorization): { block: bigint } {
  if (receipt.status !== "success") throw new Error(`settlement_reverted: ${tx}`);
  const usdcLogs = receipt.logs.filter((l) => getAddress(l.address) === USDC) as never;
  const paid = parseEventLogs({ abi, eventName: "Transfer", logs: usdcLogs })
    .some((l) => l.args.from === getAddress(a.from) && l.args.to === getAddress(a.to) && l.args.value === BigInt(a.value));
  if (!paid) throw new Error(`settlement_missing_transfer: ${tx}`);
  const authorized = parseEventLogs({ abi, eventName: "AuthorizationUsed", logs: usdcLogs })
    .some((l) => l.args.authorizer === getAddress(a.from) && l.args.nonce.toLowerCase() === a.nonce.toLowerCase());
  if (!authorized) throw new Error(`settlement_missing_authorization: ${tx}`);
  return { block: receipt.blockNumber };
}
export async function confirm(env: ChainEnv, tx: Hex, a: Authorization): Promise<{ block: bigint }> {
  return checkSettlement(tx, await publicClient(env).waitForTransactionReceipt({ hash: tx, timeout: 45_000, retryCount: 6 }), a);
}
