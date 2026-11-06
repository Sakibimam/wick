// Workers cron trigger: one agent tick per run on the v2 board. Reads chain state, applies the agent's budget policy,
// and signs and posts the quote pair only when policy says so and both secrets are set.
import { createPublicClient, http, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { cronTick, emptyCronState, DEFAULT_FUNDING_ENV, type CronState, type FillLite } from "../../agent/src/worker-tick";
import { AQUA_ROUTER, USDC } from "../lib/config";
import { BOARD_V2, BOARD_V2_DEPLOY_BLOCK, FEE_BPS_V2, liveOrderOf, orderHashesOf, SHIPPED_LIVE_ORDER, STRATEGY_HASH_V2, V4_HOOK } from "./v2";
import { fillsOfOrders, type FillRow, type LogIndex } from "./chain";
import { BASE_RPCS, baseFallback, type RpcFailures } from "./rpc";

type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type CronEnv = { UPKEEP_KV: Kv; AGENT_PK?: string; ZG_API_KEY?: string; ZG_API_BASE?: string; BASE_RPC_URL?: string; ZG_RPC_URL?: string; SPEND_CAP_PER_DAY_WEI?: string; FUNDING_K?: string; GAS_TOPUP_BELOW_WEI?: string; GAS_SHARE_BPS?: string; FUNDING_MAX_SPEND_WEI?: string };
/** Seams for tests: the tick itself and the x402 revenue read. Production passes neither. */
export type CronDeps = { tick?: typeof cronTick; x402Revenue?: (client: PublicClient, kv: Kv) => Promise<bigint> };

const AGENT: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
// Base priority fees run near 0.001 gwei; viem's 1 gwei default would overpay by three orders of magnitude.
const chain = { ...base, fees: { maxPriorityFeePerGas: 1_000_000n } };
/** Workers on the free plan allow 50 subrequests per invocation; the tick stops sending when it nears this. */
export const SUBREQUEST_CAP = 50;
export const X402_PRICE_ATOMIC = 10_000n;

const fingerprint = (s: CronState) => JSON.stringify({ ...s, lastTick: s.lastTick?.outcome ?? null, lastTicks: (s.lastTicks ?? []).map((t) => t.outcome) });

/** Counts every outbound fetch of one invocation, so each tick reports how close it ran to the subrequest cap. */
export function countingFetch(inner: typeof fetch = fetch) {
  const counter = { n: 0 };
  const f = ((input: RequestInfo | URL, init?: RequestInit) => { counter.n++; if (counter.n > SUBREQUEST_CAP - 2) return Promise.reject(new Error(`subrequest budget spent (${counter.n})`)); return inner(input, init); }) as typeof fetch;
  return { fetch: f, counter };
}

/** An RPC URL can carry a key in its path or query: only the host is ever logged or persisted. */
const hostOf = (url: string) => { try { return new URL(url).host; } catch { return "unparseable-url"; } };
export const hostsOnly = (t: string) => t.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, hostOf);

const transferEvent = parseAbiItem("event Transfer(address indexed from,address indexed to,uint256 value)");
const authorizationUsedEvent = parseAbiItem("event AuthorizationUsed(address indexed authorizer,bytes32 indexed nonce)");
type TransferLog = { transactionHash: Hex; args: { from?: Address; to?: Address; value?: bigint } };
type AuthLog = { transactionHash: Hex; args: { authorizer?: Address } };
/** An x402 settlement is a USDC transfer to the maker in a tx that also consumed the payer's EIP-3009 authorization
 *  (transferWithAuthorization emits both). A fill's USDC leg, or any plain transfer, carries no such authorization. */
export function x402Settlements(transfers: TransferLog[], auths: AuthLog[]): { tx: Hex; payer: Address; value: bigint }[] {
  const used = new Set(auths.map((a) => `${a.transactionHash.toLowerCase()}:${a.args.authorizer?.toLowerCase()}`));
  return transfers.filter((t) => t.args.from && t.args.value === X402_PRICE_ATOMIC && used.has(`${t.transactionHash.toLowerCase()}:${t.args.from.toLowerCase()}`)).map((t) => ({ tx: t.transactionHash, payer: t.args.from!, value: t.args.value ?? 0n }));
}

