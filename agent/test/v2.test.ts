import { describe, expect, test } from "bun:test";
import { askDecision, BrainError, inventoryGoal, teeGate, validateDecision, type DecisionState } from "../src/brain.js";
import { accountSpend, decideBudget, DEFAULT_BUDGET_CONFIG, emptySpendLedger } from "../src/budget.js";
import { BAND_SAFE_BPS, composeQuotes, postedHalfSpreads, QUOTE_TTL_BAND, realizedVolBps, tierSpreadBps, EXPIRY_REQUOTE_WINDOW_SECONDS, MAX_TTL_SECONDS } from "../src/policy.js";
import { meanTick, midFromTick, spotTwapGapBps, MAX_SPOT_TWAP_GAP_BPS } from "../src/price.js";
import { accruedFees, earnedUsdcAndW0g, inferenceIdOf } from "../src/worker-tick.js";
import { decideFunding } from "../src/funding-machine.js";

const state: DecisionState = { twapMid: 0.1464, spotMid: 0.1464, recentMids: [0.146, 0.1464], realizedVolBps: 12, inventory: { w0g: 1.357, usdc: 0.0068, w0gValueShare: 0.97 }, recentFills: [], gas: { baseEth: 0.0002, gasPerRequoteUsd: 0.0009 }, runway: { vault0g: 2.34, runsLeft: 8600, days: 29.9 }, budgetTier: "NORMAL", tierSpreadBps: 30, maxAmountInUsdcCap: 0.2, inventoryGoal: inventoryGoal(0.97) };
const good = { bidHalfSpreadBps: 90, askHalfSpreadBps: 30, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "inventory 97% W0G: ask tight, bid wide" };
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
const noSleep = async () => {};
const fail = async (code: string, p: Promise<unknown>) => { try { await p; throw new Error("unexpected success"); } catch (e) { expect(e).toBeInstanceOf(BrainError); expect((e as BrainError).code).toBe(code as never); return e as BrainError; } };

