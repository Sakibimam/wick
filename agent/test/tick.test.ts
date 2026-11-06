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
