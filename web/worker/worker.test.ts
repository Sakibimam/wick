import { expect, test } from "bun:test";
import { depthCap } from "./api";
import { economicsOf, quotesOf, requotesPerDay, runCostUsd, v1Records } from "./status";
import { countingFetch } from "./cron";

// The extruction's exact-in math: floor(floor(in * rate / 1e18) * (1e4 - fee) / 1e4).
const outOf = (amountIn: bigint, rate: bigint, fee: number) => (amountIn * rate / 10n ** 18n) * BigInt(10_000 - fee) / 10_000n;

test("depth cap is the largest input whose output fits the strategy balance", () => {
  const rate = 6_800_000_000_000_000_000_000_000_000_000n, depth = 1_357_492_788_767_429_240n;
  const cap = depthCap(depth, rate, 30, 10n ** 30n);
  expect(outOf(cap, rate, 30) <= depth).toBe(true);
  expect(outOf(cap + 1n, rate, 30) > depth || outOf(cap + 10n, rate, 30) > depth).toBe(true);
  // 10 USDC asks for ~67.8 W0G against 1.357 W0G of depth: the route must cap it, not quote it.
  expect(10_000_000n > cap).toBe(true);
  expect(depthCap(depth, rate, 30, 50_000n)).toBe(50_000n);
  expect(depthCap(0n, rate, 30, 10n ** 30n)).toBe(0n);
});

test("every quote carries the request id of its own stored record", () => {
  const posted = [
    { tokenIn: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", rateE18: "147000", expiry: "2000000000", inferenceId: "0xabc0000000000000000000000000000000000000000000000000000000000000", requestId: "req-a", postedTx: "0x1111111111111111111111111111111111111111111111111111111111111111", postedBlock: "1", board: "0x0d87944FFFf253dBbbD07750AceE7898333218A5" },
    { tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", rateE18: "6800000000000000000000000000000", expiry: "2000000000", inferenceId: "0xabc0000000000000000000000000000000000000000000000000000000000000", requestId: "req-a", postedTx: "0x1111111111111111111111111111111111111111111111111111111111111111", postedBlock: "1", board: "0x0d87944FFFf253dBbbD07750AceE7898333218A5" },
  ] as const;
  // The inferenceId is not keccak(requestId + tokens): a reverse map would find nothing; the stored record still names the run.
  const q = quotesOf(posted as never, [{ tokenIn: posted[0].tokenIn, tokenOut: posted[0].tokenOut, inferenceId: posted[0].inferenceId, expiry: 2_000_000_000n }], 1_900_000_000);
  expect(q.length).toBe(2);
  expect(q.every((x) => x.requestId === "req-a")).toBe(true);
  expect(q.filter((x) => x.current).length).toBe(1);
});

test("v1 posts resolve their request id by post tx, the two pre-cron posts from the ledger", () => {
  const posts = [{ tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", rateE18: "1", expiry: "1793864133", inferenceId: "0x01", postedTx: "0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec", block: "1" }];
  expect(v1Records(posts as never, [])[0]!.requestId).toBe("5319a0b6-562e-4bbe-a141-dfb94fc20aaa");
});

test("requotes per day follow the TTL and the 600 s window on a 5 minute cron", () => {
  expect(requotesPerDay(900)).toBe(288);
  expect(requotesPerDay(1500)).toBe(96);
});

test("economics: run cost in both billing currencies, coverage and break-even", () => {
  expect(runCostUsd({ currency: "usd", totalCost: "29" }, 0.15)).toBeCloseTo(0.000029, 9);
  expect(runCostUsd({ currency: "0g", totalCost: "272018666666666" }, 0.15)).toBeCloseTo(0.0000408, 7);
  const e = economicsOf({ fills: [{ txHash: "0x", logIndex: 0, block: "1", timeMs: 1, orderHash: "0x", taker: "0x0000000000000000000000000000000000000001", tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", amountIn: "100000", amountOut: "1" }] as never, inferences: [{ currency: "0g", totalCost: "272018666666666" }], mid: 0.15, ethUsd: 2200, fundsWei: 2_000_000_000_000_000_000n, ttlSeconds: 900, gasPerRequoteWei: 1_200_000_000_000n, fundingThresholdUsdc: 1.2, funded0gWei: 0n });
  expect(e.feesEarnedUsdc).toBeCloseTo(0.0003, 9);
  expect(e.coverage!).toBeCloseTo(0.0003 / 0.0000408, 1);
  expect(e.breakEvenFillUsdcPerRun!).toBeCloseTo(0.0000408 / 0.003, 4);
  expect(e.gasPerRequoteUsd!).toBeCloseTo(0.00264, 5);
  expect(e.requotesPerDay).toBe(288);
  expect(e.runwayDays!).toBeGreaterThan(0);
});

test("the subrequest counter refuses calls past the Workers cap", async () => {
  const { fetch: f, counter } = countingFetch((async () => new Response("ok")) as unknown as typeof fetch);
  for (let i = 0; i < 48; i++) await f("https://x");
  await expect(f("https://x")).rejects.toThrow(/subrequest budget/);
  expect(counter.n).toBe(49);
});