type X402Index = { cursor: string; revenueAtomic: string; txs: Hex[] };
const X402_CHUNK = 50_000n, X402_MAX_CHUNKS = 2, X402_PERSIST_LAG = 20_000n;
/** x402 quote revenue read from Base itself, never from the quote seller's unauthenticated stats: USDC Transfer logs to the
 *  maker since the v2 board deploy, kept with a block cursor in KV, counted only where the same tx used the payer's authorization. */
export async function readX402Revenue(client: PublicClient, kv: Kv): Promise<bigint> {
  const saved = ((await kv.get("x402-index", "json")) as X402Index | null) ?? { cursor: (BOARD_V2_DEPLOY_BLOCK - 1n).toString(), revenueAtomic: "0", txs: [] };
  let cursor = BigInt(saved.cursor), revenue = BigInt(saved.revenueAtomic);
  const txs = new Set(saved.txs.map((t) => t.toLowerCase() as Hex)), before = txs.size;
  // A failed scan stops at the last whole chunk: revenue stays exact up to the cursor and the next tick resumes from there.
  try {
    const latest = await client.getBlockNumber();
    for (let i = 0; i < X402_MAX_CHUNKS && cursor < latest; i++) {
      const fromBlock = cursor + 1n, toBlock = cursor + X402_CHUNK < latest ? cursor + X402_CHUNK : latest;
      const transfers = (await client.getLogs({ address: USDC, event: transferEvent, args: { to: AGENT }, fromBlock, toBlock })) as unknown as TransferLog[];
      const payers = [...new Set(transfers.map((t) => t.args.from!).filter(Boolean))];
      const auths = payers.length ? ((await client.getLogs({ address: USDC, event: authorizationUsedEvent, args: { authorizer: payers }, fromBlock, toBlock })) as unknown as AuthLog[]) : [];
      for (const p of x402Settlements(transfers, auths)) if (!txs.has(p.tx.toLowerCase() as Hex)) { txs.add(p.tx.toLowerCase() as Hex); revenue += p.value; }
      cursor = toBlock;
    }
  } catch (e) { console.warn(`x402 scan stopped at block ${cursor}: ${(e as { shortMessage?: string }).shortMessage ?? "log read failed"}`); }
  // KV allows 1,000 writes a day: persist on new revenue or a cursor far enough ahead to matter.
  if (txs.size > before || cursor - BigInt(saved.cursor) >= X402_PERSIST_LAG) await kv.put("x402-index", JSON.stringify({ cursor: cursor.toString(), revenueAtomic: revenue.toString(), txs: [...txs] } satisfies X402Index));
  return revenue;
}

/** Fills the tick may count as this agent's revenue: its own strategy hashes only (the maker wallet is shared), never the maker's self-fills. */
export const agentFills = (fills: FillRow[], prev: CronState | null) => fillsOfOrders(fills, liveOrderOf(prev)).filter((f) => f.taker.toLowerCase() !== AGENT.toLowerCase());

