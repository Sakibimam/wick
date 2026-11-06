import { toMillis } from "./funding";
import type { Fill } from "./ledger";
import type { Direction, Priced } from "./quotes";
import type { AgentStatus, Inference } from "./schema";
import { TOKENS } from "./config";
import { fmt0g, fmtUsd } from "./format";

/** One AI run in both units: what it was billed in, and the other side at the pool mid. */
export type Run = { requestId: string; model: string | null; atMs: number | null; cost0g: number | null; costUsd: number | null; billedIn: "0g" | "usd" | null; raw: Inference };

export function normalizeRun(r: Inference, mid: number | null): Run {
  const atMs = toMillis(r.time);
  if (r.totalCost == null || (r.currency !== "0g" && r.currency !== "usd")) return { requestId: r.requestId, model: r.model, atMs, cost0g: null, costUsd: null, billedIn: null, raw: r };
  if (r.currency === "0g") {
    const cost0g = Number(r.totalCost) / 1e18;
    return { requestId: r.requestId, model: r.model, atMs, cost0g, costUsd: mid === null ? null : cost0g * mid, billedIn: "0g", raw: r };
  }
  const costUsd = Number(r.totalCost) / 1e6;
  return { requestId: r.requestId, model: r.model, atMs, cost0g: mid ? costUsd / mid : null, costUsd, billedIn: "usd", raw: r };
}

/** Every run, newest first. The single list every count and total on the site is taken from. */
export function runsOf(status: AgentStatus): Run[] {
  return status.inferences.map((r) => normalizeRun(r, status.mid)).sort((a, b) => (b.atMs ?? 0) - (a.atMs ?? 0));
}

/** What one AI decision costs in USD: the latest 0G-billed run at the pool mid, else the agent's own figure. Every "decisions funded" number on the site (hero, receipt, ledger, share card) divides by this. */
export function decisionCostUsd(status: AgentStatus): number | null {
  const last = lastPaidRun(status)?.costUsd;
  if (last) return last;
  const reported = status.economics?.inferenceCostUsd;
  return typeof reported === "number" && reported > 0 ? reported : null;
}

/** Nearest whole decision, so 78 per 1 USDC and 8 per 0.10 USDC agree; under one it keeps one significant figure. */
export const fmtDecisions = (n: number) => (n >= 1 ? String(Math.round(n)) : n.toPrecision(1));

/** The headline: AI decisions paid for by the maker fee on 1 USDC traded. */
export function decisionsPerUsdc(status: AgentStatus): number | null {
  return status.strategy ? decisionsFor(status.strategy.feeBps / 10_000, status) : null;
}

/** Decisions a fee of `feeUsd` pays for. */
export function decisionsFor(feeUsd: number, status: AgentStatus): number | null {
  const c = decisionCostUsd(status);
  return c ? feeUsd / c : null;
}

/** The demo fill: 0.10 USDC, or the live buy cap when the signed price allows less. Every "one swap" figure uses this size. */
export function presetUsdcUnits(status: AgentStatus, buy: Priced | null): bigint {
  const cap = fillCap("buy-w0g", status, buy)?.units ?? null;
  return cap !== null && cap > 0n && cap < 100_000n ? cap : 100_000n;
}

/** Fills of the demo size still needed for fees to cover everything spent on AI so far; 0 once covered. */
export function fillsToCover(econ: Economics, status: AgentStatus, presetUsdc: number): number | null {
  if (!status.strategy || econ.coverage === null) return null;
  const gap = econ.aiSpentUsd - econ.feesEarnedUsdc;
  return gap <= 0 ? 0 : Math.ceil(gap / ((presetUsdc * status.strategy.feeBps) / 10_000));
}

/** The latest run billed in 0G: the price of the agent's next decision. */
export const lastPaidRun = (status: AgentStatus): Run | null => runsOf(status).find((r) => r.billedIn === "0g" && r.costUsd !== null) ?? null;

export type Economics = {
  feesEarnedUsdc: number;
  aiSpentUsd: number;
  coverage: number | null;
  runsPaidByFees: number | null;
  fundingThresholdUsdc: number | null;
  breakEvenFillUsdcPerRun: number | null;
  runwayDays: number | null;
  lastRun: Run | null;
  /** Which fields came from the agent rather than from this page's arithmetic. */
  reported: Set<string>;
};