describe("v2 decision", () => {
  test("a valid decision passes through with reason, skew, size, ttl and the TEE verdict; verify_tee is sent", async () => {
    const { f, seen } = router(good);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f });
    expect(r).toMatchObject({ ...good, requestId: "rid-1", teeVerified: true, provider: "0xf4FB", billing: { currency: "0g", totalCost: "272018666666666" } });
    expect(seen[0].verify_tee).toBe(true);
    expect(seen[0].model).toBe("0gm-1.0-35b-a3b-sia");
  });
  test("every field is range-checked on both sides", () => {
    const bad: [string, Partial<typeof good>][] = [["spread_out_of_range", { bidHalfSpreadBps: 4 }], ["spread_out_of_range", { bidHalfSpreadBps: 501 }], ["spread_out_of_range", { askHalfSpreadBps: 40.5 }], ["spread_out_of_range", { askHalfSpreadBps: 4 }], ["spread_out_of_range", { askHalfSpreadBps: 501 }], ["ttl_out_of_range", { ttlSeconds: 839 }], ["ttl_out_of_range", { ttlSeconds: 901 }], ["max_amount_out_of_range", { maxAmountInUsdc: 0 }], ["max_amount_out_of_range", { maxAmountInUsdc: 0.2001 }], ["reason_invalid", { reason: " " }], ["reason_invalid", { reason: "x".repeat(281) }]];
    for (const [code, patch] of bad) { try { validateDecision({ ...good, ...patch }, 0.2); throw new Error(`accepted ${JSON.stringify(patch)}`); } catch (e) { expect((e as BrainError).code).toBe(code as never); } }
    for (const edge of [{ bidHalfSpreadBps: 5, askHalfSpreadBps: 5 }, { bidHalfSpreadBps: 500 }, { askHalfSpreadBps: 5 }, { bidHalfSpreadBps: 500, askHalfSpreadBps: 500 }, { ttlSeconds: 840 }, { ttlSeconds: 900 }, { maxAmountInUsdc: 0.2 }]) expect(() => validateDecision({ ...good, ...edge }, 0.2)).not.toThrow();
    expect(() => validateDecision({ ...good, askHalfSpreadBps: "30" }, 0.2)).toThrow();
    const { askHalfSpreadBps: _, ...missing } = good; expect(() => validateDecision(missing, 0.2)).toThrow(/missing askHalfSpreadBps/);
    // The old signed-skew answer is not a decision any more.
    expect(() => validateDecision({ spreadBps: 40, skewBps: 60, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "old" }, 0.2)).toThrow(/missing bidHalfSpreadBps/);
  });
  test("a TeeML answer without tee_verified true is refused, and the refusal still carries the billed run", async () => {
    for (const verdict of [false, undefined]) {
      const trace: Record<string, unknown> = { request_id: "rid-2", provider: "0xf4FB", billing: { currency: "0g", total_cost: "5" } };
      if (verdict !== undefined) trace.tee_verified = verdict;
      const e = await fail("tee_unverified", askDecision(state, { apiKey: "x", fetchImpl: router(good, trace).f }));
      expect(e.run).toMatchObject({ requestId: "rid-2", billing: { totalCost: "5" } });
    }
    expect(teeGate("0gm-1.0-35b-a3b-sia", true)).toBe(true);
    expect(teeGate("0gm-1.0-35b-a3b-sia", null)).toBe(false);
    expect(teeGate("qwen3.7-flash", null)).toBe(true);
  });
  test("an invalid answer after billing keeps its run for spend accounting", async () => {
    const e = await fail("spread_out_of_range", askDecision(state, { apiKey: "x", fetchImpl: router({ ...good, bidHalfSpreadBps: 900 }).f }));
    expect(e.run?.requestId).toBe("rid-1");
  });
  test("one retry on a 502 or a dropped connection, none on a 4xx", async () => {
    const a = router(good, undefined, [502]); expect((await askDecision(state, { apiKey: "x", fetchImpl: a.f, sleep: noSleep })).attempts).toBe(2); expect(a.seen.length).toBe(2);
    const b = router(good, undefined, [-1]); expect((await askDecision(state, { apiKey: "x", fetchImpl: b.f, sleep: noSleep })).attempts).toBe(2);
    const c = router(good, undefined, [502, 502]); await fail("http_error", askDecision({ ...state, budgetTier: "LOW" }, { apiKey: "x", fetchImpl: c.f, sleep: noSleep })); expect(c.seen.length).toBe(2);
    const d = router(good, undefined, [400]); await fail("http_error", askDecision(state, { apiKey: "x", fetchImpl: d.f })); expect(d.seen.length).toBe(1);
  });
  test("a down TeeML provider falls back once to the standard model with tee_verified null, never faked", async () => {
    let calls = 0;
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body)); calls++;
      if (req.model === "0gm-1.0-35b-a3b-sia" || req.model === "0gm-1.0-35b-a3b") return new Response('{"error":{"type":"upstream_error"}}', { status: 502 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(good) } }], x_0g_trace: { request_id: "rid-q", billing: { currency: "0g", total_cost: "9" } } });
    }) as unknown as typeof fetch;
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f, sleep: noSleep });
    expect(r.model).toBe("qwen3.7-flash");
    expect(r.teeVerified).toBeNull();
    expect(r.fallbackFrom).toMatch(/0gm-1.0-35b-a3b: router returned HTTP 502/);
    expect(calls).toBe(5);
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
  test("property: each posted side never drops below the tier floor and never decreases as the tier degrades", () => {
    const order = ["NORMAL", "LOW", "CRITICAL"] as const;
    for (let bid = 5; bid <= 500; bid += 5) for (const ask of [5, 30, 77, 500]) {
      const s = order.map((t) => postedHalfSpreads(bid, ask, t));
      for (let i = 0; i < 3; i++) { expect(s[i]!.bid).toBeGreaterThanOrEqual(Math.max(bid, tierSpreadBps(order[i]!))); expect(s[i]!.ask).toBeGreaterThanOrEqual(Math.max(ask, tierSpreadBps(order[i]!))); }
      expect(s[0]!.bid <= s[1]!.bid && s[1]!.bid <= s[2]!.bid && s[0]!.ask <= s[1]!.ask && s[1]!.ask <= s[2]!.ask).toBe(true);
    }
    // the floor applies per side: a tight ask is lifted to the floor while a wide bid is kept as the model chose it
    expect(postedHalfSpreads(90, 10, "NORMAL")).toEqual({ bid: 90, ask: 30 });
    expect(postedHalfSpreads(10, 90, "LOW")).toEqual({ bid: 60, ask: 90 });
  });
  test("composed rates: bid below and ask above the TWAP by exactly each half-spread, inside the on-chain band", () => {
    const mid = 0.1464;
    const c = composeQuotes({ twapMid: mid, bidHalfSpreadBps: 90, askHalfSpreadBps: 30, maxAmountInUsdc: 0.05 });
    expect(c.rate01E18).toBe(BigInt(Math.round(mid * (1 - 0.009) * 1e6)));
    expect(c.rate10E18).toBe(BigInt(Math.round(1e30 / (mid * 1.003))));
    expect(c.maxIn1).toBe(50_000n);
    expect(c.deviation01Bps).toBeCloseTo(90, 6);
    // a W0G-heavy decision: ask tighter than bid lowers both prices against a symmetric quote
    const sym = composeQuotes({ twapMid: mid, bidHalfSpreadBps: 60, askHalfSpreadBps: 60, maxAmountInUsdc: 0.05 });
    expect(c.rate01E18 < sym.rate01E18 && c.rate10E18 > sym.rate10E18).toBe(true);
    for (const b of [5, 120, 500]) for (const a of [5, 120, 500]) { const q = composeQuotes({ twapMid: mid, bidHalfSpreadBps: b, askHalfSpreadBps: a, maxAmountInUsdc: 0.1 }); expect(Math.max(q.deviation01Bps, q.deviation10Bps)).toBeLessThanOrEqual(BAND_SAFE_BPS); }
    expect(() => composeQuotes({ twapMid: mid, bidHalfSpreadBps: 800, askHalfSpreadBps: 5, maxAmountInUsdc: 0.1 })).toThrow(/band/);
  });
  test("property: no allowed decision quotes the maker across the TWAP on either side", () => {
    const mid = 0.1464;
    for (const tier of ["NORMAL", "LOW", "CRITICAL"] as const) for (let b = 5; b <= 500; b += 15) for (const a of [5, 30, 65, 200, 500]) {
      const p = postedHalfSpreads(b, a, tier), c = composeQuotes({ twapMid: mid, bidHalfSpreadBps: p.bid, askHalfSpreadBps: p.ask, maxAmountInUsdc: 0.05 });
      expect(Number(c.rate01E18) < mid * 1e6).toBe(true);
      expect(Number(c.rate10E18) < 1e30 / mid).toBe(true);
    }
  });
  test("inventory goal is plain words naming which side to tighten, never a sign", () => {
    expect(inventoryGoal(0.967)).toBe("you hold 96.7% W0G by value: make W0G cheaper to buy from you, so set askHalfSpreadBps below bidHalfSpreadBps");
    expect(inventoryGoal(0.2)).toBe("you hold 20.0% W0G by value: make W0G dearer to buy from you and pay up to buy it back, so set bidHalfSpreadBps below askHalfSpreadBps");
    expect(inventoryGoal(0.5)).toBe("inventory is balanced at 50.0% W0G by value: keep the two half-spreads about equal");
    for (const g of [0.967, 0.2, 0.5].map(inventoryGoal)) expect(/skew|positive|negative|[+-]\d/.test(g)).toBe(false);
  });
  test("a lean toward the side the maker already holds too much of is rejected", () => {
    expect(() => validateDecision({ ...good, bidHalfSpreadBps: 30, askHalfSpreadBps: 90 }, 0.2, 0.967)).toThrow(/skew_against_inventory/);
    expect(() => validateDecision({ ...good, bidHalfSpreadBps: 90, askHalfSpreadBps: 30 }, 0.2, 0.2)).toThrow(/skew_against_inventory/);
    expect(() => validateDecision({ ...good, bidHalfSpreadBps: 90, askHalfSpreadBps: 30 }, 0.2, 0.967)).not.toThrow();
    expect(() => validateDecision({ ...good, bidHalfSpreadBps: 40, askHalfSpreadBps: 40 }, 0.2, 0.967)).not.toThrow();
    expect(() => validateDecision({ ...good, bidHalfSpreadBps: 30, askHalfSpreadBps: 50 }, 0.2, 0.5)).not.toThrow();
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
test("the gas floor keeps at least two postPair transactions of Base ETH in reserve", async () => {
  const { GAS_FLOOR_WEI } = await import("../src/policy.js");
  const { DEFAULT_FUNDING_ENV } = await import("../src/worker-tick.js");
  // one v2 postPair measured at 82,443 gas; at a 0.15 gwei worst case that is ~12,400 gwei, so 30,000 gwei covers two
  expect(GAS_FLOOR_WEI >= 2n * 82_443n * 150_000_000n).toBe(true);
  expect(DEFAULT_FUNDING_ENV.gasTopUpBelowWei > GAS_FLOOR_WEI).toBe(true);
});

describe("TeeML retry with backoff", () => {
  test("502 then 200 with tee_verified true: the TeeML model answers on the second try, after a backoff, verified", async () => {
    const waits: number[] = [];
    const a = router(good, undefined, [502]);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: a.f, sleep: async (ms) => void waits.push(ms) });
    expect([r.model, r.teeVerified, r.attempts, r.fallbackFrom]).toEqual(["0gm-1.0-35b-a3b-sia", true, 2, null]);
    expect(waits.length).toBe(1);
    expect(waits[0]!).toBeGreaterThanOrEqual(1_000);
  });
  test("two 502s then 200: still the TeeML model on the third attempt, with growing backoff, before any fallback", async () => {
    const waits: number[] = [];
    const a = router(good, undefined, [502, 502]);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: a.f, sleep: async (ms) => void waits.push(ms) });
    expect([r.model, r.teeVerified, r.attempts]).toEqual(["0gm-1.0-35b-a3b-sia", true, 3]);
    expect(a.seen.every((b) => b.model === "0gm-1.0-35b-a3b-sia")).toBe(true);
    expect(waits[1]! > waits[0]!).toBe(true);
  });
});
test("quote lifetimes sit near MAX_TTL: every allowed TTL outlives the next requote tick by at least four minutes", () => {
  expect(QUOTE_TTL_BAND[0] - EXPIRY_REQUOTE_WINDOW_SECONDS).toBeGreaterThanOrEqual(480);
  expect(() => validateDecision({ ...good, ttlSeconds: 760 }, 0.2)).toThrow(/ttl_out_of_range/);
});

