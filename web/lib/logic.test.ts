import { describe, expect, test } from "bun:test";
import { BaseError, toFunctionSelector } from "viem";
import { formatAmount, parseTyped, toBaseUnits } from "./amounts";
import { USDC, W0G } from "./config";
import { ctaFor, type CtaInput } from "./cta";
import { describeStep, toMillis, txUrl } from "./funding";
import { buildLoop, loopSentence } from "./ledger";
import { freshness, impliedPrice, latestByDirection, offMidPct, spreadPct } from "./quotes";
import { clock, countdown, fmt0g, fmtBlock, fmtPrice, fmtUnits, fmtUsdc, shortHash } from "./format";
import { classifyFailure, classifyQuoteError } from "./revert";
import { statusSchema } from "./schema";

const sig = (n: string) => "0x" + n.repeat(64);
const quote = (tokenIn: string, tokenOut: string, rateE18: string, expiry: number, id = "aa") => ({ tokenIn, tokenOut, rateE18, expiry: String(expiry), inferenceId: sig(id), requestId: `req-${id}` });

const status = (over: Record<string, unknown> = {}) =>
  statusSchema.parse({
    agent: W0G, maker: USDC, chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: 2,
    quotes: [], budget: { tier: "NORMAL", model: "m", computeBalanceWei: "1000000000000000000", spentTodayWei: "0", spendCapPerDayWei: "1000000000000000000", reason: "normal" },
    fees: { accruedUsdc: "0", accruedW0g: "0" }, funding: [], inferences: [], order: { maker: W0G, traits: sig("1"), data: "0x" },
    strategy: { hash: sig("f"), w0g: "0", usdc: "0", feeBps: 30 }, gasWei: "0", readAt: { baseBlock: "1", zeroGBlock: "1", logsThroughBlock: null }, lastTick: null, ...over,
  });

describe("quotes", () => {
  test("implied price follows contract semantics in both directions", () => {
    expect(impliedPrice("sell-w0g", 2_000_000n)).toBeCloseTo(2, 9);
    expect(impliedPrice("buy-w0g", 5n * 10n ** 29n)).toBeCloseTo(2, 9);
  });
  test("latest per direction is the greatest expiry and foreign pairs are ignored", () => {
    const got = latestByDirection([
      quote(W0G, USDC, "2000000", 100, "01"), quote(W0G, USDC, "3000000", 200, "02"), quote(W0G, USDC, "9000000", 150, "03"),
      quote(USDC, W0G, "5" + "0".repeat(29), 120, "04"), quote("0x" + "1".repeat(40), USDC, "1", 999, "05"),
    ]);
    expect(got["sell-w0g"]?.expiry).toBe(200);
    expect(got["sell-w0g"]?.priceUsdcPerW0g).toBeCloseTo(3, 9);
    expect(got["buy-w0g"]?.expiry).toBe(120);
  });
  test("freshness boundaries", () => {
    expect(freshness(1000, 1000)).toBe("expired");
    expect(freshness(1000, 999)).toBe("closing");
    expect(freshness(1000, 939)).toBe("fresh");
    expect(clock(272)).toBe("04:32");
    expect(clock(3725)).toBe("1:02:05");
  });
  test("spread and off-mid", () => {
    const g = latestByDirection([quote(W0G, USDC, "2000000", 9), quote(USDC, W0G, "5" + "0".repeat(29) , 9)]);
    expect(spreadPct(g["sell-w0g"], g["buy-w0g"])).toBeCloseTo(0, 6);
    expect(offMidPct(2.2, 2)).toBeCloseTo(10, 9);
    expect(offMidPct(2, null)).toBeNull();
  });
});

describe("amounts", () => {
  test("typed input rejects empty, partial, too many decimals and zero", () => {
    expect(parseTyped("", 6)).toBeNull();
    expect(parseTyped(".", 6)).toBeNull();
    expect(parseTyped("0", 6)).toBeNull();
    expect(parseTyped("1.1234567", 6)).toBeNull();
    expect(parseTyped("20.5", 6)).toBe(20_500_000n);
  });
  test("fee strings read as raw units or decimals", () => {
    expect(toBaseUnits("12340000", 6)).toBe(12_340_000n);
    expect(toBaseUnits("12.34", 6)).toBe(12_340_000n);
    expect(formatAmount(12_340_000n, 6)).toBe("12.34");
    expect(formatAmount(1234567_000000n, 6)).toBe("1,234,567");
  });
});

