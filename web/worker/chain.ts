import { createPublicClient, fallback, http, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { readMarket } from "../../agent/src/price";
import { quote as routerQuote, type ShippedOrder } from "../../agent/src/taker";
import { AGENT, AQUA, BOARD, BOARD_DEPLOY_BLOCK, PAYMENT_LAYER } from "../lib/evidence";
import { AQUA_ROUTER, USDC, W0G } from "../lib/config";
import order from "../lib/live-order.json";

export const BASE_RPC = process.env.BASE_RPC_URL || "https://mainnet.base.org";
export const BASE_LOGS_RPC = process.env.BASE_LOGS_RPC_URL || "https://base-rpc.publicnode.com";
export const ZG_RPC = process.env.ZG_RPC_URL || "https://evmrpc.0g.ai";

export const baseClient = createPublicClient({ transport: fallback([http(BASE_RPC, { retryCount: 1 }), http(BASE_LOGS_RPC, { retryCount: 1 })]) });
export const logsClient = createPublicClient({ transport: http(BASE_LOGS_RPC, { retryCount: 2 }) });
export const zeroGClient = createPublicClient({ transport: http(ZG_RPC, { retryCount: 2 }) });

export const liveOrder: ShippedOrder = { maker: order.order.maker as Address, traits: BigInt(order.order.traits), data: order.order.data as Hex };
export { routerQuote };

const abi = parseAbi([
  "function getQuote(address maker,address tokenIn,address tokenOut) view returns ((address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId))",
  "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const postedEvent = parseAbiItem("event QuotePosted(address indexed maker,address indexed tokenIn,address indexed tokenOut,uint256 rateE18,uint64 expiry,bytes32 inferenceId)");
// SwapVM declares Swapped with no indexed fields, so the maker filter runs on decoded args.
const swappedEvent = parseAbiItem("event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)");

export type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type Post = { tokenIn: Address; tokenOut: Address; rateE18: string; expiry: string; inferenceId: Hex; postedTx: Hex; block: string };
export type FillRow = { txHash: Hex; logIndex: number; block: string; timeMs: number | null; orderHash: Hex; taker: Address; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string };
export type LogIndex = { cursor: string; posts: Post[]; fills: FillRow[] };

const CHUNK = 50_000n;
const MAX_CHUNKS = 8;
const PERSIST_LAG = 20_000n;
let memo: { at: number; idx: LogIndex } | null = null;

/** QuotePosted and Swapped logs since the board deploy block, kept in KV with a block cursor so each read scans only new blocks. */
export async function readLogIndex(kv: Kv | null): Promise<LogIndex> {
  if (memo && Date.now() - memo.at < 10_000) return memo.idx;
  const saved = (memo?.idx ?? (kv ? ((await kv.get("log-index", "json")) as LogIndex | null) : null)) ?? { cursor: (BOARD_DEPLOY_BLOCK - 1n).toString(), posts: [], fills: [] };
  const latest = await logsClient.getBlockNumber();
  const ranges: Array<[bigint, bigint]> = [];
  for (let from = BigInt(saved.cursor) + 1n; from <= latest && ranges.length < MAX_CHUNKS; from += CHUNK) ranges.push([from, from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n]);
  if (ranges.length === 0) return saved;
  const pages = await Promise.all(ranges.map(([fromBlock, toBlock]) => Promise.all([
    logsClient.getLogs({ address: BOARD, event: postedEvent, args: { maker: AGENT }, fromBlock, toBlock }),
    logsClient.getLogs({ address: AQUA_ROUTER, event: swappedEvent, fromBlock, toBlock }),
  ])));
  const posts: Post[] = pages.flatMap(([p]) => p.map((l) => ({ tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, rateE18: l.args.rateE18!.toString(), expiry: l.args.expiry!.toString(), inferenceId: l.args.inferenceId!, postedTx: l.transactionHash, block: l.blockNumber.toString() })));
  const swaps = pages.flatMap(([, s]) => s).filter((l) => l.args.maker?.toLowerCase() === AGENT.toLowerCase());
  const times = new Map<bigint, number>();
  await Promise.all([...new Set(swaps.map((l) => l.blockNumber))].map(async (n) => times.set(n, Number((await logsClient.getBlock({ blockNumber: n })).timestamp) * 1000)));
  const fills: FillRow[] = swaps.map((l) => ({ txHash: l.transactionHash, logIndex: l.logIndex, block: l.blockNumber.toString(), timeMs: times.get(l.blockNumber) ?? null, orderHash: l.args.orderHash!, taker: l.args.taker!, tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, amountIn: l.args.amountIn!.toString(), amountOut: l.args.amountOut!.toString() }));
  const idx: LogIndex = { cursor: ranges.at(-1)![1].toString(), posts: [...saved.posts, ...posts], fills: [...saved.fills, ...fills] };
  if (kv && (posts.length > 0 || fills.length > 0 || BigInt(idx.cursor) - BigInt(saved.cursor) >= PERSIST_LAG)) await kv.put("log-index", JSON.stringify(idx));
  memo = { at: Date.now(), idx };
  return idx;
}

/** Live reads the status page needs, each from its system of record, with the block it was read at. */
export async function readChain() {
  const [market, current, strategy, vaultWei, gasWei, baseBlock, zeroGBlock] = await Promise.all([
    // The agent package resolves its own viem types; the runtime module is the same viem via resolveAlias.
    readMarket(baseClient as never),
    Promise.all([[USDC, W0G], [W0G, USDC]].map(([a, b]) => baseClient.readContract({ address: BOARD, abi, functionName: "getQuote", args: [AGENT, a as Address, b as Address] }))),
    baseClient.readContract({ address: AQUA, abi, functionName: "safeBalances", args: [AGENT, AQUA_ROUTER, order.strategyHash as Hex, W0G, USDC] }),
    zeroGClient.readContract({ address: PAYMENT_LAYER, abi, functionName: "balanceOf", args: [AGENT] }),
    baseClient.getBalance({ address: AGENT }),
    baseClient.getBlockNumber(),
    zeroGClient.getBlockNumber(),
  ]);
  return { mid: market.mid, current: current.filter((q) => q.expiry > 0n), strategy: { w0g: strategy[0], usdc: strategy[1] }, vaultWei, gasWei, baseBlock, zeroGBlock };
}
