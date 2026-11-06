// Workers cron trigger: one agent tick per run on the v2 board. Reads chain state, applies the agent's budget policy,
// and signs and posts the quote pair only when policy says so and both secrets are set.
import { createPublicClient, http, parseUnits, type Address } from "viem";
import { base } from "viem/chains";
import { cronTick, emptyCronState, DEFAULT_FUNDING_ENV, type CronState, type FillLite } from "../../agent/src/worker-tick";
import { AQUA_ROUTER } from "../lib/config";
import { BOARD_V2, FEE_BPS_V2, SHIPPED_LIVE_ORDER, STRATEGY_HASH_V2, V4_HOOK } from "./v2";
import type { LogIndex } from "./chain";
import { BASE_RPCS, baseFallback, type RpcFailures } from "./rpc";

type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type CronEnv = { UPKEEP_KV: Kv; AGENT_PK?: string; ZG_API_KEY?: string; ZG_API_BASE?: string; BASE_RPC_URL?: string; ZG_RPC_URL?: string; SPEND_CAP_PER_DAY_WEI?: string; FUNDING_K?: string; GAS_TOPUP_BELOW_WEI?: string; GAS_SHARE_BPS?: string; FUNDING_MAX_SPEND_WEI?: string; QUOTES_STATS_URL?: string };

const AGENT: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
// Base priority fees run near 0.001 gwei; viem's 1 gwei default would overpay by three orders of magnitude.
const chain = { ...base, fees: { maxPriorityFeePerGas: 1_000_000n } };
/** Workers on the free plan allow 50 subrequests per invocation; the tick stops sending when it nears this. */
export const SUBREQUEST_CAP = 50;

const fingerprint = (s: CronState) => JSON.stringify({ ...s, lastTick: s.lastTick?.outcome ?? null, lastTicks: (s.lastTicks ?? []).map((t) => t.outcome) });

/** Counts every outbound fetch of one invocation, so each tick reports how close it ran to the subrequest cap. */
export function countingFetch(inner: typeof fetch = fetch) {
  const counter = { n: 0 };
  const f = ((input: RequestInfo | URL, init?: RequestInit) => { counter.n++; if (counter.n > SUBREQUEST_CAP - 2) return Promise.reject(new Error(`subrequest budget spent (${counter.n})`)); return inner(input, init); }) as typeof fetch;
  return { fetch: f, counter };
}

export async function runCron(env: CronEnv): Promise<void> {
  // Two workers can share this KV during a rename; one without the signer secrets must not overwrite the signer's state.
  if (!env.AGENT_PK || !env.ZG_API_KEY) { console.log("secrets not set"); return; }
  const baseRpcUrl = BASE_RPCS[0]!;
  const { fetch: counted, counter } = countingFetch();
  // Endpoints proven from Cloudflare egress, in order; each costs a subrequest only when the one before it fails.
  const rpcFailures: RpcFailures = {};
  const baseTransport = baseFallback({ fetchFn: counted, failures: rpcFailures });
  const zeroGTransport = http(env.ZG_RPC_URL || "https://evmrpc.0g.ai", { retryCount: 1, batch: true, fetchFn: counted });
  const prev = ((await env.UPKEEP_KV.get("cron-state", "json")) as CronState | null) ?? emptyCronState();
  const [v1, v2] = await Promise.all([env.UPKEEP_KV.get("log-index", "json") as Promise<LogIndex | null>, env.UPKEEP_KV.get("log-index-v2", "json") as Promise<LogIndex | null>]);
  const fills: FillLite[] = [...(v1?.fills ?? []), ...(v2?.fills ?? [])].filter((f, i, a) => a.findIndex((g) => g.txHash === f.txHash && g.logIndex === f.logIndex) === i);
  // x402 quote revenue settles in USDC to the maker; the seller's stats name it, the funding machine spends only what the wallet holds above the strategy.
  const x402RevenueUsdc = await counted(env.QUOTES_STATS_URL || "https://wick-quotes.earn-shield-alerts.workers.dev/v1/stats", { signal: AbortSignal.timeout(4_000) })
    .then((r) => (r.ok ? r.json() : null)).then((j) => (j && /^\d+(\.\d{1,6})?$/.test(String((j as { revenueUsdc?: unknown }).revenueUsdc)) ? parseUnits(String((j as { revenueUsdc: string }).revenueUsdc), 6) : 0n)).catch(() => 0n);
  let next: CronState;
  try {
    ({ state: next } = await cronTick(prev, {
      // Agent sources carry their own viem type identity; at runtime wrangler aliases both to one copy.
      base: createPublicClient({ chain, transport: baseTransport, batch: { multicall: true }, pollingInterval: 2_000 }) as never,
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
      hook: V4_HOOK.address,
      liveOrder: SHIPPED_LIVE_ORDER,
      x402RevenueUsdc,
      funding: { ...DEFAULT_FUNDING_ENV, feeBps: FEE_BPS_V2, k: Number(env.FUNDING_K || DEFAULT_FUNDING_ENV.k), gasShareBps: Number(env.GAS_SHARE_BPS || DEFAULT_FUNDING_ENV.gasShareBps), gasTopUpBelowWei: BigInt(env.GAS_TOPUP_BELOW_WEI || DEFAULT_FUNDING_ENV.gasTopUpBelowWei), maxSpendWeiPerRun: BigInt(env.FUNDING_MAX_SPEND_WEI || DEFAULT_FUNDING_ENV.maxSpendWeiPerRun) },
      log: (line) => console.log(line),
    }));
  } catch (e) {
    let err = e as { message?: string; url?: string; status?: number; details?: string; shortMessage?: string; cause?: unknown };
    for (let c = err; c; c = c.cause as typeof err) if (c.url) { err = { ...c, shortMessage: (e as typeof err).shortMessage ?? c.shortMessage }; break; }
    // viem's first line is just "HTTP request failed."; the url, status and details say which hop broke.
    const msg = [err.shortMessage ?? err.message?.split("\n")[0] ?? String(e), err.url && `url=${err.url}`, err.status && `status=${err.status}`, err.details && `details=${String(err.details).slice(0, 160)}`].filter(Boolean).join(" ");
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
