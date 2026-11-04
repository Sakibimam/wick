import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";
import { DEFAULT_BUDGET_CONFIG as c, decideBudget, deviationBps } from "../src/budget.js";
import { askBrain, BrainError, CHEAP_MODEL, PRIMARY_MODEL, type BrainErrorCode } from "../src/brain.js";
import { buildFundingPlan, fundingAbi, BASE_CCIP_ROUTER, SWAP_ROUTER, ZERO_G_PAYMENT_LAYER, W0G_ZERO_G } from "../src/funding.js";
import { midPriceUsdcPerW0g, USDC, W0G } from "../src/price.js";

const addr = "0x0000000000000000000000000000000000000011" as const;
const sqrtFor = (p: number, d0: number, d1: number) => BigInt(Math.round(Math.sqrt(p / 10 ** (d0 - d1)) * 2 ** 96));
const input = (over: Partial<Parameters<typeof decideBudget>[0]> = {}) => ({ computeBalanceWei: 2n * 10n ** 18n, spendCapPerDayWei: 1000n, spentTodayWei: 0n, priceDeviationBps: 0, lastQuoteAgeMs: null, ...over });
const lowBalance = c.pauseBalanceWei;

describe("budget policy", () => {
  test("balance boundaries and paused floor", () => {
    expect(decideBudget(input({ computeBalanceWei: c.pauseBalanceWei })).tier).toBe("CRITICAL");
    expect(decideBudget(input({ computeBalanceWei: c.criticalBalanceWei })).tier).toBe("LOW");
    expect(decideBudget(input({ computeBalanceWei: c.lowBalanceWei })).tier).toBe("NORMAL");
    expect(decideBudget(input({ computeBalanceWei: lowBalance - 1n })).tier).toBe("PAUSED");
  });
  test("spend cap and exact ratios pause/critical/low", () => {
    const exactCap = decideBudget(input({ spendCapPerDayWei: 100n, spentTodayWei: 100n }));
    expect(exactCap.tier).toBe("PAUSED");
    expect(exactCap.model).toBeNull();
    expect(exactCap.spreadBps).toBeNull();
    expect(exactCap.postQuotes).toBe(false);
    expect(decideBudget(input({ spendCapPerDayWei: 0n })).tier).toBe("PAUSED");
    expect(decideBudget(input({ spendCapPerDayWei: 10000n, spentTodayWei: 9000n })).tier).toBe("CRITICAL");
    expect(decideBudget(input({ spendCapPerDayWei: 10000n, spentTodayWei: 7500n })).tier).toBe("LOW");
  });
  test("deviation thresholds and initial quote", () => {
    expect(decideBudget(input({ priceDeviationBps: 24, lastQuoteAgeMs: 1 })).requote).toBe(false);
    expect(decideBudget(input({ priceDeviationBps: 25, lastQuoteAgeMs: 1 })).requote).toBe(true);
    expect(decideBudget(input()).requote).toBe(true);
    expect(decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, priceDeviationBps: 99, lastQuoteAgeMs: 1 })).requote).toBe(false);
    expect(decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, priceDeviationBps: 100, lastQuoteAgeMs: 1 })).requote).toBe(false);
  });
  test("low deviation edges, critical quote age and paused posting", () => {
    expect(decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, priceDeviationBps: 99, lastQuoteAgeMs: 1 })).spreadBps).toBe(120);
    expect(decideBudget(input({ computeBalanceWei: c.criticalBalanceWei, priceDeviationBps: 99, lastQuoteAgeMs: 1 })).requote).toBe(false);
    const criticalNoQuote = decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, lastQuoteAgeMs: null }));
    expect(criticalNoQuote.tier).toBe("CRITICAL");
    expect(criticalNoQuote.postQuotes).toBe(false);
    expect(criticalNoQuote.model).toBeNull();
    expect(criticalNoQuote.allowInference).toBe(false);
    expect(criticalNoQuote.spreadBps).toBe(120);
    const fresh = decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, lastQuoteAgeMs: 120000 }));
    expect(fresh.retainLastQuote && fresh.postQuotes).toBe(true);
    const stale = decideBudget(input({ computeBalanceWei: c.pauseBalanceWei, lastQuoteAgeMs: 120001 }));
    expect(stale.postQuotes).toBe(false);
    expect(decideBudget(input({ computeBalanceWei: c.pauseBalanceWei - 1n })).postQuotes).toBe(false);
  });
  test("LOW requote threshold is inclusive at 100 bps", () => {
    const at100 = decideBudget(input({ computeBalanceWei: c.criticalBalanceWei, priceDeviationBps: 100, lastQuoteAgeMs: 1 }));
    const at99 = decideBudget(input({ computeBalanceWei: c.criticalBalanceWei, priceDeviationBps: 99, lastQuoteAgeMs: 1 }));
    expect(at100.tier).toBe("LOW");
    expect(at100.requote).toBe(true);
    expect(at99.requote).toBe(false);
  });
  test("deviation helper validates", () => { expect(deviationBps(100, 101)).toBe(100); expect(() => deviationBps(0, 2)).toThrow(); });
  test("invalid inputs and config rejected", () => { expect(() => decideBudget(input({ spentTodayWei: -1n }))).toThrow(); expect(() => decideBudget(input(), { ...c, lowBalanceWei: c.pauseBalanceWei })).toThrow(); });
  test("model ids follow budget tier", () => { expect(decideBudget(input()).model).toBe(PRIMARY_MODEL); expect(decideBudget(input({ computeBalanceWei: c.criticalBalanceWei })).model).toBe(CHEAP_MODEL); });
});

