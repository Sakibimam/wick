import { describe, expect, test } from "bun:test";
import { cronTick, emptyCronState, type CronState } from "../src/worker-tick.js";
import { USDC, W0G } from "../src/price.js";
import { fakeChain } from "./fake-chain.js";

const E18 = 10n ** 18n;
const NOW = 1_800_000_000_000;
/** A state whose live quote is fresh and whose mid has not moved, so the tick holds and runs the funding leg. */
function holding(c: ReturnType<typeof fakeChain>, s: CronState, nowMs = NOW): CronState {
  const exp = BigInt(Math.floor(nowMs / 1000) + 800);
  for (const k of [`${W0G}:${USDC}`, `${USDC}:${W0G}`]) c.st.quotes.set(k.toLowerCase(), { rateE18: 1n, maxAmountIn: 1n, expiry: exp, epoch: 1n, nonce: 1n, inferenceId: `0x${"ab".repeat(32)}` });
  return { ...s, lastMid: 1.0001 ** c.st.twapTick * 1e12, quotedAt: nowMs - 60_000 };
}

describe("ccip fee", () => {
  test("a run at ccip-send with quoteCcipFee failing never sends the fallback 1 ETH and holds ccip_fee_unavailable", async () => {
    const c = fakeChain(); c.st.ccipFee = null; c.st.ethWei = 2n * E18;
    const s0 = holding(c, emptyCronState());
    s0.funding = { ...s0.funding!, run: { id: "fuel-1", kind: "fuel", startedAt: NOW - 600_000, usdcIn: "1000000", w0gFromFees: "0", w0gBridge: (5n * E18).toString(), minOut: "0", step: "ccip-send", pending: null } };
    const r = await cronTick(s0, c.env({ now: NOW }));
    expect(c.st.sent.filter((t) => t.value >= E18)).toEqual([]);
    expect(r.outcome).toContain("ccip_fee_unavailable");
    expect(r.state.funding!.run!.step).toBe("ccip-send");
  });
});

import { encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiParameters, type Hex } from "viem";
import { aquaDockedBalances } from "../src/worker-tick.js";
import { AGENT, LIVE_HASH, ROUTER } from "./fake-chain.js";
import { AQUA } from "../src/funding-machine.js";

describe("docked balance read", () => {
  const flow = parseAbi(["event Pushed(address maker,address app,bytes32 strategyHash,address token,uint256 amount)", "event Pulled(address maker,address app,bytes32 strategyHash,address token,uint256 amount)"]);
  const log = (name: "Pushed" | "Pulled", token: string, amount: bigint, block: bigint, txIndex: number, hash: Hex = LIVE_HASH) => ({ address: AQUA, topics: encodeEventTopics({ abi: flow, eventName: name }) as Hex[], data: encodeAbiParameters(parseAbiParameters("address,address,bytes32,address,uint256"), [AGENT, ROUTER, hash, token as Hex, amount]), blockNumber: block, transactionIndex: txIndex, logIndex: txIndex, transactionHash: `0x${String(txIndex).padStart(64, "0")}` as Hex });
  test("balance at the block before the dock, plus Aqua flows earlier in the dock block, ignoring later txs and other strategies", async () => {
    const c = fakeChain();
    const N = 2_000_000n, dockTx = `0x${"d0".repeat(32)}` as Hex;
    c.st.block = N + 5n;
    c.st.receipts.set(dockTx, { blockNumber: N, transactionIndex: 4, status: "success" });
    c.st.history.set(`${LIVE_HASH}:${N - 1n}`, { w0g: 10n * E18, usdc: 10_000_000n, tokensCount: 2 });
    c.st.slots.set(LIVE_HASH, { w0g: 0n, usdc: 0n, tokensCount: 0xff });
    c.st.logs.push(log("Pulled", W0G, E18, N, 2), log("Pushed", USDC, 1_000_000n, N, 2), log("Pushed", USDC, 7n, N, 6), log("Pushed", USDC, 5n, N, 1, `0x${"ee".repeat(32)}`));
    const e = c.env();
    expect(await aquaDockedBalances(e.base, AGENT, LIVE_HASH, dockTx)).toEqual({ w0g: 9n * E18, usdc: 11_000_000n });
    expect(await aquaDockedBalances(e.base, AGENT, LIVE_HASH, null)).toBeNull();
  });
});

