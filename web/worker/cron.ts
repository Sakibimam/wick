// Workers cron trigger: one agent tick per run. Reads chain state, applies the agent's budget policy,
// and signs and posts both quotes only when policy says so and both secrets are set.
import { createPublicClient, fallback, http, type Address } from "viem";
import { base } from "viem/chains";
import { cronTick, emptyCronState, type CronState } from "../../agent/src/worker-tick";

type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type CronEnv = { UPKEEP_KV: Kv; AGENT_PK?: string; ZG_API_KEY?: string; ZG_API_BASE?: string; BASE_RPC_URL?: string; ZG_RPC_URL?: string; QUOTE_TTL_SECONDS?: string; SPEND_CAP_PER_DAY_WEI?: string };

const BOARD: Address = "0x309933CE439Da6A059593d73B8c82E8C8447C3F8";
const AGENT: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
// Base priority fees run near 0.001 gwei; viem's 1 gwei default would overpay by three orders of magnitude.
const chain = { ...base, fees: { maxPriorityFeePerGas: 1_000_000n } };

const fingerprint = (s: CronState) => JSON.stringify({ ...s, lastTick: s.lastTick?.outcome ?? null });

export async function runCron(env: CronEnv): Promise<void> {
  const baseRpcUrl = env.BASE_RPC_URL || "https://mainnet.base.org";
  // mainnet.base.org answers Cloudflare egress with 429, so reads, sends and receipts fall through three public Base RPCs.
  const baseUrls = [...new Set(["https://base-rpc.publicnode.com", baseRpcUrl, "https://base.drpc.org"])];
  const baseTransport = fallback(baseUrls.map((u) => http(u, { retryCount: 1 })));
  const prev = ((await env.UPKEEP_KV.get("cron-state", "json")) as CronState | null) ?? emptyCronState();
  let next: CronState;
  try {
    ({ state: next } = await cronTick(prev, {
      // Agent sources carry their own viem type identity; at runtime wrangler aliases both to one copy.
      base: createPublicClient({ chain, transport: baseTransport }) as never,
      zeroG: createPublicClient({ transport: http(env.ZG_RPC_URL || "https://evmrpc.0g.ai", { retryCount: 2 }) }) as never,
      chain: chain as never,
      baseRpcUrl,
      baseTransport: baseTransport as never,
      board: BOARD,
      maker: AGENT,
      agent: AGENT,
      spendCapPerDayWei: BigInt(env.SPEND_CAP_PER_DAY_WEI || "1000000000000000000"),
      ttlSeconds: Number(env.QUOTE_TTL_SECONDS || "3600"),
      agentPk: env.AGENT_PK,
      zgApiKey: env.ZG_API_KEY,
      zgApiBase: env.ZG_API_BASE,
      log: (line) => console.log(line),
    }));
  } catch (e) {
    let err = e as { message?: string; url?: string; status?: number; details?: string; shortMessage?: string; cause?: unknown };
    for (let c = err; c; c = c.cause as typeof err) if (c.url) { err = { ...c, shortMessage: (e as typeof err).shortMessage ?? c.shortMessage }; break; }
    // viem's first line is just "HTTP request failed."; the url, status and details say which hop broke.
    const msg = [err.shortMessage ?? err.message?.split("\n")[0] ?? String(e), err.url && `url=${err.url}`, err.status && `status=${err.status}`, err.details && `details=${String(err.details).slice(0, 160)}`].filter(Boolean).join(" ");
    console.error(`tick failed: ${msg}`);
    next = { ...prev, lastTick: { at: new Date().toISOString(), outcome: `error: ${msg}` } };
  }
  // KV allows 1,000 writes a day on the free plan; a 5-minute cron writes only when something changed.
  if (fingerprint(next) !== fingerprint(prev)) await env.UPKEEP_KV.put("cron-state", JSON.stringify(next));
}
