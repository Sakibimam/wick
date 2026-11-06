import { createPublicClient, fallback, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { readTwapMarket } from "../../agent/src/price";
import { quote as routerQuote, type ShippedOrder } from "../../agent/src/taker";
import { boardV2Abi } from "../../agent/src/poster";
import { ETH_USDC_POOL, ethUsdFromSqrt } from "../../agent/src/worker-tick";
import { AGENT, AQUA, BOARD_DEPLOY_BLOCK, PAYMENT_LAYER } from "../lib/evidence";
import { AQUA_ROUTER, USDC, W0G } from "../lib/config";
import { BOARD_V2, BOARD_V2_DEPLOY_BLOCK, liveOrderV2, STRATEGY_HASH_V2 } from "./v2";

export const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
export const BASE_LOGS_RPC = process.env.BASE_LOGS_RPC_URL || "https://base-rpc.publicnode.com";
export const ZG_RPC = process.env.ZG_RPC_URL || "https://evmrpc.0g.ai";

// Clients are built per request: a module-level viem client shares cached promises (getBlockNumber) across
// concurrent Worker requests, and a request awaiting another request's promise hangs until Cloudflare cancels it.
export const baseClient = () => createPublicClient({ transport: fallback([http(BASE_LOGS_RPC, { retryCount: 1, batch: true }), http(BASE_RPC, { retryCount: 1, batch: true })]), batch: { multicall: true } });
// One short attempt: a throttled log scan must fall back to the saved index, not hold the status route open.
export const logsClient = () => createPublicClient({ transport: http(BASE_LOGS_RPC, { retryCount: 0, timeout: 6_000 }) });
export const zeroGClient = () => createPublicClient({ transport: http(ZG_RPC, { retryCount: 2 }) });

export const liveOrder: ShippedOrder = liveOrderV2;
export { routerQuote };

const abi = parseAbi([
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
]);
const postedV2 = parseAbiItem("event QuotePosted(address indexed maker,address indexed tokenIn,address indexed tokenOut,uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)");
// SwapVM declares Swapped with no indexed fields, so the maker filter runs on decoded args.
const swappedEvent = parseAbiItem("event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)");

export type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type Post = { tokenIn: Address; tokenOut: Address; rateE18: string; expiry: string; inferenceId: Hex; postedTx: Hex; block: string; maxAmountIn?: string; epoch?: string; nonce?: string; board?: Address };
export type FillRow = { txHash: Hex; logIndex: number; block: string; timeMs: number | null; orderHash: Hex; taker: Address; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string };
export type LogIndex = { cursor: string; posts: Post[]; fills: FillRow[] };

const CHUNK = 50_000n;
const MAX_CHUNKS = 8;
const PERSIST_LAG = 20_000n;
let memo: { at: number; idx: LogIndex } | null = null;

/** v1 board history up to its last scanned block: v1 is docked, so the index is read, never extended. */
export async function readV1Index(kv: Kv | null): Promise<LogIndex | null> {
  return kv ? ((await kv.get("log-index", "json")) as LogIndex | null) : null;
}

/** v2 QuotePosted logs and every Swapped fill for the maker since the v1 index ended, kept in KV with a block cursor. */
export async function readLogIndex(kv: Kv | null): Promise<LogIndex> {
  if (memo && Date.now() - memo.at < 10_000) return memo.idx;
  let saved = memo?.idx ?? (kv ? ((await kv.get("log-index-v2", "json")) as LogIndex | null) : null);
  if (!saved) {
    const v1 = await readV1Index(kv).catch(() => null);
    const start = v1 ? BigInt(v1.cursor) : BOARD_V2_DEPLOY_BLOCK - 1n;
    saved = { cursor: (start < BOARD_V2_DEPLOY_BLOCK - 1n ? start : BOARD_V2_DEPLOY_BLOCK - 1n).toString(), posts: [], fills: [] };
  }
  const ranges: Array<[bigint, bigint]> = [];
  const logs = logsClient();
  let pages;
  try {
    const latest = await logs.getBlockNumber();
    for (let from = BigInt(saved.cursor) + 1n; from <= latest && ranges.length < MAX_CHUNKS; from += CHUNK) ranges.push([from, from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n]);
    if (ranges.length === 0) return saved;
    pages = await Promise.all(ranges.map(([fromBlock, toBlock]) => Promise.all([
      logs.getLogs({ address: BOARD_V2, event: postedV2, args: { maker: AGENT }, fromBlock, toBlock }),
      logs.getLogs({ address: AQUA_ROUTER, event: swappedEvent, fromBlock, toBlock }),
    ])));
  } catch (e) {
    // publicnode throttles bursts of range scans; the saved index is exact up to its cursor, which the route reports as toBlock.
    if (BigInt(saved.cursor) >= BOARD_DEPLOY_BLOCK) { memo = { at: Date.now(), idx: saved }; return saved; }
    throw e;
  }
  const posts: Post[] = pages.flatMap(([p]) => p.map((l) => ({ tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, rateE18: l.args.rateE18!.toString(), maxAmountIn: l.args.maxAmountIn!.toString(), expiry: l.args.expiry!.toString(), epoch: l.args.epoch!.toString(), nonce: l.args.nonce!.toString(), inferenceId: l.args.inferenceId!, postedTx: l.transactionHash, block: l.blockNumber.toString(), board: BOARD_V2 })));
  const swaps = pages.flatMap(([, s]) => s).filter((l) => l.args.maker?.toLowerCase() === AGENT.toLowerCase());
  const times = new Map<bigint, number>();
  await Promise.all([...new Set(swaps.map((l) => l.blockNumber))].map(async (n) => times.set(n, Number((await logs.getBlock({ blockNumber: n })).timestamp) * 1000)));
  const fills: FillRow[] = swaps.map((l) => ({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber.toString(), timeMs: times.get(l.blockNumber) ?? null, orderHash: l.args.orderHash!, taker: l.args.taker!, tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, amountIn: l.args.amountIn!.toString(), amountOut: l.args.amountOut!.toString() }));
  const idx: LogIndex = { cursor: ranges.at(-1)![1].toString(), posts: [...saved.posts, ...posts], fills: [...saved.fills, ...fills] };
  if (kv && (posts.length > 0 || fills.length > 0 || BigInt(idx.cursor) - BigInt(saved.cursor) >= PERSIST_LAG)) await kv.put("log-index-v2", JSON.stringify(idx));
  memo = { at: Date.now(), idx };
  return idx;
}

/** Every maker fill, v1 history first, deduplicated by tx and log index. */
export async function readAllFills(kv: Kv | null): Promise<{ fills: FillRow[]; cursor: string }> {
  const [v1, v2] = await Promise.all([readV1Index(kv).catch(() => null), readLogIndex(kv)]);
  const seen = new Set<string>();
  const fills = [...(v1?.fills ?? []), ...v2.fills].filter((f) => { const k = `${f.txHash}:${f.logIndex}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { fills, cursor: v2.cursor };
}

/** Live reads the status page needs, each from its system of record, with the block it was read at. */
export async function readChain() {
  const baseC = baseClient();
  const zg = zeroGClient();
  const [market, current, epoch, strategy, walletW0g, walletUsdc, ethPool, vaultWei, gasWei, baseBlock, zeroGBlock] = await Promise.all([
    // The agent package resolves its own viem types; the runtime module is the same viem via resolveAlias.
    readTwapMarket(baseC as never),
    Promise.all([[USDC, W0G], [W0G, USDC]].map(([a, b]) => baseC.readContract({ address: BOARD_V2, abi: boardV2Abi, functionName: "getQuote", args: [AGENT, a as Address, b as Address] }).then((q) => ({ ...q, tokenIn: a as Address, tokenOut: b as Address })))),
    baseC.readContract({ address: BOARD_V2, abi: boardV2Abi, functionName: "epochOf", args: [AGENT] }),
    baseC.readContract({ address: AQUA, abi, functionName: "safeBalances", args: [AGENT, AQUA_ROUTER, STRATEGY_HASH_V2, W0G, USDC] }),
    baseC.readContract({ address: W0G, abi, functionName: "balanceOf", args: [AGENT] }),
    baseC.readContract({ address: USDC, abi, functionName: "balanceOf", args: [AGENT] }),
    baseC.readContract({ address: ETH_USDC_POOL, abi, functionName: "slot0" }),
    zg.readContract({ address: PAYMENT_LAYER, abi, functionName: "balanceOf", args: [AGENT] }),
    baseC.getBalance({ address: AGENT }),
    baseC.getBlockNumber(),
    zg.getBlockNumber(),
  ]);
  return { mid: market.twapMid, spotMid: market.spotMid, gapBps: market.gapBps, epoch, current: current.filter((q) => q.expiry > 0n), strategy: { w0g: strategy[0], usdc: strategy[1] }, wallet: { w0g: walletW0g, usdc: walletUsdc }, ethUsd: ethUsdFromSqrt(ethPool[0]), vaultWei, gasWei, baseBlock, zeroGBlock };
}