describe("requote cadence", () => {
  test("a steady price across 3 ticks after a post renews the quote once, not on every tick", async () => {
    const c = fakeChain();
    const t0 = NOW;
    let s = (await cronTick(emptyCronState(), c.env({ now: t0 }))).state;
    const posts = () => c.st.sent.filter((t) => t.fn === "postPair").length;
    expect(posts()).toBe(1);
    for (const dt of [300_000, 600_000, 900_000]) s = (await cronTick(s, c.env({ now: t0 + dt }))).state;
    expect(posts() - 1).toBe(1);
    const q = [...c.st.quotes.values()][0]!;
    expect(Number(q.expiry)).toBeGreaterThan((t0 + 900_000) / 1000);
  });
});

import { router } from "./fake-chain.js";
describe("half-spread decision on chain", () => {
  test("each side is posted at max(model, tier floor) around the TWAP, and both half-spreads and the reason are persisted", async () => {
    const c = fakeChain();
    const r = await cronTick(emptyCronState(), c.env({ now: NOW, fetchImpl: router(() => ({ bidHalfSpreadBps: 90, askHalfSpreadBps: 10, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "calm, balanced" })) }));
    expect(r.outcome).toStartWith("posted");
    const p = c.st.sent.find((t) => t.fn === "postPair")!.args[0] as { rate01E18: bigint; rate10E18: bigint };
    const mid = 1.0001 ** c.st.twapTick * 1e12;
    expect(Number(p.rate01E18) / 1e6 / mid).toBeCloseTo(1 - 0.009, 5);
    expect(1e30 / Number(p.rate10E18) / mid).toBeCloseTo(1 + 0.003, 5);
    expect(r.state.inferences.at(-1)).toMatchObject({ bidHalfSpreadBps: 90, askHalfSpreadBps: 10, postedBidHalfSpreadBps: 90, postedAskHalfSpreadBps: 30, reason: "calm, balanced", outcome: "posted" });
  });
});

describe("a refused answer never empties the book", () => {
  test("a guard refusal with a valid previous decision re-posts that decision around the new TWAP, clamped, and records why", async () => {
    const c = fakeChain();
    let answer: unknown = { bidHalfSpreadBps: 70, askHalfSpreadBps: 50, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "first" };
    const e = (now: number) => c.env({ now, fetchImpl: router(() => answer) });
    let r = await cronTick(emptyCronState(), e(NOW));
    expect(r.outcome).toStartWith("posted");
    c.st.twapTick += 40; // ~40 bps move: a requote is due
    answer = { bidHalfSpreadBps: 700, askHalfSpreadBps: 50, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "bad" };
    r = await cronTick(r.state, e(NOW + 300_000));
    const posts = c.st.sent.filter((t) => t.fn === "postPair");
    expect(posts.length).toBe(2);
    expect(r.outcome).toContain("refused model answer, reposted last valid decision");
    const p = posts[1]!.args[0] as { rate01E18: bigint; rate10E18: bigint; inferenceId: string; expiry: bigint };
    const mid = 1.0001 ** c.st.twapTick * 1e12;
    expect(Number(p.rate01E18) / 1e6 / mid).toBeCloseTo(1 - 0.007, 5);
    expect(1e30 / Number(p.rate10E18) / mid).toBeCloseTo(1 + 0.005, 5);
    expect(p.inferenceId).toBe((posts[0]!.args[0] as { inferenceId: string }).inferenceId);
    expect(r.state.inferences.at(-1)!.outcome).toBe("refused model answer, reposted last valid decision");
    expect(r.state.inferences.at(-1)!.reason).toContain("spread_out_of_range");
  });
  test("with no valid previous decision a refusal posts nothing", async () => {
    const c = fakeChain();
    const r = await cronTick(emptyCronState(), c.env({ now: NOW, fetchImpl: router(() => ({ bidHalfSpreadBps: 700, askHalfSpreadBps: 50, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "bad" })) }));
    expect(c.st.sent.filter((t) => t.fn === "postPair").length).toBe(0);
    expect(r.outcome).toStartWith("refused spread_out_of_range");
  });
});

describe("advertised size never exceeds depth", () => {
  test("each side's maxAmountIn is clamped to the input whose output the strategy can pay, before postPair", async () => {
    const c = fakeChain();
    c.st.slots.set(LIVE_HASH.toLowerCase(), { w0g: E18, usdc: 6_836n, tokensCount: 2 });
    const r = await cronTick(emptyCronState(), c.env({ now: NOW, fetchImpl: router(() => ({ bidHalfSpreadBps: 60, askHalfSpreadBps: 40, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "W0G heavy" })) }));
    expect(r.outcome).toStartWith("posted");
    const p = c.st.sent.find((t) => t.fn === "postPair")!.args[0] as { rate01E18: bigint; rate10E18: bigint; maxIn0: bigint; maxIn1: bigint };
    const byDepth0 = 6_836n * 10_000n / 9_970n * E18 / p.rate01E18;
    expect(byDepth0 < 10n ** 17n).toBe(true); // ~0.047 W0G, where 0.05 USDC of size alone would advertise ~0.34 W0G
    expect(p.maxIn0).toBe(byDepth0);
    expect(p.maxIn1).toBe(50_000n);
    // every advertised input is fillable: its output at the quoted rate, net of the fee, fits the strategy's balance
    expect(p.maxIn0 * p.rate01E18 / E18 * 9_970n / 10_000n <= 6_836n).toBe(true);
  });
});