/** Loop economics: the agent's own figures where it reports them, otherwise derived from the same status document. */
export function economicsOf(status: AgentStatus): Economics {
  const mid = status.mid;
  const runs = runsOf(status);
  const last = lastPaidRun(status);
  const feesEarnedUsdc = Number(BigInt(feeUnits(status.fees.accruedUsdc, 6))) / 1e6 + (mid ? (Number(BigInt(feeUnits(status.fees.accruedW0g, 18))) / 1e18) * mid : 0);
  const aiSpentUsd = runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const feeRate = status.strategy && status.strategy.feeBps > 0 ? status.strategy.feeBps / 10_000 : null;
  const cap = Number(BigInt(status.budget.spendCapPerDayWei));
  const derived = {
    feesEarnedUsdc,
    aiSpentUsd,
    coverage: aiSpentUsd > 0 ? feesEarnedUsdc / aiSpentUsd : null,
    runsPaidByFees: last?.costUsd ? feesEarnedUsdc / last.costUsd : null,
    fundingThresholdUsdc: status.fundingThresholdUsdc ? Number(status.fundingThresholdUsdc) : null,
    breakEvenFillUsdcPerRun: last?.costUsd && feeRate ? last.costUsd / feeRate : null,
    runwayDays: cap > 0 ? Number(BigInt(status.budget.computeBalanceWei)) / cap : null,
  };
  const reported = new Set<string>();
  const out = { ...derived } as Record<string, number | null>;
  for (const [k, v] of Object.entries(status.economics ?? {})) {
    if (typeof v === "number" && Number.isFinite(v) && k in derived) { out[k] = v; reported.add(k); }
  }
  return { ...(out as typeof derived), lastRun: last, reported };
}

const feeUnits = (v: string, decimals: number) => (v.includes(".") ? BigInt(Math.round(Number(v) * 10 ** decimals)) : BigInt(v));

const isAgent = (status: AgentStatus, taker: string) => [status.agent, status.maker].some((a) => a.toLowerCase() === taker.toLowerCase());

/** The fee one fill paid, in USDC, and how many of the agent's decisions it buys at the last run's cost. */
export function fillEconomics(fill: Fill, status: AgentStatus): { feeUsdc: number | null; decisionsFunded: number | null; seed: boolean } {
  const feeUsdc = fill.feeUsdc ?? feeFromAmount(fill.amountIn, fill.tokenIn, status);
  const decisionsFunded = feeUsdc !== null ? decisionsFor(feeUsdc, status) : null;
  return { feeUsdc, decisionsFunded, seed: isAgent(status, fill.taker) };
}

/** Maker fee on an input amount, in USDC at the pool mid. */
export function feeFromAmount(amountIn: bigint, tokenIn: string, status: AgentStatus): number | null {
  if (!status.strategy) return null;
  const rate = status.strategy.feeBps / 10_000;
  if (tokenIn.toLowerCase() === TOKENS.USDC.address.toLowerCase()) return (Number(amountIn) / 1e6) * rate;
  return status.mid === null ? null : (Number(amountIn) / 1e18) * status.mid * rate;
}

/** Distinct wallets that have filled, and how many of them are not the agent itself. */
export function takersOf(status: AgentStatus, fills: Fill[]): { distinct: number; outside: number; seedFills: number } {
  const set = new Set(fills.map((f) => f.taker.toLowerCase()));
  const outsideSet = [...set].filter((t) => !isAgent(status, t));
  // The agent reports distinctTakers counting outside wallets only; the fills list is the source for the total.
  return { distinct: set.size, outside: Math.max(outsideSet.length, status.distinctTakers ?? 0), seedFills: fills.filter((f) => isAgent(status, f.taker)).length };
}

/**
 * Largest input the strategy can fill right now, from its live balances and the signed rate, with the maker fee
 * applied and a 0.5% margin for the rounding inside the router. Null when the strategy or price is unknown.
 */
export function maxFillIn(direction: Direction, status: AgentStatus, price: Priced | null): bigint | null {
  return fillCap(direction, status, price)?.units ?? null;
}

/** The same cap with the constraint that binds it: the agent's signed per-fill size, or the strategy's depth on the far side. */
export function fillCap(direction: Direction, status: AgentStatus, price: Priced | null): { units: bigint; by: "signed" | "depth" } | null {
  if (!status.strategy || !price) return null;
  const rate = BigInt(price.quote.rateE18);
  if (rate <= 0n) return null;
  const out = BigInt(direction === "buy-w0g" ? status.strategy.w0g : status.strategy.usdc);
  const keep = 10_000n - BigInt(status.strategy.feeBps);
  const byDepth = (out * 10n ** 18n * 10_000n * 995n) / (rate * keep * 1000n);
  const signed = price.quote.maxAmountIn ? BigInt(price.quote.maxAmountIn) : null;
  return signed !== null && signed > 0n && signed < byDepth ? { units: signed, by: "signed" } : { units: byDepth, by: "depth" };
}

/** A run's cost the same way everywhere: 0G first with the USD equivalent; a run the router billed in USD says so. */
export function runCost(r: Run): string {
  if (r.billedIn === "0g") return `${fmt0g(r.cost0g!)} 0G${r.costUsd !== null ? ` (${fmtUsd(r.costUsd)})` : ""}`;
  if (r.billedIn === "usd") return `${r.cost0g !== null ? `${fmt0g(r.cost0g)} 0G ` : ""}(${fmtUsd(r.costUsd!)}, billed in USD)`;
  return "cost not reported";
}

/** The agent keeps its last 50 runs (KEEP in agent/src/worker-tick.ts); until it has that many, the run list is every run since launch. */
export const RUN_HISTORY = 50;
export const spendWindow = (status: AgentStatus) => (status.inferences.length < RUN_HISTORY ? "since launch" : `over the last ${status.inferences.length} runs`);
