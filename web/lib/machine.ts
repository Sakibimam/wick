import { describeStep, toMillis, type StageKind } from "./funding";
import { freshness, latestByDirection, type Priced } from "./quotes";
import { reasonText } from "./tiers";
import { duration as ago } from "./format";
import type { AgentStatus, FundingStep, Inference, Tier } from "./schema";

/** The agent's budget lines, the same numbers as DEFAULT_BUDGET_CONFIG in agent/src/budget.ts (a test pins them). */
export const FUEL_LINES = {
  pauseWei: 50_000_000_000_000_000n,
  criticalWei: 100_000_000_000_000_000n,
  lowWei: 500_000_000_000_000_000n,
} as const;

/** Fuel gauge scale: log10 from 0.01 to 10 0G, so the three lines and a multi-0G balance all read apart. */
const LOG_MIN = -2;
const LOG_MAX = 1;
export function gaugePosition(wei: bigint): number {
  const v = Number(wei) / 1e18;
  if (v <= 0) return 0;
  return Math.min(1, Math.max(0, (Math.log10(v) - LOG_MIN) / (LOG_MAX - LOG_MIN)));
}

export type Tone = "ok" | "warn" | "danger" | "quiet";
export const TIER_TONE: Record<Tier, Tone> = { NORMAL: "ok", LOW: "warn", CRITICAL: "danger", PAUSED: "quiet" };

export type HopKey = "swap" | "bridge" | "withdraw" | "deposit";
export const HOPS: { key: HopKey; name: string; what: string; chainId: number }[] = [
  { key: "swap", name: "Uniswap", what: "Fees buy wrapped 0G.", chainId: 8453 },
  { key: "bridge", name: "CCIP bridge", what: "W0G crosses to the 0G chain.", chainId: 8453 },
  { key: "withdraw", name: "Unwrap", what: "W0G becomes native 0G.", chainId: 16661 },
  { key: "deposit", name: "Deposit", what: "0G lands in the account that pays for AI runs.", chainId: 16661 },
];

/** Latest recorded transaction for each of the four funding hops, by the agent's step ids. */
export function hopEvidence(funding: FundingStep[]): Record<HopKey, FundingStep | null> {
  const out: Record<HopKey, FundingStep | null> = { swap: null, bridge: null, withdraw: null, deposit: null };
  for (const step of funding) {
    const kind: StageKind = describeStep(step.step).kind;
    if (kind !== "swap" && kind !== "bridge" && kind !== "withdraw" && kind !== "deposit") continue;
    const prev = out[kind];
    if (!prev || (toMillis(step.time) ?? 0) >= (toMillis(prev.time) ?? 0)) out[kind] = step;
  }
  return out;
}

export type Beat = { requestId: string; atMs: number; model: string | null; x: number };

/** AI runs inside the window ending now, placed on 0..1. Runs older than the window are dropped. */
export function heartbeat(inferences: Inference[], nowMs: number, windowMs: number): Beat[] {
  const start = nowMs - windowMs;
  return inferences
    .map((r) => ({ r, at: toMillis(r.time) }))
    .filter((x): x is { r: Inference; at: number } => x.at !== null && x.at >= start && x.at <= nowMs)
    .sort((a, b) => a.at - b.at)
    .map(({ r, at }) => ({ requestId: r.requestId, atMs: at, model: r.model, x: (at - start) / windowMs }));
}


export type PriceLeg = { buy: Priced | null; sell: Priced | null; open: boolean; soonest: Priced | null };

/** The price leg of the loop. It is open (the pool refuses every fill) when no direction has a fresh signed price. */
export function priceLeg(status: AgentStatus, nowSeconds: number): PriceLeg {
  const p = latestByDirection(status.quotes);
  const live = [p["buy-w0g"], p["sell-w0g"]].filter((x): x is Priced => x !== null && freshness(x.expiry, nowSeconds) !== "expired");
  const soonest = live.sort((a, b) => a.expiry - b.expiry)[0] ?? null;
  return { buy: p["buy-w0g"], sell: p["sell-w0g"], open: live.length === 0, soonest };
}