describe("per-quote budget", () => {
  const swapped = parseAbi(["event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)"]);
  const fill = (tokenIn: string, tokenOut: string, amountIn: bigint, block: bigint, i: number, taker: string = "0x00000000000000000000000000000000000000f1") => ({ address: ROUTER, topics: encodeEventTopics({ abi: swapped, eventName: "Swapped" }) as Hex[], data: encodeAbiParameters(parseAbiParameters("bytes32,address,address,address,address,uint256,uint256"), [LIVE_HASH, AGENT, taker as Hex, tokenIn as Hex, tokenOut as Hex, amountIn, 1n]), blockNumber: block, transactionIndex: i, logIndex: i, transactionHash: `0x${String(i + 100).padStart(64, "0")}` as Hex });
  test("two fills totalling more than the quote's budget trigger an immediate requote with a reduced cap, same price and expiry", async () => {
    const c = fakeChain();
    let r = await cronTick(emptyCronState(), c.env({ now: NOW }));
    const first = c.st.sent.find((t) => t.fn === "postPair")!.args[0] as { maxIn0: bigint; maxIn1: bigint; rate01E18: bigint; rate10E18: bigint; expiry: bigint; nonce: bigint; inferenceId: string };
    expect(first.maxIn1).toBe(50_000n);
    c.st.logs.push(fill(USDC, W0G, 30_000n, c.st.block + 1n, 1), fill(USDC, W0G, 25_000n, c.st.block + 2n, 2), fill(USDC, W0G, 99_000n, c.st.block + 2n, 3, AGENT));
    c.st.block += 5n;
    r = await cronTick(r.state, c.env({ now: NOW + 60_000 }));
    const posts = c.st.sent.filter((t) => t.fn === "postPair");
    expect(posts.length).toBe(2);
    const capped = posts[1]!.args[0] as typeof first;
    expect(capped.maxIn1).toBe(1n);
    expect(capped.maxIn0 <= first.maxIn0).toBe(true);
    expect([capped.rate01E18, capped.rate10E18, capped.expiry, capped.inferenceId, capped.nonce]).toEqual([first.rate01E18, first.rate10E18, first.expiry, first.inferenceId, first.nonce + 1n]);
    expect(r.outcome).toContain("budget_spent");
    // a third tick with no new fills does not post again
    r = await cronTick(r.state, c.env({ now: NOW + 120_000 }));
    expect(c.st.sent.filter((t) => t.fn === "postPair").length).toBe(2);
  });
  test("fills below the budget, and the maker's own fills, never trigger a requote", async () => {
    const c = fakeChain();
    let r = await cronTick(emptyCronState(), c.env({ now: NOW }));
    c.st.logs.push(fill(USDC, W0G, 49_999n, c.st.block + 1n, 1), fill(USDC, W0G, 10n ** 9n, c.st.block + 1n, 2, AGENT));
    c.st.block += 5n;
    r = await cronTick(r.state, c.env({ now: NOW + 60_000 }));
    expect(c.st.sent.filter((t) => t.fn === "postPair").length).toBe(1);
  });
});

describe("headroom counts every strategy the maker runs", () => {
  test("wallet headroom subtracts the balances of every known live strategy hash, not just the current one", async () => {
    const c = fakeChain(); c.st.ccipFee = 10n ** 14n;
    const other = `0x${"0b".repeat(32)}` as Hex, docked = `0x${"0d".repeat(32)}` as Hex;
    c.st.slots.set(other, { w0g: 0n, usdc: 5_000_000n, tokensCount: 2 });
    c.st.slots.set(docked, { w0g: 0n, usdc: 0n, tokensCount: 0xff });
    const s0 = holding(c, emptyCronState());
    const r = await cronTick(s0, c.env({ now: NOW, x402RevenueUsdc: 10_000_000n, orderHashes: [other, docked, LIVE_HASH] }));
    expect(r.state.funding!.lastDecision!.spendableUsdc).toBe((10_000_000n - 146_400n - 5_000_000n).toString());
  });
});