const state = { mid: 2, recentMids: [2], inventory: { w0g: 1, usdc: 2 }, budgetTier: "NORMAL" as const };
function fetcher(content: unknown, requestId = "rid", bodyId?: string): typeof fetch { return (async (_u, init) => { JSON.parse(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }], ...(bodyId ? { x_0g_trace: { request_id: bodyId } } : {}) }), { status: 200, headers: requestId ? { "X-Request-ID": requestId } : {} }); }) as typeof fetch; }
const answer = (rateE18 = 2e18, spreadBps = 30) => ({ rateE18, spreadBps, reason: "balanced" });
async function brainFail(code: BrainErrorCode, content: unknown) { try { await askBrain(state, { apiKey: "sk-test", fetchImpl: fetcher(content) }); throw new Error("unexpected success"); } catch (e) { expect(e).toBeInstanceOf(BrainError); expect((e as BrainError).code).toBe(code); } }
describe("brain protocol", () => {
  test("valid strict JSON and header request id", async () => { expect(await askBrain(state, { apiKey: "sk-test", fetchImpl: fetcher(answer()) })).toMatchObject({ rateE18: 2_000_000_000_000_000_000n, requestId: "rid", model: "0gm-1.0-35b-a3b" }); });
  test("required fields allow benign extra JSON keys", async () => { expect(await askBrain(state, { apiKey: "sk-test", fetchImpl: fetcher({ ...answer(), explanationCode: "balanced-inventory" }) })).toMatchObject({ spreadBps: 30, reason: "balanced" }); });
  test("spread bounds reject both sides", async () => { await brainFail("spread_out_of_range", answer(2e18, 4)); await brainFail("spread_out_of_range", answer(2e18, 501)); });
  test("rate beyond 3 percent rejects and boundary passes", async () => { await brainFail("rate_out_of_range", answer(2.061e18)); expect((await askBrain(state, { apiKey: "sk-test", fetchImpl: fetcher(answer(2.06e18)) })).rateE18).toBe(2_060_000_000_000_000_000n); });
  test("one wei over exact 3 percent boundary rejects", async () => { const tiny = { ...state, mid: 1e-14 }; expect((await askBrain(tiny, { apiKey: "x", fetchImpl: fetcher(answer(10300)) })).rateE18).toBe(10300n); await expect(askBrain(tiny, { apiKey: "x", fetchImpl: fetcher(answer(10301)) })).rejects.toMatchObject({ code: "rate_out_of_range" }); });
  test("invalid JSON, shape and non-number values reject", async () => { await brainFail("invalid_json", "{oops}"); await brainFail("invalid_shape", { rateE18: 2, spreadBps: 30 }); await brainFail("invalid_shape", { rateE18: "2000000000000000000", spreadBps: 30, reason: "x" }); });
  test("body request id fallback and cheap model selected", async () => { let model = ""; const f = (async (_u: RequestInfo | URL, init?: RequestInit) => { const req = JSON.parse(String(init?.body)); model = req.model; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) } }], x_0g_trace: { request_id: "body-id" } }), { headers: { "content-type": "application/json" } }); }) as unknown as typeof fetch; expect((await askBrain({ ...state, budgetTier: "LOW" }, { apiKey: "x", fetchImpl: f })).requestId).toBe("body-id"); expect(model).toBe("qwen3.7-flash"); });
  test("critical and paused never invoke fetch", async () => { let calls = 0; const f = (async () => { calls++; return new Response(); }) as unknown as typeof fetch; await expect(askBrain({ ...state, budgetTier: "CRITICAL" }, { apiKey: "x", fetchImpl: f })).rejects.toMatchObject({ code: "budget_critical" }); await expect(askBrain({ ...state, budgetTier: "PAUSED" }, { apiKey: "x", fetchImpl: f })).rejects.toMatchObject({ code: "budget_paused" }); expect(calls).toBe(0); });
  test("missing key and missing request id are typed errors", async () => { await expect(askBrain(state, { apiKey: "", fetchImpl: fetcher(answer()) })).rejects.toMatchObject({ code: "missing_api_key" }); await expect(askBrain(state, { apiKey: "x", fetchImpl: (async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer()) } }] }))) as unknown as typeof fetch })).rejects.toMatchObject({ code: "request_id_missing" }); });
});

