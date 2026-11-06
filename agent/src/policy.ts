import { decideBudget, DEFAULT_BUDGET_CONFIG, type BudgetConfig, type BudgetDecision, type BudgetInput, type BudgetTier } from "./budget.js";

export function directionalRates(price: bigint, spread: number) {
  const w0gToUsdc = price * 1_000_000n / 10n ** 18n * BigInt(10000 - spread) / 10000n;
  const usdcToW0g = 10n ** 48n * BigInt(10000 - spread) / (price * BigInt(10000));
  return { w0gToUsdc, usdcToW0g };
}
export async function thresholdTriggered(accrued: bigint, threshold: bigint) { if (accrued < 0n || threshold <= 0n) throw new RangeError("invalid funding threshold"); return accrued >= threshold; }
export function shouldRunInference(tier: BudgetTier, requote: boolean) { return (tier === "NORMAL" || tier === "LOW") && requote; }
export function tickPolicy(input: BudgetInput) { const decision = decideBudget(input); return { ...decision, shouldInfer: shouldRunInference(decision.tier, decision.requote) }; }

/** Below this much Base ETH the signer cannot be trusted to land both posts, so the agent stops posting. */
export const GAS_FLOOR_WEI = 30_000_000_000_000n;
/** A live quote this close to expiry is renewed even when the price has not moved, so the strategy never goes dark between price moves. */
export const EXPIRY_REQUOTE_WINDOW_SECONDS = 600;

export type CronDecision = BudgetDecision & { shouldInfer: boolean };
/** The budget policy plus the two guards a timer-driven tick needs: a Base gas floor and a requote before expiry. */
export function cronPolicy(input: BudgetInput & { gasWei: bigint; secondsToExpiry: number | null }, config: BudgetConfig = DEFAULT_BUDGET_CONFIG): CronDecision {
  const d = decideBudget(input, config);
  if (input.gasWei < GAS_FLOOR_WEI) return { ...d, tier: "PAUSED", model: null, allowInference: false, requote: false, retainLastQuote: false, postQuotes: false, spreadMultiplier: 0, spreadBps: null, reason: "gas_low", shouldInfer: false };
  const expiring = input.secondsToExpiry === null || input.secondsToExpiry <= EXPIRY_REQUOTE_WINDOW_SECONDS;
  const requote = d.requote || (expiring && d.allowInference);
  return { ...d, requote, shouldInfer: shouldRunInference(d.tier, requote) };
}
