import { describe, expect, test } from "bun:test";
import { BaseError, toFunctionSelector } from "viem";
import { formatAmount, parseTyped, toBaseUnits } from "./amounts";
import { USDC, W0G } from "./config";
import { ctaFor, type CtaInput } from "./cta";
import { describeStep, toMillis, txUrl } from "./funding";
import { buildLoop, loopSentence } from "./ledger";
import { clock, freshness, impliedPrice, latestByDirection, offMidPct, spreadPct } from "./quotes";
import { classifyFailure, classifyQuoteError } from "./revert";
import { statusSchema } from "./schema";
import { recordTier } from "./tier-history";

const sig = (n: string) => "0x" + n.repeat(64);
const quote = (tokenIn: string, tokenOut: string, rateE18: string, expiry: number, id = "aa") => ({ tokenIn, tokenOut, rateE18, expiry: String(expiry), inferenceId: sig(id), requestId: `req-${id}` });

const status = (over: Record<string, unknown> = {}) =>
  statusSchema.parse({
    agent: W0G, maker: USDC, chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: 2,
    quotes: [], budget: { tier: "NORMAL", model: "m", computeBalanceWei: "1000000000000000000", spentTodayWei: "0", spendCapPerDayWei: "1000000000000000000", reason: "normal" },
    fees: { accruedUsdc: "0", accruedW0g: "0" }, funding: [], inferences: [], order: { maker: W0G, traits: sig("1"), data: "0x" }, ...over,
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
    expect(loopSentence(buildLoop(status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" } }), []))).toContain("2.5 USDC");
    const tx = sig("b");
    const funded = status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" }, funding: [{ step: "deposit-payment-layer", txHash: tx, chainId: 16661, time: 1 }] });
    expect(loopSentence(buildLoop(funded, []))).toContain("No AI run has been paid yet");
    const paying = status({ fees: { accruedUsdc: "2500000", accruedW0g: "0" }, funding: funded.funding, inferences: [{ requestId: "r1", model: "m", costWei: "0", time: 2 }] });
    expect(loopSentence(buildLoop(paying, []))).toContain("1 AI run followed");
  });
  test("tier history appends only on change", () => {
    const a = recordTier([], "NORMAL", "normal", 1);
    expect(recordTier(a, "NORMAL", "normal", 2)).toBe(a);
    expect(recordTier(a, "LOW", "balance_low", 3).map((e) => e.tier)).toEqual(["NORMAL", "LOW"]);
  });
  test("status schema rejects a bad tier and a missing field", () => {
    expect(() => status({ budget: { tier: "BROKEN", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: "0", reason: "x" } })).toThrow();
    expect(() => status({ pair: undefined })).toThrow();
  });
});
