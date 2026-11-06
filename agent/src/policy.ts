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
/** A live quote this close to expiry is renewed even when the price has not moved, so the strategy never goes dark between price moves.
 *  One 5-minute cron period plus 60 s for the inference and the post to land: a quote skipped at 361 s still has 61 s at the next
 *  tick, and a steady 900 s quote is renewed every second tick (144 posts a day) instead of every tick (288). */
export const CRON_PERIOD_SECONDS = 300;
export const EXPIRY_REQUOTE_WINDOW_SECONDS = CRON_PERIOD_SECONDS + 60;

export type CronDecision = BudgetDecision & { shouldInfer: boolean };
/** The budget policy plus the two guards a timer-driven tick needs: a Base gas floor and a requote before expiry. */
export function cronPolicy(input: BudgetInput & { gasWei: bigint; secondsToExpiry: number | null }, config: BudgetConfig = DEFAULT_BUDGET_CONFIG): CronDecision {
  const d = decideBudget(input, config);
  if (input.gasWei < GAS_FLOOR_WEI) return { ...d, tier: "PAUSED", model: null, allowInference: false, requote: false, retainLastQuote: false, postQuotes: false, spreadMultiplier: 0, spreadBps: null, reason: "gas_low", shouldInfer: false };
  const expiring = input.secondsToExpiry === null || input.secondsToExpiry <= EXPIRY_REQUOTE_WINDOW_SECONDS;
  const requote = d.requote || (expiring && d.allowInference);
  return { ...d, requote, shouldInfer: shouldRunInference(d.tier, requote) };
}

/** Quote lifetimes the model may pick, near MAX_TTL: renewed at the first tick inside the requote window, each still has 240 s or more left when it is renewed. */
export const QUOTE_TTL_BAND = [840, 900] as const;
export const MAX_TTL_SECONDS = 900;
export const BAND_SAFE_BPS = 790;
export function tierSpreadBps(tier: BudgetTier, base = DEFAULT_BUDGET_CONFIG.baseSpreadBps): number { return base * ({ NORMAL: 1, LOW: 2, CRITICAL: 4, PAUSED: 4 } as const)[tier]; }
/** The model picks each side's distance from the TWAP; the budget tier sets a floor applied to each side on its own. */
export function postedHalfSpreads(bidHalfSpreadBps: number, askHalfSpreadBps: number, tier: BudgetTier): { bid: number; ask: number } { const floor = tierSpreadBps(tier); return { bid: Math.max(bidHalfSpreadBps, floor), ask: Math.max(askHalfSpreadBps, floor) }; }
export type ComposedPair = { rate01E18: bigint; rate10E18: bigint; maxIn0: bigint; maxIn1: bigint; deviation01Bps: number; deviation10Bps: number };
/** Both directions around the TWAP mid (USDC per W0G): the maker pays mid x (1 - bid) for W0G and sells it at mid x (1 + ask). Raw-unit rates for the v2 board. */
export function composeQuotes(p: { twapMid: number; bidHalfSpreadBps: number; askHalfSpreadBps: number; maxAmountInUsdc: number }): ComposedPair {
  if (!(p.twapMid > 0) || !Number.isFinite(p.twapMid) || ![p.bidHalfSpreadBps, p.askHalfSpreadBps].every((x) => Number.isInteger(x) && x >= 0) || !(p.maxAmountInUsdc > 0)) throw new RangeError("invalid pair inputs");
  const bid = p.twapMid * (1 - p.bidHalfSpreadBps / 10_000), ask = p.twapMid * (1 + p.askHalfSpreadBps / 10_000);
  const deviation01Bps = Math.abs(bid / p.twapMid - 1) * 10_000, deviation10Bps = Math.abs(p.twapMid / ask - 1) * 10_000;
  if (Math.max(deviation01Bps, deviation10Bps) > BAND_SAFE_BPS) throw new RangeError(`pair leaves the on-chain band: ${Math.max(deviation01Bps, deviation10Bps).toFixed(1)} bps`);
  return { rate01E18: BigInt(Math.round(bid * 1e6)), rate10E18: BigInt(Math.round(1e30 / ask)), maxIn0: BigInt(Math.floor(p.maxAmountInUsdc / p.twapMid * 1e18)), maxIn1: BigInt(Math.floor(p.maxAmountInUsdc * 1e6)), deviation01Bps, deviation10Bps };
}
/** Annualisation-free realized volatility: standard deviation of log returns between consecutive mids, in bps. */
export function realizedVolBps(mids: number[]): number {
  const r: number[] = []; for (let i = 1; i < mids.length; i++) if (mids[i]! > 0 && mids[i - 1]! > 0) r.push(Math.log(mids[i]! / mids[i - 1]!));
  if (r.length < 2) return 0;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1)) * 10_000;
}
