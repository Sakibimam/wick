import { CHEAP_MODEL, PRIMARY_MODEL } from "./brain.js";

export type BudgetTier = "NORMAL" | "LOW" | "CRITICAL" | "PAUSED";
export type BudgetConfig = { pauseBalanceWei: bigint; criticalBalanceWei: bigint; lowBalanceWei: bigint; criticalSpendRatioBps: number; lowSpendRatioBps: number; normalRequoteDeviationBps: number; lowRequoteDeviationBps: number; criticalQuoteMaxAgeMs: number; baseSpreadBps: number };
export const DEFAULT_BUDGET_CONFIG: BudgetConfig = { pauseBalanceWei: 50_000_000_000_000_000n, criticalBalanceWei: 100_000_000_000_000_000n, lowBalanceWei: 500_000_000_000_000_000n, criticalSpendRatioBps: 9000, lowSpendRatioBps: 7500, normalRequoteDeviationBps: 25, lowRequoteDeviationBps: 100, criticalQuoteMaxAgeMs: 120_000, baseSpreadBps: 30 };
export type BudgetInput = { computeBalanceWei: bigint; spendCapPerDayWei: bigint; spentTodayWei: bigint; priceDeviationBps: number; lastQuoteAgeMs: number | null };
export type BudgetDecision = { tier: BudgetTier; model: typeof PRIMARY_MODEL | typeof CHEAP_MODEL | null; allowInference: boolean; requote: boolean; retainLastQuote: boolean; postQuotes: boolean; baseSpreadBps: number; spreadMultiplier: number; spreadBps: number | null; reason: string };
export function decideBudget(i: BudgetInput, c = DEFAULT_BUDGET_CONFIG): BudgetDecision {
  const nums = [i.priceDeviationBps, ...(i.lastQuoteAgeMs === null ? [] : [i.lastQuoteAgeMs]), c.criticalSpendRatioBps, c.lowSpendRatioBps, c.normalRequoteDeviationBps, c.lowRequoteDeviationBps, c.criticalQuoteMaxAgeMs, c.baseSpreadBps];
  if ([i.computeBalanceWei, i.spendCapPerDayWei, i.spentTodayWei].some(x => x < 0n) || nums.some(x => !Number.isFinite(x) || x < 0) || c.baseSpreadBps <= 0 || c.normalRequoteDeviationBps > c.lowRequoteDeviationBps || !(c.pauseBalanceWei < c.criticalBalanceWei && c.criticalBalanceWei < c.lowBalanceWei) || c.lowSpendRatioBps > c.criticalSpendRatioBps || c.criticalSpendRatioBps > 10000) throw new RangeError("invalid budget input or config");
  const ratio = i.spendCapPerDayWei === 0n ? 10000 : Number(i.spentTodayWei * 10000n / i.spendCapPerDayWei);
  const base = c.baseSpreadBps;
  const out = (tier: BudgetTier, model: BudgetDecision["model"], mult: number, reason: string, requote: boolean, retain: boolean): BudgetDecision => ({ tier, model, allowInference: model !== null, requote, retainLastQuote: retain, postQuotes: tier !== "PAUSED" && (tier !== "CRITICAL" || retain), baseSpreadBps: base, spreadMultiplier: mult, spreadBps: tier === "PAUSED" ? null : base * mult, reason });
  if (i.spentTodayWei >= i.spendCapPerDayWei) return out("PAUSED", null, 0, "spend_cap_reached", false, false);
  if (i.computeBalanceWei < c.pauseBalanceWei) return out("PAUSED", null, 0, "balance_below_floor", false, false);
  if (i.computeBalanceWei < c.criticalBalanceWei || ratio >= c.criticalSpendRatioBps) { const retain = i.lastQuoteAgeMs !== null && i.lastQuoteAgeMs <= c.criticalQuoteMaxAgeMs; return out("CRITICAL", null, 4, i.computeBalanceWei < c.criticalBalanceWei ? "balance_critical" : "spend_critical", false, retain); }
  if (i.computeBalanceWei < c.lowBalanceWei || ratio >= c.lowSpendRatioBps) return out("LOW", CHEAP_MODEL, 2, i.computeBalanceWei < c.lowBalanceWei ? "balance_low" : "spend_low", i.lastQuoteAgeMs === null || i.priceDeviationBps >= c.lowRequoteDeviationBps, false);
  return out("NORMAL", PRIMARY_MODEL, 1, "normal", i.lastQuoteAgeMs === null || i.priceDeviationBps >= c.normalRequoteDeviationBps, false);
}
export function deviationBps(previousMid: number, currentMid: number): number { if (![previousMid, currentMid].every(x => Number.isFinite(x) && x > 0)) throw new RangeError("mids must be positive finite numbers"); return Math.abs(currentMid - previousMid) / previousMid * 10000; }
