import { decideBudget, DEFAULT_BUDGET_CONFIG, type BudgetConfig, type BudgetDecision, type BudgetInput, type BudgetTier } from "./budget.js";

export function directionalRates(price: bigint, spread: number) {
  const w0gToUsdc = price * 1_000_000n / 10n ** 18n * BigInt(10000 - spread) / 10000n;
  const usdcToW0g = 10n ** 48n * BigInt(10000 - spread) / (price * BigInt(10000));
  return { w0gToUsdc, usdcToW0g };
}
export async function thresholdTriggered(accrued: bigint, threshold: bigint) { if (accrued < 0n || threshold <= 0n) throw new RangeError("invalid funding threshold"); return accrued >= threshold; }
export function shouldRunInference(tier: BudgetTier, requote: boolean) { return (tier === "NORMAL" || tier === "LOW") && requote; }
export function tickPolicy(input: BudgetInput) { const decision = decideBudget(input); return { ...decision, shouldInfer: shouldRunInference(decision.tier, decision.requote) }; }

/** Base ETH the agent never spends below: the operator reserve (0.00009 ETH, a Uniswap v4 hook deploy plus headroom) with margin. */
export const GAS_FLOOR_WEI = 30_000_000_000_000n; // ~2 postPair txs of headroom; the hook-deploy reserve is spent
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

/** The cron fires every 5 minutes; a quote inside this window of its expiry is renewed. Every allowed TTL is longer, so a fresh quote is never born stale. */
export const QUOTE_TTL_BAND = [700, 900] as const;
export const MAX_TTL_SECONDS = 900;
export const BAND_SAFE_BPS = 790;
export function tierSpreadBps(tier: BudgetTier, base = DEFAULT_BUDGET_CONFIG.baseSpreadBps): number { return base * ({ NORMAL: 1, LOW: 2, CRITICAL: 4, PAUSED: 4 } as const)[tier]; }
/** Edge each side keeps over the TWAP after the skew moves the centre. */
export const MIN_EDGE_BPS = 5;
/** The model proposes a spread; the budget tier sets a floor, and the skew sets another: spread >= |skew| + MIN_EDGE_BPS keeps both
 *  sides on the maker's side of the TWAP, so a lean never turns into buying above or selling below the mid. */
export function postedSpreadBps(modelSpreadBps: number, tier: BudgetTier, skewBps = 0): number { return Math.max(modelSpreadBps, tierSpreadBps(tier), Math.abs(skewBps) + MIN_EDGE_BPS); }
export type ComposedPair = { rate01E18: bigint; rate10E18: bigint; maxIn0: bigint; maxIn1: bigint; deviation01Bps: number; deviation10Bps: number };
/** Both directions around the TWAP mid (USDC per W0G): skew moves the centre, spread widens each side. Raw-unit rates for the v2 board. */
export function composePair(p: { twapMid: number; spreadBps: number; skewBps: number; maxAmountInUsdc: number }): ComposedPair {
  if (!(p.twapMid > 0) || !Number.isFinite(p.twapMid) || !Number.isInteger(p.spreadBps) || p.spreadBps < 0 || !Number.isInteger(p.skewBps) || !(p.maxAmountInUsdc > 0)) throw new RangeError("invalid pair inputs");
  const centre = p.twapMid * (1 - p.skewBps / 10_000), s = p.spreadBps / 10_000;
  const sell = centre * (1 - s), buyBack = (1 - s) / centre;
  const deviation01Bps = Math.abs(sell / p.twapMid - 1) * 10_000, deviation10Bps = Math.abs(buyBack * p.twapMid - 1) * 10_000;
  if (Math.max(deviation01Bps, deviation10Bps) > BAND_SAFE_BPS) throw new RangeError(`pair leaves the on-chain band: ${Math.max(deviation01Bps, deviation10Bps).toFixed(1)} bps`);
  return { rate01E18: BigInt(Math.round(sell * 1e6)), rate10E18: BigInt(Math.round(buyBack * 1e30)), maxIn0: BigInt(Math.floor(p.maxAmountInUsdc / p.twapMid * 1e18)), maxIn1: BigInt(Math.floor(p.maxAmountInUsdc * 1e6)), deviation01Bps, deviation10Bps };
}
/** Annualisation-free realized volatility: standard deviation of log returns between consecutive mids, in bps. */
export function realizedVolBps(mids: number[]): number {
  const r: number[] = []; for (let i = 1; i < mids.length; i++) if (mids[i]! > 0 && mids[i - 1]! > 0) r.push(Math.log(mids[i]! / mids[i - 1]!));
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * 10_000;
}
