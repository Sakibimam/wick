import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_ICON, CHAIN_NAMES, PROTOCOL_ICON, TOKEN_ICON, TOKENS, USDC, W0G } from "./config";
import { cluster } from "./cluster";
import { decisionsFor, economicsOf, fillEconomics, fmtDecisions, maxFillIn, runCost, runsOf, takersOf } from "./economics";
import { clock, countdown, fmt0g, fmtBlock, fmtPct, fmtPrice, fmtUnits, fmtUsdc, shortHash } from "./format";
import { tickSummary } from "./machine";
import { latestByDirection } from "./quotes";
import { statusSchema } from "./schema";

const PUBLIC = join(import.meta.dir, "..", "public");

describe("every token and chain has its mark on disk", () => {
  test("token symbols", () => {
    const symbols = [...Object.keys(TOKENS), "0G"] as (keyof typeof TOKEN_ICON)[];
    expect(symbols.length).toBeGreaterThan(2);
    for (const s of symbols) expect(existsSync(join(PUBLIC, TOKEN_ICON[s]))).toBe(true);
  });
  test("chains and protocols", () => {
    const chains = Object.keys(CHAIN_NAMES).map(Number);
    expect(chains.length).toBe(2);
    for (const c of chains) expect(CHAIN_ICON[c] && existsSync(join(PUBLIC, CHAIN_ICON[c]!))).toBe(true);
    for (const p of Object.values(PROTOCOL_ICON)) expect(existsSync(join(PUBLIC, p))).toBe(true);
  });
});

describe("one formatter", () => {
  test("USDC is 2dp, significant figures under a cent, zero is 0.00", () => {
    expect(fmtUsdc(0)).toBe("0.00");
    expect(fmtUsdc(0.6)).toBe("0.60");
    expect(fmtUsdc(1234.5)).toBe("1,234.50");
    expect(fmtUsdc(0.0003)).toBe("0.00030");
    expect(fmtUsdc(0.00004002)).toBe("0.000040");
    expect(fmtUnits(300n, "USDC")).toBe("0.00030");
  });
  test("0G and W0G are 4 significant figures", () => {
    expect(fmt0g(2.343959530558679)).toBe("2.344");
    expect(fmt0g(0.000272018666666666)).toBe("0.0002720");
    expect(fmt0g(1357.49)).toBe("1,357");
    expect(fmt0g(0)).toBe("0.00");
    expect(fmtUnits(1357492788767429240n, "W0G")).toBe("1.357");
    expect(fmtPrice(0.14736)).toBe("0.1474");
  });
  test("blocks group, hashes truncate one way, one countdown notation", () => {
    expect(fmtBlock("53794497")).toBe("53,794,497");
    expect(shortHash("0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1")).toBe("0x62f8…c7a1");
    expect(shortHash("65073141-8324-44a8-b819-c0f421c55ff8")).toBe("6507…5ff8");
    expect(clock(272)).toBe("04:32");
    expect(countdown(1450)).toBe("expires in 24:10");
    expect(countdown(-120)).toBe("expired 2 min ago");
    expect(fmtPct(197.3)).toBe("197%");
  });
});

const sig = (n: string) => "0x" + n.repeat(64);
const live = statusSchema.parse({
  agent: "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953", maker: "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953", chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: 0.1471305466313863,
  quotes: [
    { tokenIn: USDC, tokenOut: W0G, rateE18: "6785728668511460271604626195821", expiry: "1793950826", inferenceId: sig("a"), requestId: "r3", postedTx: sig("1") },
    { tokenIn: W0G, tokenOut: USDC, rateE18: "145897", expiry: "1793950826", inferenceId: sig("b"), requestId: "r3", postedTx: sig("2") },
  ],
  budget: { tier: "NORMAL", model: "m", computeBalanceWei: "2343959530558679712", spentTodayWei: "0", spendCapPerDayWei: "1000000000000000000", reason: "normal" },
  fees: { accruedUsdc: "300", accruedW0g: "0" }, funding: [],
  inferences: [
    { requestId: "r0", model: "m", currency: "usd", totalCost: "29", time: "2026-11-05T06:35:33Z" },
    { requestId: "r3", model: "m", currency: "0g", totalCost: "272018666666666", time: "2026-11-06T06:40:29.869Z" },
  ],
  order: { maker: W0G, traits: sig("1"), data: "0x" }, fundingThresholdUsdc: "10", quoteTtlSeconds: 3600,
  strategy: { hash: sig("f"), w0g: "1357492788767429240", usdc: "600000", feeBps: 30 },
  lastTick: { at: "2026-11-06T07:10:27.502Z", outcome: "error: router returned HTTP 502" },
});