describe("price math", () => {
  test("both W0G/USDC token orders yield 0.25", () => { expect(midPriceUsdcPerW0g(sqrtFor(0.25, 18, 6), W0G, USDC, 18, 6)).toBeCloseTo(0.25, 8); expect(midPriceUsdcPerW0g(sqrtFor(4, 6, 18), USDC, W0G, 6, 18)).toBeCloseTo(0.25, 8); });
  test("known sqrtPriceX96 fixtures yield 0.25 in both token orders", () => { expect(midPriceUsdcPerW0g(39614081257132168796771n, W0G, USDC, 18, 6)).toBeCloseTo(0.25, 8); expect(midPriceUsdcPerW0g(2_000_000n * 2n ** 96n, USDC, W0G, 6, 18)).toBeCloseTo(0.25, 8); });
  test("zero sqrt and wrong pair reject", () => { expect(() => midPriceUsdcPerW0g(0n, W0G, USDC, 18, 6)).toThrow(); expect(() => midPriceUsdcPerW0g(2n ** 96n, addr, USDC, 18, 6)).toThrow(); });
  test("decimals must match the W0G and USDC contracts", () => { expect(() => midPriceUsdcPerW0g(2n ** 96n, W0G, USDC, 6, 18)).toThrow(); });
});

describe("unsigned funding plan", () => {
  const params = { agent: addr, agentOwner: "0x0000000000000000000000000000000000000022" as const, usdcAmountIn: 5_000_000n, w0gAmountOut: 31_110_896_293_223_247_208n, slippageBps: 37, ccipFeeWei: 123n };
  test("orders six steps by chain and slippage floors", () => { const p = buildFundingPlan(params); expect(p.steps.map(x => x.id)).toEqual(["approve-usdc", "swap-usdc-to-w0g", "approve-w0g-ccip", "ccip-send-w0g", "withdraw-w0g-0g", "deposit-payment-layer"]); expect(p.steps.map(x => x.chainId)).toEqual([8453, 8453, 8453, 8453, 16661, 16661]); expect(p.minW0gOut).toBe(params.w0gAmountOut * 9963n / 10000n); });
  test("swap calldata decodes correctly", () => { const x = buildFundingPlan(params).swapTx; const d = decodeFunctionData({ abi: fundingAbi.router, data: x.data }); expect(x.data.slice(0, 10)).toBe("0x04e45aaf"); expect(d.args[0]).toMatchObject({ tokenIn: USDC, tokenOut: W0G, fee: 3000, recipient: addr, amountIn: params.usdcAmountIn, amountOutMinimum: buildFundingPlan(params).minW0gOut, sqrtPriceLimitX96: 0n }); });
  test("CCIP calldata carries destination, receiver, token amount, fee token and args tag", () => { const x = buildFundingPlan(params).ccipSendTx; const d = decodeFunctionData({ abi: fundingAbi.router, data: x.data }) as unknown as { args: readonly [bigint, { receiver: `0x${string}`; tokenAmounts: readonly [{ token: string; amount: bigint }]; feeToken: string; extraArgs: `0x${string}` }] }; expect(x.data.slice(0, 10)).toBe("0x96f4e9f9"); expect(d.args[0]).toBe(4426351306075016396n); expect(d.args[1].receiver.slice(-40)).toBe(addr.slice(2)); expect(d.args[1].tokenAmounts[0]!).toEqual({ token: W0G, amount: params.w0gAmountOut }); expect(d.args[1].feeToken).toBe("0x0000000000000000000000000000000000000000"); expect(d.args[1].extraArgs.slice(0, 10)).toBe("0x181dcf10"); expect(x.to).toBe(BASE_CCIP_ROUTER); expect(x.value).toBe(params.ccipFeeWei); });
  test("approval steps use approve selector and expected spender and amount", () => { const steps = buildFundingPlan(params).steps; const a0 = steps[0]!, a1 = steps[2]!; expect(a0.data.slice(0, 10)).toBe("0x095ea7b3"); expect(a1.data.slice(0, 10)).toBe("0x095ea7b3"); expect(decodeFunctionData({ abi: fundingAbi.erc20, data: a0.data }).args).toEqual([SWAP_ROUTER, params.usdcAmountIn]); expect(decodeFunctionData({ abi: fundingAbi.erc20, data: a1.data }).args).toEqual([BASE_CCIP_ROUTER, params.w0gAmountOut]); });
  test("withdraw and deposit use correct selectors, amount, owner and reserve", () => { const p = buildFundingPlan({ ...params, nativeGasReserveWei: 10n }); expect(p.withdrawTx.data.slice(0, 10)).toBe("0x2e1a7d4d"); expect(decodeFunctionData({ abi: fundingAbi.token, data: p.withdrawTx.data }).args[0]).toBe(params.w0gAmountOut); expect(p.depositTx.data.slice(0, 10)).toBe("0xaa67c919"); expect(decodeFunctionData({ abi: fundingAbi.payment, data: p.depositTx.data }).args[0]).toBe(params.agentOwner); expect(p.depositTx.value).toBe(params.w0gAmountOut - 10n); expect(buildFundingPlan(params).depositTx.value).toBe(params.w0gAmountOut); expect(p.withdrawTx.to).toBe(W0G_ZERO_G); expect(p.depositTx.to).toBe(ZERO_G_PAYMENT_LAYER); });
  test("invalid slippage, amounts and reserve reject", () => { for (const slippageBps of [-1, 10000]) expect(() => buildFundingPlan({ ...params, slippageBps })).toThrow(); expect(() => buildFundingPlan({ ...params, usdcAmountIn: 0n })).toThrow(); expect(() => buildFundingPlan({ ...params, w0gAmountOut: 0n })).toThrow(); expect(() => buildFundingPlan({ ...params, nativeGasReserveWei: params.w0gAmountOut })).toThrow(); });
  test("zero agent and agent owner reject", () => { const zero = "0x0000000000000000000000000000000000000000" as const; expect(() => buildFundingPlan({ ...params, agent: zero })).toThrow(); expect(() => buildFundingPlan({ ...params, agentOwner: zero })).toThrow(); });
});