export async function runCron(env: CronEnv, deps: CronDeps = {}): Promise<void> {
  // Two workers can share this KV during a rename; one without the signer secrets must not overwrite the signer's state.
  if (!env.AGENT_PK || !env.ZG_API_KEY) { console.log("secrets not set"); return; }
  const baseRpcUrl = BASE_RPCS[0]!;
  const { fetch: counted, counter } = countingFetch();
  // Endpoints proven from Cloudflare egress, in order; each costs a subrequest only when the one before it fails.
  const rpcFailures: RpcFailures = {};
  const baseTransport = baseFallback({ fetchFn: counted, failures: rpcFailures });
  const zeroGTransport = http(env.ZG_RPC_URL || "https://evmrpc.0g.ai", { retryCount: 1, batch: true, fetchFn: counted });
  const baseClient = createPublicClient({ chain, transport: baseTransport, batch: { multicall: true }, pollingInterval: 2_000 });
  const prev = ((await env.UPKEEP_KV.get("cron-state", "json")) as CronState | null) ?? emptyCronState();
  const [v1, v2] = await Promise.all([env.UPKEEP_KV.get("log-index", "json") as Promise<LogIndex | null>, env.UPKEEP_KV.get("log-index-v2", "json") as Promise<LogIndex | null>]);
  const all: FillRow[] = [...(v1?.fills ?? []), ...(v2?.fills ?? [])].filter((f, i, a) => a.findIndex((g) => g.txHash === f.txHash && g.logIndex === f.logIndex) === i);
  const fills: FillLite[] = agentFills(all, prev);
  const live = liveOrderOf(prev);
  let next: CronState;
  try {
    // x402 quote revenue settles in USDC to the maker; the funding machine spends only what the wallet holds above every strategy.
    const x402RevenueUsdc = await (deps.x402Revenue ?? readX402Revenue)(baseClient as never, env.UPKEEP_KV);
    ({ state: next } = await (deps.tick ?? cronTick)(prev, {
      // Agent sources carry their own viem type identity; at runtime wrangler aliases both to one copy.
      base: baseClient as never,
      zeroG: createPublicClient({ transport: zeroGTransport, batch: { multicall: true } }) as never,
      chain: chain as never,
      baseRpcUrl,
      baseTransport: baseTransport as never,
      zeroGTransport: zeroGTransport as never,
      board: BOARD_V2,
      aquaApp: AQUA_ROUTER,
      strategyHash: STRATEGY_HASH_V2,
      maker: AGENT,
      agent: AGENT,
      spendCapPerDayWei: BigInt(env.SPEND_CAP_PER_DAY_WEI || "1000000000000000000"),
      agentPk: env.AGENT_PK,
      zgApiKey: env.ZG_API_KEY,
      zgApiBase: env.ZG_API_BASE,
      fetchImpl: counted,
      fills,
      orderHashes: orderHashesOf(live),
      hook: V4_HOOK.address,
      liveOrder: SHIPPED_LIVE_ORDER,
      x402RevenueUsdc,
      funding: { ...DEFAULT_FUNDING_ENV, feeBps: FEE_BPS_V2, k: Number(env.FUNDING_K || DEFAULT_FUNDING_ENV.k), gasShareBps: Number(env.GAS_SHARE_BPS || DEFAULT_FUNDING_ENV.gasShareBps), gasTopUpBelowWei: BigInt(env.GAS_TOPUP_BELOW_WEI || DEFAULT_FUNDING_ENV.gasTopUpBelowWei), maxSpendWeiPerRun: BigInt(env.FUNDING_MAX_SPEND_WEI || DEFAULT_FUNDING_ENV.maxSpendWeiPerRun) },
      log: (line) => console.log(line),
    }));
  } catch (e) {
    let err = e as { message?: string; url?: string; status?: number; details?: string; shortMessage?: string; cause?: unknown };
    for (let c = err; c; c = c.cause as typeof err) if (c.url) { err = { ...c, shortMessage: (e as typeof err).shortMessage ?? c.shortMessage }; break; }
    // viem's first line is just "HTTP request failed."; the host, status and details say which hop broke. viem repeats the
    // full URL inside its message and details, so every URL in the line is reduced to its host before anything is written.
    const msg = hostsOnly([err.shortMessage ?? err.message?.split("\n")[0] ?? String(e), err.url && `url=${err.url}`, err.status && `status=${err.status}`, err.details && `details=${String(err.details).slice(0, 160)}`].filter(Boolean).join(" "));
    console.error(`tick failed: ${msg}`);
    const rec = { at: new Date().toISOString(), outcome: "error", error: msg };
    next = { ...prev, lastTick: rec, lastTicks: [...(prev.lastTicks ?? []), rec].slice(-12) };
  }
  const rpc = Object.keys(rpcFailures).length ? { rpcFailures } : {};
  if (next.lastTick) Object.assign(next.lastTick, { subrequests: counter.n }, rpc);
  if (next.lastTicks?.length) Object.assign(next.lastTicks[next.lastTicks.length - 1]!, { subrequests: counter.n }, rpc);
  // KV allows 1,000 writes a day on the free plan; a 5-minute cron writes only when something changed.
  if (fingerprint(next) !== fingerprint(prev)) await env.UPKEEP_KV.put("cron-state", JSON.stringify(next));
}