/** Fraction of the fuse left: seconds to expiry over the signing TTL. */
export function fuseLeft(expiry: number, nowSeconds: number, ttlSeconds: number): number {
  if (ttlSeconds <= 0) return 0;
  return Math.min(1, Math.max(0, (expiry - nowSeconds) / ttlSeconds));
}


/** One sentence of what the machine is doing right now, built only from the status document and the chain clock. */
export function machineSentence(status: AgentStatus, leg: PriceLeg, nowSeconds: number): string {
  const { tier, reason } = status.budget;
  const newest = [leg.buy, leg.sell].filter((x): x is Priced => x !== null).sort((a, b) => b.expiry - a.expiry)[0];
  if (leg.open) {
    const last = newest ? `The last signed price expired ${ago((nowSeconds - newest.expiry) * 1000)} ago, so the pool refuses every swap.` : "No price has been signed yet, so the pool refuses every swap.";
    return tier === "NORMAL" ? `Signing a new price. ${last}` : `${TIER_WORD[tier]}. ${reasonText(reason)} ${last}`;
  }
  const left = ago(((leg.soonest?.expiry ?? nowSeconds) - nowSeconds) * 1000);
  return tier === "NORMAL" ? `Running. The signed price is good for ${left} more, and fills pay into the next AI run.` : `${TIER_WORD[tier]}. ${reasonText(reason)} The signed price is good for ${left} more.`;
}

const TIER_WORD: Record<Tier, string> = { NORMAL: "Running", LOW: "Running lean", CRITICAL: "Running on reserve", PAUSED: "Stopped" };
export const tierWord = (t: Tier) => TIER_WORD[t];

/** Models by tier, the same names as MODEL_BY_TIER in agent/src/brain.ts (a test pins them). */
export const MODELS: Record<Tier, string | null> = { NORMAL: "0gm-1.0-35b-a3b", LOW: "qwen3.7-flash", CRITICAL: null, PAUSED: null };

/** The tier a balance alone puts the agent in, by the agent's balance lines. Spend against the daily cap can lower it further. */
export function tierForBalance(wei: bigint): Tier {
  if (wei < FUEL_LINES.pauseWei) return "PAUSED";
  if (wei < FUEL_LINES.criticalWei) return "CRITICAL";
  if (wei < FUEL_LINES.lowWei) return "LOW";
  return "NORMAL";
}

/** USDC of swaps whose maker fee covers the agent's latest AI run billed in 0G, priced at the pool mid. Null without a 0G-billed run. */
export function swapPerRun(status: AgentStatus): { usdc: number; cost0g: number; costUsdc: number } | null {
  const run = [...status.inferences].filter((r) => r.currency === "0g" && r.totalCost).sort((a, b) => (toMillis(b.time) ?? 0) - (toMillis(a.time) ?? 0))[0];
  if (!run || status.mid === null || !status.strategy || status.strategy.feeBps === 0) return null;
  const cost0g = Number(run.totalCost) / 1e18;
  const costUsdc = cost0g * status.mid;
  return { usdc: costUsdc / (status.strategy.feeBps / 10_000), cost0g, costUsdc };
}

export type Tick = { at: string; outcome: string };
const failed = (t: Tick) => !(t.outcome === "hold" || t.outcome.startsWith("posted"));

/** The agent's last cron tick in plain words, and how many ticks in a row have failed (newest first in lastTicks). */
export function tickSummary(status: Pick<AgentStatus, "lastTick" | "lastTicks">): { at: number; words: string; failed: boolean; failStreak: number } | null {
  const ticks: Tick[] = status.lastTicks?.length ? [...status.lastTicks].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)) : status.lastTick ? [status.lastTick] : [];
  const last = ticks[0];
  if (!last) return null;
  let failStreak = 0;
  for (const t of ticks) { if (!failed(t)) break; failStreak++; }
  const o = last.outcome;
  const words = o === "hold" ? "held its price" : o.startsWith("posted") ? "signed a new price" : o.startsWith("error: ") ? `failed, ${o.slice(7)}` : o.startsWith("partial") ? "posted one side only" : o === "secrets_not_set" ? "is missing its keys" : o;
  return { at: Date.parse(last.at), words, failed: failed(last), failStreak };
}
