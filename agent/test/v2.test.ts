import { describe, expect, test } from "bun:test";
import { askDecision, BrainError, teeGate, validateDecision, type DecisionState } from "../src/brain.js";
import { accountSpend, decideBudget, DEFAULT_BUDGET_CONFIG, emptySpendLedger } from "../src/budget.js";
import { BAND_SAFE_BPS, composePair, postedSpreadBps, QUOTE_TTL_BAND, realizedVolBps, tierSpreadBps, EXPIRY_REQUOTE_WINDOW_SECONDS, MAX_TTL_SECONDS } from "../src/policy.js";
import { meanTick, midFromTick, spotTwapGapBps, MAX_SPOT_TWAP_GAP_BPS } from "../src/price.js";
import { accruedFees, earnedUsdcAndW0g, inferenceIdOf } from "../src/worker-tick.js";
import { decideFunding } from "../src/funding-machine.js";

const state: DecisionState = { twapMid: 0.1464, spotMid: 0.1464, recentMids: [0.146, 0.1464], realizedVolBps: 12, inventory: { w0g: 1.357, usdc: 0.0068, w0gValueShare: 0.97 }, recentFills: [], gas: { baseEth: 0.0002, gasPerRequoteUsd: 0.0009 }, runway: { vault0g: 2.34, runsLeft: 8600, days: 29.9 }, budgetTier: "NORMAL", tierSpreadBps: 30, maxAmountInUsdcCap: 0.2 };
const good = { spreadBps: 40, skewBps: 60, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "inventory 97% W0G: lean down 60 bps" };
function router(content: unknown, trace: Record<string, unknown> = { request_id: "rid-1", tee_verified: true, provider: "0xf4FB", billing: { currency: "0g", total_cost: "272018666666666" } }, statuses: number[] = []) {
  const seen: any[] = [];
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body)));
    const status = statuses.shift();
    if (status === -1) throw new TypeError("fetch failed");
    if (status && status >= 400) return new Response("bad gateway", { status });
    return Response.json({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], x_0g_trace: trace });
  }) as unknown as typeof fetch;
  return { f, seen };
}
const fail = async (code: string, p: Promise<unknown>) => { try { await p; throw new Error("unexpected success"); } catch (e) { expect(e).toBeInstanceOf(BrainError); expect((e as BrainError).code).toBe(code as never); return e as BrainError; } };