describe("failures", () => {
  const withData = (data: string) => new BaseError("The contract function \"swap\" reverted", { cause: Object.assign(new Error("exec reverted"), { data }) });
  test("StaleQuote selector means stale, other revert does not", () => {
    expect(classifyFailure(withData(toFunctionSelector("StaleQuote()")), false)).toBe("stale-quote");
    expect(classifyFailure(withData("0xdeadbeef"), false)).toBe("reverted");
    expect(classifyFailure(withData("0xdeadbeef"), true)).toBe("stale-quote");
    expect(classifyFailure(new Error("boom"), false)).toBe("unknown");
  });
  test("agent quote errors", () => {
    expect(classifyQuoteError("execution reverted: StaleQuote()")).toBe("stale-quote");
    expect(classifyQuoteError("rate limited")).toBe("other");
  });
});

describe("cta order", () => {
  const ok: CtaInput = { connected: true, chainId: 8453, baseChainId: 8453, hasPrice: true, priceExpired: false, amount: 5n, balance: 10n, quote: "ready", allowance: 10n, phase: "idle", sellSymbol: "USDC" };
  test.each<[Partial<CtaInput>, string]>([
    [{ connected: false }, "connect"], [{ chainId: 1 }, "switch"], [{ hasPrice: false }, "no-price"], [{ priceExpired: true }, "expired"],
    [{ amount: null }, "enter"], [{ amount: 11n }, "balance"], [{ quote: "loading" as const }, "quoting"], [{ quote: "stale" as const }, "stale"],
    [{ quote: "error" as const }, "quote-error"], [{ allowance: 1n }, "approve"], [{}, "swap"], [{ phase: "swapping" as const }, "busy"],
    [{ maxIn: 4n }, "depth"], [{ maxIn: 5n }, "swap"],
  ])("case", (over, kind) => expect(ctaFor({ ...ok, ...over }).kind).toBe(kind));
  test("only connect, switch, approve and swap are enabled", () => {
    expect(ctaFor({ ...ok, priceExpired: true }).enabled).toBe(false);
    expect(ctaFor({ ...ok }).enabled).toBe(true);
  });
});