describe("router trace is persisted per request", () => {
  test("tee_verified, provider and provider_identity from x_0g_trace reach the decision", async () => {
    const r = await askDecision(state, { apiKey: "x", fetchImpl: router(good, { request_id: "rid-p", tee_verified: true, provider: "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250", provider_identity: "anonymous1", billing: { currency: "0g", total_cost: "1" } }).f, sleep: noSleep });
    expect([r.teeVerified, r.provider, r.providerIdentity]).toEqual([true, "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250", "anonymous1"]);
  });
  test("a provider failure's own x_0g_trace names the provider in the fallback record", async () => {
    const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const req = JSON.parse(String(init?.body));
      if (req.model === "0gm-1.0-35b-a3b-sia" || req.model === "0gm-1.0-35b-a3b") return Response.json({ error: { type: "upstream_error" }, x_0g_trace: { request_id: "rid-bad", provider: "0xdead00000000000000000000000000000000beef" } }, { status: 502 });
      return Response.json({ choices: [{ message: { content: JSON.stringify(good) } }], x_0g_trace: { request_id: "rid-q", provider: "0xc0ffee0000000000000000000000000000000000", billing: { currency: "0g", total_cost: "9" } } });
    }) as unknown as typeof fetch;
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f, sleep: noSleep });
    expect(r.provider).toBe("0xc0ffee0000000000000000000000000000000000");
    expect(r.fallbackFrom).toContain("0xdead00000000000000000000000000000000beef");
    expect(r.fallbackFrom).toContain("rid-bad");
  });
});