describe("v2 decision", () => {
  test("a valid decision passes through with reason, skew, size, ttl and the TEE verdict; verify_tee is sent", async () => {
    const { f, seen } = router(good);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f });
    expect(r).toMatchObject({ ...good, requestId: "rid-1", teeVerified: true, provider: "0xf4FB", billing: { currency: "0g", totalCost: "272018666666666" } });
    expect(seen[0].verify_tee).toBe(true);
    expect(seen[0].model).toBe("0gm-1.0-35b-a3b");
  });
  test("every field is range-checked on both sides", () => {
    const bad: [string, Partial<typeof good>][] = [["spread_out_of_range", { spreadBps: 4 }], ["spread_out_of_range", { spreadBps: 501 }], ["spread_out_of_range", { spreadBps: 40.5 }], ["skew_out_of_range", { skewBps: -201 }], ["skew_out_of_range", { skewBps: 201 }], ["ttl_out_of_range", { ttlSeconds: 699 }], ["ttl_out_of_range", { ttlSeconds: 901 }], ["max_amount_out_of_range", { maxAmountInUsdc: 0 }], ["max_amount_out_of_range", { maxAmountInUsdc: 0.2001 }], ["reason_invalid", { reason: " " }], ["reason_invalid", { reason: "x".repeat(281) }]];
    for (const [code, patch] of bad) { try { validateDecision({ ...good, ...patch }, 0.2); throw new Error(`accepted ${JSON.stringify(patch)}`); } catch (e) { expect((e as BrainError).code).toBe(code as never); } }
    for (const edge of [{ spreadBps: 5 }, { spreadBps: 500 }, { skewBps: -200 }, { skewBps: 200 }, { ttlSeconds: 700 }, { ttlSeconds: 900 }, { maxAmountInUsdc: 0.2 }]) expect(() => validateDecision({ ...good, ...edge }, 0.2)).not.toThrow();
    expect(() => validateDecision({ ...good, skewBps: "60" }, 0.2)).toThrow();
    const { skewBps: _, ...missing } = good; expect(() => validateDecision(missing, 0.2)).toThrow(/missing skewBps/);
  });
  test("a TeeML answer without tee_verified true is refused, and the refusal still carries the billed run", async () => {
    for (const verdict of [false, undefined]) {
      const trace: Record<string, unknown> = { request_id: "rid-2", provider: "0xf4FB", billing: { currency: "0g", total_cost: "5" } };
      if (verdict !== undefined) trace.tee_verified = verdict;
      const e = await fail("tee_unverified", askDecision(state, { apiKey: "x", fetchImpl: router(good, trace).f }));
      expect(e.run).toMatchObject({ requestId: "rid-2", billing: { totalCost: "5" } });
    }
    expect(teeGate("0gm-1.0-35b-a3b", true)).toBe(true);
    expect(teeGate("0gm-1.0-35b-a3b", null)).toBe(false);
    expect(teeGate("qwen3.7-flash", null)).toBe(true);
  });
  test("an invalid answer after billing keeps its run for spend accounting", async () => {
    const e = await fail("skew_out_of_range", askDecision(state, { apiKey: "x", fetchImpl: router({ ...good, skewBps: 900 }).f }));
    expect(e.run?.requestId).toBe("rid-1");
  });
  test("one retry on a 502 or a dropped connection, none on a 4xx", async () => {
    const a = router(good, undefined, [502]); expect((await askDecision(state, { apiKey: "x", fetchImpl: a.f })).attempts).toBe(2); expect(a.seen.length).toBe(2);
    const b = router(good, undefined, [-1]); expect((await askDecision(state, { apiKey: "x", fetchImpl: b.f })).attempts).toBe(2);
    const c = router(good, undefined, [502, 502]); await fail("http_error", askDecision({ ...state, budgetTier: "LOW" }, { apiKey: "x", fetchImpl: c.f })); expect(c.seen.length).toBe(2);
    const d = router(good, undefined, [400]); await fail("http_error", askDecision(state, { apiKey: "x", fetchImpl: d.f })); expect(d.seen.length).toBe(1);
  });
  test("a down TeeML provider falls back once to the standard model with tee_verified null, never faked", async () => {
    let calls = 0;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)); calls++;
      if (req.model === "0gm-1.0-35b-a3b") return new Response('{"error":{"type":"upstream_error"}}', { status: 502 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(good) } }], x_0g_trace: { request_id: "rid-q", billing: { currency: "0g", total_cost: "9" } } });
    }) as unknown as typeof fetch;
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f });
    expect(r.model).toBe("qwen3.7-flash");
    expect(r.teeVerified).toBeNull();
    expect(r.fallbackFrom).toMatch(/0gm-1.0-35b-a3b: router returned HTTP 502/);
    expect(calls).toBe(3);
    // A 4xx is the request's fault, not the provider's: no fallback.
    const g = (async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    await fail("http_error", askDecision(state, { apiKey: "x", fetchImpl: g }));
  });
  test("CRITICAL and PAUSED never call the router", async () => {
    const r = router(good);
    await fail("budget_critical", askDecision({ ...state, budgetTier: "CRITICAL" }, { apiKey: "x", fetchImpl: r.f }));
    await fail("budget_paused", askDecision({ ...state, budgetTier: "PAUSED" }, { apiKey: "x", fetchImpl: r.f }));
    expect(r.seen.length).toBe(0);
  });
});

