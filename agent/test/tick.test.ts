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