describe("economics", () => {
  test("derived coverage, runs and break-even come from the same runs list", () => {
    const e = economicsOf(live);
    const lastUsd = 0.000272018666666666 * live.mid!;
    expect(e.feesEarnedUsdc).toBeCloseTo(0.0003, 9);
    expect(e.aiSpentUsd).toBeCloseTo(lastUsd + 0.000029, 9);
    expect(e.coverage!).toBeCloseTo(0.0003 / (lastUsd + 0.000029), 6);
    expect(e.runsPaidByFees!).toBeCloseTo(0.0003 / lastUsd, 6);
    expect(e.breakEvenFillUsdcPerRun!).toBeCloseTo(lastUsd / 0.003, 9);
    expect(e.reported.size).toBe(0);
  });
  test("an agent-reported figure wins and a malformed block is dropped, not fatal", () => {
    expect(economicsOf({ ...live, economics: { coverage: 2.5 } }).coverage).toBe(2.5);
    const odd = statusSchema.parse({ ...live, economics: "soon", distinctTakers: -1 });
    expect(odd.economics).toBeUndefined();
    expect(odd.distinctTakers).toBeUndefined();
  });
  test("a USD-billed run is tagged and still shows its 0G equivalent", () => {
    const [newest, legacy] = runsOf(live);
    expect(runCost(newest!)).toBe("0.0002720 0G ($0.000040)");
    expect(runCost(legacy!)).toBe("0.0001971 0G ($0.000029, billed in USD)");
  });
  test("max fill is bounded by what the strategy holds on the far side", () => {
    const p = latestByDirection(live.quotes);
    const buy = maxFillIn("buy-w0g", live, p["buy-w0g"])!;
    const outAtMax = (buy * 6785728668511460271604626195821n * 9970n) / (10n ** 18n * 10_000n);
    expect(outAtMax).toBeLessThanOrEqual(1357492788767429240n);
    expect(outAtMax).toBeGreaterThan(1357492788767429240n * 99n / 100n);
    expect(buy).toBeLessThan(100_000_000n);
    const sell = maxFillIn("sell-w0g", live, p["sell-w0g"])!;
    expect((sell * 145897n * 9970n) / (10n ** 18n * 10_000n)).toBeLessThanOrEqual(600000n);
  });
  test("every decisions figure divides by one cost and rounds one way", () => {
    expect(fmtDecisions(9.74)).toBe("9");
    expect(fmtDecisions(0.42)).toBe("0.4");
    const reported = { ...live, economics: { inferenceCostUsd: 0.00003 } };
    const fill = { txHash: sig("c"), blockNumber: 1n, timeMs: 1, taker: live.agent, tokenIn: USDC, tokenOut: W0G, amountIn: 100000n, amountOut: 1n, decisionsFunded: 99 };
    expect(fillEconomics(fill, reported).decisionsFunded).toBeCloseTo(decisionsFor(0.0003, reported)!, 9);
    expect(decisionsFor(0.0003, reported)).toBeCloseTo(10, 9);
  });
  test("the agent's own fill is a seed, not an outside taker", () => {
    const fill = (taker: string) => ({ txHash: sig("c"), blockNumber: 1n, timeMs: 1, taker, tokenIn: USDC, tokenOut: W0G, amountIn: 100000n, amountOut: 1n });
    const t = takersOf(live, [fill(live.agent), fill("0x1111111111111111111111111111111111111111")]);
    expect(t).toEqual({ distinct: 2, outside: 1, seedFills: 1 });
  });
});

describe("clusters and ticks", () => {
  test("close points merge, far points stay apart", () => {
    const g = cluster([0.1, 0.9, 0.11, 0.5, 0.12], (x) => x, 0.03);
    expect(g.map((c) => c.items.length)).toEqual([3, 1, 1]);
  });
  test("tick streak goes amber only after two failures in a row", () => {
    expect(tickSummary(live)!.failStreak).toBe(1);
    expect(tickSummary(live)!.words).toBe("retrying");
    const two = { lastTicks: [{ at: "2026-11-06T07:10:00Z", outcome: "error: a" }, { at: "2026-11-06T07:05:00Z", outcome: "error: b" }, { at: "2026-11-06T07:00:00Z", outcome: "hold" }] };
    expect(tickSummary(two)!.failStreak).toBe(2);
    expect(tickSummary({ lastTicks: [{ at: "2026-11-06T07:10:00Z", outcome: "posted r" }] })!.failed).toBe(false);
    expect(tickSummary({ lastTick: { at: "2026-11-06T07:10:00Z", outcome: "refused http_error; funding hold no_fees" } })!.words).toBe("retrying");
  });
});

import { BaseError, encodeErrorResult, parseAbi } from "viem";
import { classifyFailure, classifyQuoteError } from "./revert";
describe("v2 refusals", () => {
  const abi = parseAbi(["error QuoteExpired(uint64)", "error PriceOutOfBand(uint256,uint256,uint16)", "error AmountInTooLarge(uint256,uint256)", "error InsufficientDepth(uint256,uint256)"]);
  const err = (data: string) => new BaseError("The contract function \"swap\" reverted", { cause: Object.assign(new Error("exec reverted"), { data }) });
  test("each v2 error maps to its own plain case", () => {
    expect(classifyFailure(err(encodeErrorResult({ abi, errorName: "QuoteExpired", args: [1n] })), false)).toBe("stale-quote");
    expect(classifyFailure(err(encodeErrorResult({ abi, errorName: "PriceOutOfBand", args: [1n, 2n, 800] })), false)).toBe("out-of-band");
    expect(classifyFailure(err(encodeErrorResult({ abi, errorName: "AmountInTooLarge", args: [2n, 1n] })), false)).toBe("too-large");
    expect(classifyFailure(err(encodeErrorResult({ abi, errorName: "InsufficientDepth", args: [2n, 1n] })), false)).toBe("no-depth");
    expect(classifyQuoteError("router quote reverted: PriceOutOfBand")).toBe("out-of-band");
    expect(classifyQuoteError("rate limited")).toBe("other");
  });
});
