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

export const PRE_LEDGER_ROUTER_DEPOSIT_WEI = 500_000_000_000_000_000n; // 0xfad8772126b57f54fc503f643423038097175b67e6de886e019b7a59a32f6958: 0.5 0G after the first run's charge.
export type SpendLedger = { day: string; spentTodayWei: string; lastVaultWei: string; routerDepositWei: string; seeded?: boolean };
export const emptySpendLedger = (): SpendLedger => ({ day: "", spentTodayWei: "0", lastVaultWei: "", routerDepositWei: "0", seeded: true });
export function seedRouterDeposit(l: SpendLedger): SpendLedger {
  if (l.seeded) return l;
  const deposit = BigInt(l.routerDepositWei) + PRE_LEDGER_ROUTER_DEPOSIT_WEI - BigInt(l.spentTodayWei);
  return { ...l, seeded: true, routerDepositWei: (deposit > 0n ? deposit : 0n).toString() };
}
/** Spend is what the router billed (x_0g_trace.billing.total_cost in 0G wei), never the vault's movement: the router pulls
 *  working deposits from the Payment Layer vault in 0.5 0G lumps, and a pull moves funds into the router ledger, it does not spend them.
 *  Funds = vault + the router-ledger deposit, estimated as pulls seen minus charges billed. */
export function accountSpend(prev: SpendLedger, input: { nowMs: number; vaultWei: bigint; billedWei: bigint }): SpendLedger & { fundsWei: string } {
  if (input.vaultWei < 0n || input.billedWei < 0n) throw new RangeError("negative vault or billed amount");
  const day = new Date(input.nowMs).toISOString().slice(0, 10);
  const spent = (prev.day === day ? BigInt(prev.spentTodayWei) : 0n) + input.billedWei;
  const pulled = prev.lastVaultWei && BigInt(prev.lastVaultWei) > input.vaultWei ? BigInt(prev.lastVaultWei) - input.vaultWei : 0n;
  let deposit = BigInt(prev.routerDepositWei) + pulled - input.billedWei;
  if (deposit < 0n) deposit = 0n;
  return { day, spentTodayWei: spent.toString(), lastVaultWei: input.vaultWei.toString(), routerDepositWei: deposit.toString(), seeded: prev.seeded, fundsWei: (input.vaultWei + deposit).toString() };
}