describe("funding and ledger", () => {
  test("step ids map to stages and links", () => {
    expect(describeStep("swap-usdc-to-w0g").kind).toBe("swap");
    expect(describeStep("ccip-send-w0g").kind).toBe("bridge");
    expect(describeStep("withdraw-w0g-0g").kind).toBe("withdraw");
    expect(describeStep("deposit-payment-layer").kind).toBe("deposit");
    expect(describeStep("approve-usdc").kind).toBe("approve");
    expect(describeStep("lifi-gas-to-0g").kind).toBe("gas");
    expect(describeStep("lifi-approve-usdc").kind).toBe("approve");
    expect(describeStep("router-pull-vault").kind).toBe("charge");
    expect(txUrl(8453, "0xab")).toBe("https://basescan.org/tx/0xab");
    expect(txUrl(16661, "0xab")).toBe("https://chainscan.0g.ai/tx/0xab");
    expect(txUrl(1, "0xab")).toBeNull();
  });
  test("time forms", () => {
    expect(toMillis(1_700_000_000)).toBe(1_700_000_000_000);
    expect(toMillis("2026-11-05T10:00:00.000Z")).toBe(Date.parse("2026-11-05T10:00:00.000Z"));
    expect(toMillis("nope")).toBeNull();
  });
  test("loop sentence only claims what the rows show", () => {
    expect(loopSentence(buildLoop(status(), []))).toContain("nothing to trace");
    expect(loopSentence(buildLoop(status({ quotes: [quote(USDC, W0G, "1", 10), quote(W0G, USDC, "1", 10, "bb")] }), []))).toContain("signed 2 prices");
    expect(loopSentence(buildLoop(status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" } }), []))).toContain("2.50 USDC");
    const tx = sig("b");
    const funded = status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" }, funding: [{ step: "deposit-payment-layer", txHash: tx, chainId: 16661, time: 1 }] });
    expect(loopSentence(buildLoop(funded, []))).toContain("No AI run has been paid yet");
    const paying = status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" }, funding: funded.funding, inferences: [{ requestId: "r1", model: "m", currency: "0g", totalCost: "1", time: 2 }] });
    expect(loopSentence(buildLoop(paying, []))).toContain("billed 1 AI run against it");
  });
  test("status schema rejects a bad tier and a missing field", () => {
    expect(() => status({ budget: { tier: "BROKEN", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: "0", reason: "x" } })).toThrow();
    expect(() => status({ pair: undefined })).toThrow();
  });
});

import { DEFAULT_BUDGET_CONFIG } from "../../agent/src/budget";
import { MODEL_BY_TIER } from "../../agent/src/brain";
import { FUEL_LINES, fuseLeft, gaugePosition, heartbeat, hopEvidence, MODELS, priceLeg, swapPerRun, tierForBalance } from "./machine";
import { FUNDING_EVIDENCE } from "./evidence";

describe("machine", () => {
  test("fuel lines are the agent's own budget lines", () => {
    expect(FUEL_LINES.pauseWei).toBe(DEFAULT_BUDGET_CONFIG.pauseBalanceWei);
    expect(FUEL_LINES.criticalWei).toBe(DEFAULT_BUDGET_CONFIG.criticalBalanceWei);
    expect(FUEL_LINES.lowWei).toBe(DEFAULT_BUDGET_CONFIG.lowBalanceWei);
  });
  test("gauge is log scale from 0.01 to 10 0G, clamped", () => {
    expect(gaugePosition(10n ** 16n)).toBeCloseTo(0);
    expect(gaugePosition(10n ** 18n)).toBeCloseTo(2 / 3);
    expect(gaugePosition(10n ** 20n)).toBe(1);
    expect(gaugePosition(0n)).toBe(0);
  });
  test("each funding hop maps to its recorded transaction", () => {
    const hops = hopEvidence(FUNDING_EVIDENCE.map((f) => ({ ...f })));
    expect(hops.swap).toBeNull();
    expect(hops.bridge?.step).toBe("ccip-send-w0g");
    expect(hops.withdraw?.step).toBe("withdraw-w0g-0g");
    expect(hops.deposit?.step).toBe("deposit-payment-layer");
  });
  test("fuse drains with time and the leg opens when every price is expired", () => {
    expect(fuseLeft(1000, 100, 3600)).toBeCloseTo(0.25);
    expect(fuseLeft(1000, 2000, 3600)).toBe(0);
    const q = (tokenIn: string, tokenOut: string, expiry: number) => ({ tokenIn, tokenOut, rateE18: "153625", expiry: String(expiry), inferenceId: "0x01", requestId: null });
    const W = "0x23cd099eB438CcA50349EE2BC809196b1ae00861", U = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const status = { quotes: [q(W, U, 500), q(U, W, 500)] } as never;
    expect(priceLeg(status, 400).open).toBe(false);
    expect(priceLeg(status, 600).open).toBe(true);
  });
  test("heartbeat keeps only runs inside the window, oldest first", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    const beats = heartbeat([
      { requestId: "b", model: null, time: "2026-11-06T06:00:00Z" },
      { requestId: "a", model: null, time: "2026-11-05T13:00:00Z" },
      { requestId: "old", model: null, time: "2026-11-03T00:00:00Z" },
    ], now, 48 * 3600_000);
    expect(beats.map((b) => b.requestId)).toEqual(["a", "b"]);
    expect(beats[1]!.x).toBeCloseTo(42 / 48);
  });
  test("what-if tiers and models follow the agent's own lines and names", () => {
    expect(MODELS.NORMAL).toBe(MODEL_BY_TIER.NORMAL);
    expect(MODELS.LOW).toBe(MODEL_BY_TIER.LOW);
    expect(tierForBalance(FUEL_LINES.lowWei)).toBe("NORMAL");
    expect(tierForBalance(FUEL_LINES.lowWei - 1n)).toBe("LOW");
    expect(tierForBalance(FUEL_LINES.criticalWei - 1n)).toBe("CRITICAL");
    expect(tierForBalance(FUEL_LINES.pauseWei - 1n)).toBe("PAUSED");
  });
  test("break-even swap volume is the latest 0G-billed run cost at the mid over the fee", () => {
    const s = { mid: 0.1456, strategy: { hash: "0x", w0g: "0", usdc: "0", feeBps: 30 }, inferences: [
      { requestId: "old", model: null, currency: "0g", totalCost: "100000000000000000", time: "2026-11-05T00:00:00Z" },
      { requestId: "usd", model: null, currency: "usd", totalCost: "29", time: "2026-11-06T06:00:00Z" },
      { requestId: "new", model: null, currency: "0g", totalCost: "281198000000000", time: "2026-11-06T05:00:00Z" },
    ] } as never;
    expect(swapPerRun(s)!.usdc).toBeCloseTo((0.000281198 * 0.1456) / 0.003, 9);
    expect(swapPerRun({ ...(s as object), mid: null } as never)).toBeNull();
  });
});