describe("spread, skew and band", () => {
  test("property: the posted spread never decreases as the tier degrades", () => {
    const order = ["NORMAL", "LOW", "CRITICAL"] as const;
    for (let model = 5; model <= 500; model++) {
      const s = order.map((t) => postedSpreadBps(model, t));
      expect(s[0]! <= s[1]! && s[1]! <= s[2]!).toBe(true);
      expect(s[0]!).toBeGreaterThanOrEqual(model);
    }
    expect(postedSpreadBps(10, "LOW")).toBe(tierSpreadBps("LOW"));
    expect(postedSpreadBps(10, "CRITICAL")).toBe(120);
  });
  test("composed rates: skew lowers both prices, spread widens both, every allowed decision stays inside the on-chain band", () => {
    const mid = 0.1464;
    const flat = composePair({ twapMid: mid, spreadBps: 30, skewBps: 0, maxAmountInUsdc: 0.05 });
    const leaned = composePair({ twapMid: mid, spreadBps: 30, skewBps: 100, maxAmountInUsdc: 0.05 });
    expect(leaned.rate01E18 < flat.rate01E18).toBe(true);
    expect(leaned.rate10E18 > flat.rate10E18).toBe(true);
    expect(flat.rate01E18).toBe(BigInt(Math.round(mid * 0.997 * 1e6)));
    expect(flat.maxIn1).toBe(50_000n);
    for (const spreadBps of [5, 120, 500]) for (const skewBps of [-200, 0, 200]) { const c = composePair({ twapMid: mid, spreadBps, skewBps, maxAmountInUsdc: 0.1 }); expect(Math.max(c.deviation01Bps, c.deviation10Bps)).toBeLessThanOrEqual(BAND_SAFE_BPS); }
    expect(() => composePair({ twapMid: mid, spreadBps: 800, skewBps: 0, maxAmountInUsdc: 0.1 })).toThrow(/band/);
  });
  test("property: with the skew floor, no allowed decision quotes the maker across the TWAP", () => {
    const mid = 0.1464;
    for (const tier of ["NORMAL", "LOW", "CRITICAL"] as const) for (let skewBps = -200; skewBps <= 200; skewBps += 5) for (const model of [5, 30, 65, 200, 500]) {
      const c = composePair({ twapMid: mid, spreadBps: postedSpreadBps(model, tier, skewBps), skewBps, maxAmountInUsdc: 0.05 });
      expect(Number(c.rate01E18) < mid * 1e6).toBe(true);
      expect(Number(c.rate10E18) < 1e30 / mid).toBe(true);
    }
    // The live 08:30 decision (skew -150, spread 65) bought W0G 0.96% above the TWAP before this floor.
    expect(postedSpreadBps(65, "NORMAL", -150)).toBe(155);
  });
  test("a skew leaning toward the side the maker already holds too much of is rejected", () => {
    expect(() => validateDecision({ ...good, skewBps: -150 }, 0.2, 0.967)).toThrow(/skew_against_inventory/);
    expect(() => validateDecision({ ...good, skewBps: 80 }, 0.2, 0.2)).toThrow(/skew_against_inventory/);
    expect(() => validateDecision({ ...good, skewBps: 60 }, 0.2, 0.967)).not.toThrow();
    expect(() => validateDecision({ ...good, skewBps: -20 }, 0.2, 0.5)).not.toThrow();
  });
  test("TTL band sits wholly above the requote window and at or below the board's MAX_TTL", () => {
    expect(QUOTE_TTL_BAND[0]).toBeGreaterThan(EXPIRY_REQUOTE_WINDOW_SECONDS);
    expect(QUOTE_TTL_BAND[1]).toBe(MAX_TTL_SECONDS);
  });
  test("realized volatility of a flat tape is zero and grows with moves", () => {
    expect(realizedVolBps([1, 1, 1, 1])).toBe(0);
    expect(realizedVolBps([1, 1.01, 0.99, 1.02])).toBeGreaterThan(100);
  });
});

describe("TWAP", () => {
  test("mean tick rounds toward negative infinity like the extruction", () => {
    expect(meanTick([0n, -1n], 600)).toBe(-1);
    expect(meanTick([0n, -600n * 295490n], 600)).toBe(-295490);
    expect(meanTick([0n, 599n], 600)).toBe(0);
  });
  test("tick -295490 is about 0.1471 USDC per W0G (1.0001^tick x 1e12)", () => { expect(midFromTick(-295490)).toBeCloseTo(0.14712, 4); });
  test("a manipulated slot0 2% above the TWAP exceeds the 150 bps hold gap; 1% does not", () => {
    expect(spotTwapGapBps(0.1464 * 1.02, 0.1464)).toBeGreaterThan(MAX_SPOT_TWAP_GAP_BPS);
    expect(spotTwapGapBps(0.1464 * 1.01, 0.1464)).toBeLessThan(MAX_SPOT_TWAP_GAP_BPS);
  });
});

