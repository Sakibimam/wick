import { describe, expect, test } from "bun:test";
import { askDecision, BrainError, PRIMARY_MODEL, TEE_BACKUP_MODEL, inventoryGoal, type DecisionState } from "../src/brain.js";
import { cronTick, emptyCronState } from "../src/worker-tick.js";
import { fakeChain } from "./fake-chain.js";

const answer = { bidHalfSpreadBps: 90, askHalfSpreadBps: 30, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "steady inventory" };
const state: DecisionState = { twapMid: 1, spotMid: 1, recentMids: [1], realizedVolBps: 0, inventory: { w0g: 1, usdc: 1, w0gValueShare: 0.5 }, recentFills: [], gas: { baseEth: 1, gasPerRequoteUsd: 0.01 }, runway: { vault0g: 1, runsLeft: 1, days: 1 }, budgetTier: "NORMAL", tierSpreadBps: 30, maxAmountInUsdcCap: 0.2, inventoryGoal: inventoryGoal(0.5) };
const noSleep = async () => {};
function fake(responses: ((model: string) => Response)[]) {
  const seen: string[] = [];
  const fetchImpl = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const model = JSON.parse(String(init?.body)).model;
    seen.push(model);
    return responses.shift()!(model);
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}
const ok = (id: string, tee: boolean | null, cost: string) => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }], x_0g_trace: { request_id: id, tee_verified: tee, provider: "0xprovider", billing: { currency: "0g", total_cost: cost } } });
const down = () => new Response("upstream error", { status: 502 });

describe("TEE model fallback chain", () => {
  test("verified primary answers in one call", async () => {
    const f = fake([() => ok("p", true, "10")]);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f.fetchImpl, sleep: noSleep });
    expect(f.seen).toEqual([PRIMARY_MODEL]);
    expect(r).toMatchObject({ model: PRIMARY_MODEL, teeVerified: true, fallbackFrom: null, extraRuns: [] });
  });
  test("primary 502 falls through to verified backup", async () => {
    const f = fake([down, down, down, () => ok("b", true, "20")]);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f.fetchImpl, sleep: noSleep });
    expect(f.seen).toEqual([PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL, TEE_BACKUP_MODEL]);
    expect(r).toMatchObject({ model: TEE_BACKUP_MODEL, requestId: "b", teeVerified: true });
    expect(r.fallbackFrom).toContain(`${PRIMARY_MODEL}: router returned HTTP 502`);
  });
  test("unverified primary is retained and tick charges both successful runs", async () => {
    const f = fake([() => ok("p", null, "100"), () => ok("b", true, "200")]);
    const direct = await askDecision(state, { apiKey: "x", fetchImpl: f.fetchImpl, sleep: noSleep });
    expect(direct.extraRuns).toMatchObject([{ requestId: "p", billing: { totalCost: "100" } }]);

    const c = fakeChain();
    const tickFetch = fake([() => ok("tick-p", null, "100"), () => ok("tick-b", true, "200")]);
    const tick = await cronTick(emptyCronState(), c.env({ now: 1_800_000_000_000, fetchImpl: tickFetch.fetchImpl }));
    expect(tick.state.spentTodayWei).toBe("300");
    expect(tick.state.inferences.map(x => x.requestId)).toEqual(["tick-p", "tick-b"]);
  });
  test("both providers down falls back to Qwen with a null TEE verdict", async () => {
    const f = fake([down, down, down, down, () => ok("q", null, "30")]);
    const r = await askDecision(state, { apiKey: "x", fetchImpl: f.fetchImpl, sleep: noSleep });
    expect(r).toMatchObject({ model: "qwen3.7-flash", requestId: "q", teeVerified: null });
    expect(f.seen).toEqual([PRIMARY_MODEL, PRIMARY_MODEL, PRIMARY_MODEL, TEE_BACKUP_MODEL, "qwen3.7-flash"]);
  });
  test("unverified primary and backup are refused with both billed runs", async () => {
    const f = fake([() => ok("p", null, "100"), () => ok("b", false, "200")]);
    try {
      await askDecision(state, { apiKey: "x", fetchImpl: f.fetchImpl, sleep: noSleep });
      throw new Error("expected tee_unverified");
    } catch (e) {
      expect(e).toBeInstanceOf(BrainError);
      expect((e as BrainError).code).toBe("tee_unverified");
      expect((e as BrainError).run?.requestId).toBe("b");
      expect((e as BrainError).extraRuns.map(x => x.requestId)).toEqual(["p"]);
    }
  });
});
