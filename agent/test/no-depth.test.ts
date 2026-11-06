import { describe, expect, test } from "bun:test";
import { cronTick, emptyCronState } from "../src/worker-tick.js";
import { fakeChain, LIVE_HASH, router } from "./fake-chain.js";

const NOW = 1_800_000_000_000;

describe("no strategy depth", () => {
  test("holds before buying an inference when both strategy balances are zero", async () => {
    const c = fakeChain();
    c.st.slots.set(LIVE_HASH.toLowerCase(), { w0g: 0n, usdc: 0n, tokensCount: 0xff });
    let calls = 0;
    const answer = router();
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return answer(...args);
    }) as typeof fetch;

    const r = await cronTick(emptyCronState(), c.env({ now: NOW, fetchImpl }));
    expect(calls).toBe(0);
    expect(r.outcome).toStartWith("hold");
    expect(r.outcome).toContain("no_depth");
  });

  test("still calls the router when strategy depth is nonzero", async () => {
    const c = fakeChain();
    let calls = 0;
    const answer = router();
    const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return answer(...args);
    }) as typeof fetch;

    const r = await cronTick(emptyCronState(), c.env({ now: NOW, fetchImpl }));
    expect(calls).toBe(1);
    expect(r.outcome).toStartWith("posted");
  });
});