describe("spend accounting", () => {
  test("a 0.5 0G router pull with a tiny billed run is not spend and trips neither LOW nor PAUSED", () => {
    const cap = 10n ** 18n, half = 5n * 10n ** 17n, billed = 272_018_666_666_666n;
    let l = accountSpend(emptySpendLedger(), { nowMs: Date.parse("2026-11-06T08:00:00Z"), vaultWei: 2_343_959_530_558_679_712n, billedWei: 0n });
    l = accountSpend(l, { nowMs: Date.parse("2026-11-06T08:05:00Z"), vaultWei: 2_343_959_530_558_679_712n - half, billedWei: billed });
    l = accountSpend(l, { nowMs: Date.parse("2026-11-06T08:10:00Z"), vaultWei: 2_343_959_530_558_679_712n - 2n * half, billedWei: billed });
    expect(BigInt(l.spentTodayWei)).toBe(2n * billed);
    expect(BigInt(l.fundsWei)).toBe(2_343_959_530_558_679_712n - 2n * billed);
    const d = decideBudget({ computeBalanceWei: BigInt(l.fundsWei), spendCapPerDayWei: cap, spentTodayWei: BigInt(l.spentTodayWei), priceDeviationBps: 0, lastQuoteAgeMs: null });
    expect(d.tier).toBe("NORMAL");
  });
  test("billed spend resets at the UTC day boundary and the router deposit never goes negative", () => {
    let l = accountSpend(emptySpendLedger(), { nowMs: Date.parse("2026-11-06T23:59:00Z"), vaultWei: 10n, billedWei: 7n });
    expect(l.spentTodayWei).toBe("7"); expect(l.routerDepositWei).toBe("0");
    l = accountSpend(l, { nowMs: Date.parse("2026-11-07T00:01:00Z"), vaultWei: 10n, billedWei: 1n });
    expect(l.spentTodayWei).toBe("1");
  });
  test("the cap still pauses on real billed spend", () => {
    const d = decideBudget({ computeBalanceWei: 2n * 10n ** 18n, spendCapPerDayWei: 10n ** 18n, spentTodayWei: 10n ** 18n, priceDeviationBps: 0, lastQuoteAgeMs: null }, DEFAULT_BUDGET_CONFIG);
    expect(d.tier).toBe("PAUSED");
  });
});

describe("tick helpers", () => {
  test("fees accrue per input token at feeBps", () => {
    const f = accruedFees([{ taker: "0x1", tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x2", amountIn: "100000", amountOut: "1", timeMs: 1 }, { taker: "0x1", tokenIn: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", tokenOut: "0x2", amountIn: "1000000000000000000", amountOut: "1", timeMs: 1 }] as never, 30);
    expect(f).toEqual({ usdc: 300n, w0g: 3_000_000_000_000_000n });
  });
  test("inferenceId binds request id, provider and TEE verdict", () => {
    const a = inferenceIdOf({ requestId: "r", provider: "p", teeVerified: true });
    expect(inferenceIdOf({ requestId: "r", provider: "p", teeVerified: false })).not.toBe(a);
    expect(inferenceIdOf({ requestId: "r", provider: "q", teeVerified: true })).not.toBe(a);
    expect(inferenceIdOf({ requestId: "r", provider: "p", teeVerified: true })).toBe(a);
  });
});
test("the brain's TTL bounds are the policy's TTL band", async () => {
  const { DECISION_BOUNDS } = await import("../src/brain.js");
  expect([...DECISION_BOUNDS.ttlSeconds]).toEqual([...QUOTE_TTL_BAND]);
});

describe("x402 revenue joins the funding leg, earned-only", () => {
  const base = { funded: { usdc: 0n, w0g: 0n }, strategy: { usdc: 6_836n, w0g: 1_357_492_788_767_429_240n }, mid: 0.1464, ethUsd: 2200, ccipFeeWei: 110_000_000_000_000n, baseGasPriceWei: 6_000_000n, zeroGGasUsdc: 0.002, k: 3, gasTopUpBelowWei: 100_000_000_000_000n, gasShareBps: 5_000, maxSpendWeiPerRun: 300_000_000_000_000n };
  const wallet = (usdc: bigint) => ({ usdc, w0g: 1_582_956_025_258_468_432n, ethWei: 500_000_000_000_000n });
  test("x402 revenue held above the strategy commitment funds a run that swap fees alone could not", () => {
    const rev = 1_000_000n;
    const without = decideFunding({ ...base, accrued: earnedUsdcAndW0g([], 30, 0n), wallet: wallet(6_836n + rev) });
    const withRev = decideFunding({ ...base, accrued: earnedUsdcAndW0g([], 30, rev), wallet: wallet(6_836n + rev) });
    expect(without.fire).toBe(false);
    expect(withRev.fire).toBe(true);
    expect(withRev.kind).toBe("fuel");
  });
  test("revenue the stats claim but the wallet does not hold above the commitment is never spent", () => {
    const d = decideFunding({ ...base, accrued: earnedUsdcAndW0g([], 30, 1_000_000n), wallet: wallet(6_836n) });
    expect(d.fire).toBe(false);
    expect(d.spendableUsdc).toBe("0");
  });
});
test("the cron never spends Base ETH below the operator's 0.00009 ETH reserve", async () => {
  const { GAS_FLOOR_WEI } = await import("../src/policy.js");
  const { DEFAULT_FUNDING_ENV } = await import("../src/worker-tick.js");
  expect(GAS_FLOOR_WEI >= 90_000_000_000_000n).toBe(true);
  expect(DEFAULT_FUNDING_ENV.gasTopUpBelowWei >= 90_000_000_000_000n).toBe(true);
});
