import { describe, expect, test } from "bun:test";
import { decodeFunctionData, getAddress, parseAbi, type Address, type Hex } from "viem";
import { ADDRESS_THIS, decideFunding, emptyFundingState, fundingTick, WETH_BASE, type FundingCtx, type FundingInput, type FundingState } from "../src/funding-machine.js";
import { BASE_CCIP_ROUTER, fundingAbi, SWAP_ROUTER, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER } from "../src/funding.js";
import { USDC, W0G } from "../src/price.js";

const agent = getAddress("0x00000000000000000000000000000000000000a1"), owner = getAddress("0x00000000000000000000000000000000000000b2");
const E18 = 10n ** 18n;
const input = (over: Partial<FundingInput> = {}): FundingInput => ({ accrued: { usdc: 5_000_000n, w0g: 0n }, funded: { usdc: 0n, w0g: 0n }, wallet: { usdc: 5_600_000n, w0g: 2n * E18, ethWei: 2n * 10n ** 14n }, strategy: { usdc: 600_000n, w0g: 2n * E18 }, mid: 0.15, ethUsd: 3000, ccipFeeWei: 110_000_000_000_000n, baseGasPriceWei: 6_000_000n, zeroGGasUsdc: 0.01, gasTopUpBelowWei: 50_000_000_000_000n, gasShareBps: 5000, maxSpendWeiPerRun: 200_000_000_000_000n, ...over });
const threshold = (over: Partial<FundingInput> = {}) => decideFunding(input(over)).thresholdUsdc;
const withFees = (usdc: bigint, over: Partial<FundingInput> = {}) => input({ accrued: { usdc, w0g: 0n }, wallet: { usdc: 600_000n + usdc, w0g: 2n * E18, ethWei: 2n * 10n ** 14n }, ...over });

function mockIo() {
  const sent: { chainId: number; to: Address; data: Hex; value: bigint }[] = [];
  const st = { receipt: "success" as "success" | "reverted" | null, allowance: 10n ** 30n, zgW0g: 0n, zgNative: 10n * E18, swapOut: 30n * E18, ethOut: 10n ** 15n };
  const io = { send: async (tx: any) => { sent.push(tx); return `0x${sent.length.toString(16).padStart(64, "0")}` as Hex; }, receipt: async () => st.receipt, readAllowance: async () => st.allowance, readZeroGW0g: async () => st.zgW0g, readZeroGNative: async () => st.zgNative, quoteSwapUsdcToW0g: async () => st.swapOut, quoteSwapUsdcToEth: async () => st.ethOut };
  return { sent, st, io };
}
const ctxOf = (io: FundingCtx["io"], now: number, over: Partial<FundingInput> = {}): FundingCtx => { const { funded: _f, ...decision } = input(over); return { now, decision, io, agent, agentOwner: owner, zeroGGasReserveWei: E18 / 100n }; };

describe("decideFunding", () => {
  test("fires only at k x (ccip fee + gas); one micro-USDC below holds", () => {
    const t = threshold();
    expect(decideFunding(input()).k).toBe(3);
    const below = decideFunding(withFees(BigInt(Math.floor(t * 1e6)) - 1n));
    const at = decideFunding(withFees(BigInt(Math.ceil(t * 1e6))));
    expect([below.fire, below.reason]).toEqual([false, "below_threshold"]);
    expect([at.fire, at.kind, at.reason]).toEqual([true, "fuel", "fire_fuel"]);
    expect(at.thresholdUsdc).toBeCloseTo(3 * at.costUsdc, 12);
    expect(decideFunding({ ...withFees(BigInt(Math.ceil(t * 1e6))), k: 4 }).fire).toBe(false);
  });
  test("threshold tracks the live CCIP fee", () => { expect(threshold({ ccipFeeWei: 220_000_000_000_000n })).toBeGreaterThan(threshold()); });
  test("never spends strategy inventory: wallet == commitment means nothing is spendable", () => {
    const d = decideFunding(input({ accrued: { usdc: 10n ** 12n, w0g: 10n ** 24n }, wallet: { usdc: 600_000n, w0g: 2n * E18, ethWei: 2n * 10n ** 14n } }));
    expect([d.fire, d.reason, d.spendableUsdc, d.spendableW0g]).toEqual([false, "no_fees", "0", "0"]);
    const part = decideFunding(input({ accrued: { usdc: 9_000_000n, w0g: 0n }, wallet: { usdc: 2_600_000n, w0g: 2n * E18, ethWei: 2n * 10n ** 14n } }));
    expect(part.spendableUsdc).toBe("2000000");
  });
  test("already-funded fees are not funded again", () => { expect(decideFunding(input({ funded: { usdc: 5_000_000n, w0g: 0n } })).reason).toBe("no_fees"); });
  test("W0G fees count at the mid", () => {
    const d = decideFunding(input({ accrued: { usdc: 0n, w0g: 10n * E18 }, wallet: { usdc: 600_000n, w0g: 12n * E18, ethWei: 2n * 10n ** 14n } }));
    expect(d.unfundedValueUsdc).toBeCloseTo(1.5, 9); expect(d.fire).toBe(true);
  });
  test("spend cap and gas reserve block a run above threshold", () => {
    expect(decideFunding(input({ maxSpendWeiPerRun: 100_000_000_000_000n })).reason).toBe("spend_cap");
    expect(decideFunding(input({ wallet: { usdc: 5_600_000n, w0g: 2n * E18, ethWei: 150_000_000_000_000n } })).reason).toBe("gas_reserve");
  });
  test("gas leg takes priority below the ETH floor and uses only its share", () => {
    const low = { usdc: 5_600_000n, w0g: 2n * E18, ethWei: 10_000_000_000_000n };
    const d = decideFunding(input({ wallet: low }));
    expect([d.fire, d.kind, d.reason]).toEqual([true, "gas", "fire_gas"]);
    expect(d.unfundedValueUsdc).toBeCloseTo(2.5, 9);
    expect(decideFunding(input({ wallet: low, gasShareBps: 0 })).reason).toBe("no_fees");
    expect(decideFunding(input({ wallet: low, baseGasPriceWei: 10n ** 12n })).reason).toBe("below_threshold");
  });
});

async function runAll(state: FundingState, io: ReturnType<typeof mockIo>, start: number, maxTicks = 20) {
  const actions: string[] = [];
  let s = state, now = start;
  for (let i = 0; i < maxTicks; i++) {
    const r = await fundingTick(s, ctxOf(io.io, now)); s = r.state; actions.push(r.action); now += 300_000;
    if (r.action.startsWith("sent ccip-send")) io.st.zgW0g += BigInt(s.run!.w0gBridge);
    if (r.action.startsWith("sent withdraw-w0g-0g")) io.st.zgNative += BigInt(s.run!.w0gBridge);
    if (r.action.startsWith("funded")) break;
  }
  return { s, actions };
}

describe("fundingTick fuel run", () => {
  test("end to end: six txs in order, chain ids, calldata, funded once", async () => {
    const m = mockIo();
    const { s, actions } = await runAll(emptyFundingState(), m, 1_000_000);
    expect(actions.at(-1)).toStartWith("funded fuel-");
    expect(m.sent.map(x => x.to)).toEqual([USDC, SWAP_ROUTER, W0G, BASE_CCIP_ROUTER, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER]);
    expect(m.sent.map(x => x.chainId)).toEqual([8453, 8453, 8453, 8453, 16661, 16661]);
    const swap = decodeFunctionData({ abi: fundingAbi.router, data: m.sent[1]!.data }).args[0] as any;
    expect([swap.recipient, swap.amountIn, swap.amountOutMinimum, swap.fee]).toEqual([agent, 5_000_000n, 30n * E18 * 9900n / 10000n, 3000]);
    const bridge = 30n * E18 * 9900n / 10000n;
    expect(decodeFunctionData({ abi: fundingAbi.erc20, data: m.sent[2]!.data }).args).toEqual([BASE_CCIP_ROUTER, bridge]);
    const ccip = decodeFunctionData({ abi: fundingAbi.router, data: m.sent[3]!.data }).args as any;
    expect([ccip[1].tokenAmounts[0].amount, m.sent[3]!.value]).toEqual([bridge, 110_000_000_000_000n]);
    expect(decodeFunctionData({ abi: fundingAbi.token, data: m.sent[4]!.data }).args).toEqual([bridge]);
    expect([decodeFunctionData({ abi: fundingAbi.payment, data: m.sent[5]!.data }).args[0], m.sent[5]!.value]).toEqual([owner, bridge]);
    expect(s.funded).toEqual({ usdc: "5000000", w0g: "0" });
    expect(s.run).toBeNull();
    expect(s.history.filter(h => h.ok).length).toBe(6);
    const again = await fundingTick(s, ctxOf(m.io, 99_000_000));
    expect([again.action, m.sent.length]).toEqual(["hold no_fees", 6]);
  });
  test("pending waits on null, reverted clears the run without funding", async () => {
    const m = mockIo(); m.st.receipt = null;
    let r = await fundingTick(emptyFundingState(), ctxOf(m.io, 0));
    expect(r.action).toStartWith("sent approve-usdc-swap");
    r = await fundingTick(r.state, ctxOf(m.io, 60_000));
    expect([r.action, r.state.run?.step]).toEqual(["waiting approve-usdc-swap", "approve-usdc-swap"]);
    m.st.receipt = "reverted";
    r = await fundingTick(r.state, ctxOf(m.io, 120_000));
    expect([r.action, r.state.run, r.state.funded.usdc, m.sent.length]).toEqual(["reverted approve-usdc-swap", null, "0", 1]);
    expect(r.state.history.at(-1)!.ok).toBe(false);
  });
  test("success advances one step without sending the next tx in the same tick", async () => {
    const m = mockIo();
    let r = await fundingTick(emptyFundingState(), ctxOf(m.io, 0));
    r = await fundingTick(r.state, ctxOf(m.io, 1));
    expect([r.action, r.state.run!.step, m.sent.length]).toEqual(["done approve-usdc-swap", "swap-usdc-w0g", 1]);
  });
  test("a pending tx older than 20 minutes is abandoned", async () => {
    const m = mockIo(); m.st.receipt = null;
    const r = await fundingTick(emptyFundingState(), ctxOf(m.io, 0));
    const r2 = await fundingTick(r.state, ctxOf(m.io, 21 * 60_000));
    expect([r2.action, r2.state.run]).toEqual(["abandoned", null]);
  });
  test("allowance not yet visible blocks the swap and the ccip send", async () => {
    const m = mockIo();
    let r = await fundingTick(emptyFundingState(), ctxOf(m.io, 0));
    r = await fundingTick(r.state, ctxOf(m.io, 1));
    m.st.allowance = 0n;
    r = await fundingTick(r.state, ctxOf(m.io, 2));
    expect([r.action, m.sent.length]).toEqual(["allowance_not_visible", 1]);
    m.st.allowance = 10n ** 30n;
    r = await fundingTick(r.state, ctxOf(m.io, 3)); r = await fundingTick(r.state, ctxOf(m.io, 4));
    r = await fundingTick(r.state, ctxOf(m.io, 5)); r = await fundingTick(r.state, ctxOf(m.io, 6));
    expect(r.state.run!.step).toBe("ccip-send");
    m.st.allowance = 1n;
    r = await fundingTick(r.state, ctxOf(m.io, 7));
    expect([r.action, m.sent.length]).toEqual(["allowance_not_visible", 3]);
  });
  test("await-arrival advances only once the bridged W0G lands, abandons after the timeout", async () => {
    const m = mockIo(); m.st.zgW0g = 7n;
    let r = { state: emptyFundingState(), action: "" };
    for (let t = 0; r.state.run?.step !== "await-arrival"; t++) r = await fundingTick(r.state, ctxOf(m.io, t));
    expect(r.state.run!.zeroGW0gBefore).toBe("7");
    const waiting = await fundingTick(r.state, ctxOf(m.io, 100));
    expect(waiting.action).toBe("waiting arrival");
    m.st.zgW0g = 7n + BigInt(r.state.run!.w0gBridge) - 1n;
    expect((await fundingTick(r.state, ctxOf(m.io, 100))).action).toBe("waiting arrival");
    m.st.zgW0g += 1n;
    const arrived = await fundingTick(r.state, ctxOf(m.io, 100));
    expect([arrived.action, arrived.state.run!.step]).toEqual(["arrived", "withdraw-w0g-0g"]);
    m.st.zgW0g = 0n;
    const late = await fundingTick(r.state, ctxOf(m.io, 3 * 3_600_000 + 1));
    expect([late.action, late.state.run]).toEqual(["abandoned arrival", null]);
  });
  test("deposit keeps the native 0G gas reserve and never deposits zero", async () => {
    const m = mockIo();
    const st: FundingState = { ...emptyFundingState(), run: { id: "fuel-1", kind: "fuel", startedAt: 0, usdcIn: "5000000", w0gFromFees: "0", w0gBridge: (5n * E18).toString(), minOut: "0", step: "deposit-payment-layer", pending: null } };
    m.st.zgNative = 3n * E18;
    const r = await fundingTick(st, ctxOf(m.io, 0));
    expect(m.sent[0]!.value).toBe(3n * E18 - E18 / 100n);
    m.st.zgNative = E18 / 100n;
    const r2 = await fundingTick(st, ctxOf(m.io, 0));
    expect([r2.action, m.sent.length]).toEqual(["reserve_short", 1]);
    expect(r.state.run!.pending!.step).toBe("deposit-payment-layer");
  });
  test("W0G-only fees skip the USDC swap", async () => {
    const m = mockIo();
    const over = { accrued: { usdc: 0n, w0g: 10n * E18 }, wallet: { usdc: 600_000n, w0g: 12n * E18, ethWei: 2n * 10n ** 14n } };
    const { funded: _f, ...decision } = input(over);
    const r = await fundingTick(emptyFundingState(), { ...ctxOf(m.io, 0), decision });
    expect([r.state.run!.step, m.sent[0]!.to]).toEqual(["approve-w0g-ccip", W0G]);
    expect(decodeFunctionData({ abi: fundingAbi.erc20, data: m.sent[0]!.data }).args[1]).toBe(10n * E18);
  });
});

describe("fundingTick gas run", () => {
  test("below the ETH floor: approve, then SwapRouter02 multicall swap USDC->WETH and unwrap to the agent", async () => {
    const m = mockIo();
    const over = { wallet: { usdc: 5_600_000n, w0g: 2n * E18, ethWei: 10_000_000_000_000n } };
    const { funded: _f, ...decision } = input(over);
    const ctx = (now: number) => ({ ...ctxOf(m.io, now), decision });
    let r = await fundingTick(emptyFundingState(), ctx(0));
    expect(r.state.run!.kind).toBe("gas");
    expect(decodeFunctionData({ abi: fundingAbi.erc20, data: m.sent[0]!.data }).args).toEqual([SWAP_ROUTER, 2_500_000n]);
    r = await fundingTick(r.state, ctx(1)); r = await fundingTick(r.state, ctx(2));
    expect(m.sent[1]!.to).toBe(SWAP_ROUTER);
    const abi = parseAbi(["function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])", "function unwrapWETH9(uint256 amountMinimum,address recipient) payable"]);
    const [, calls] = decodeFunctionData({ abi, data: m.sent[1]!.data }).args as [bigint, Hex[]];
    const swap = decodeFunctionData({ abi: fundingAbi.router, data: calls[0]! }).args[0] as any;
    const minOut = 10n ** 15n * 9900n / 10000n;
    expect([swap.tokenIn, swap.tokenOut, swap.fee, swap.recipient, swap.amountIn, swap.amountOutMinimum]).toEqual([USDC, WETH_BASE, 500, ADDRESS_THIS, 2_500_000n, minOut]);
    expect(decodeFunctionData({ abi, data: calls[1]! }).args).toEqual([minOut, agent]);
    r = await fundingTick(r.state, ctx(3));
    expect([r.action.startsWith("funded gas-"), r.state.funded]).toEqual([true, { usdc: "2500000", w0g: "0" }]);
  });
});

describe("ccip-send fee guard", () => {
  const atCcip = (): FundingState => ({ ...emptyFundingState(), run: { id: "fuel-1", kind: "fuel", startedAt: 0, usdcIn: "5000000", w0gFromFees: "0", w0gBridge: (5n * E18).toString(), minOut: "0", step: "ccip-send", pending: null } });
  test("a fee above the per-run cap, or one that eats the gas top-up line, holds without sending", async () => {
    const m = mockIo();
    expect((await fundingTick(atCcip(), ctxOf(m.io, 0, { ccipFeeWei: 200_000_000_000_001n }))).action).toBe("hold ccip_fee_cap");
    expect((await fundingTick(atCcip(), ctxOf(m.io, 0, { ccipFeeWei: 0n }))).action).toBe("hold ccip_fee_cap");
    expect((await fundingTick(atCcip(), ctxOf(m.io, 0, { ccipFeeWei: 150_000_000_000_000n, wallet: { usdc: 5_600_000n, w0g: 2n * E18, ethWei: 200_000_000_000_000n } }))).action).toBe("hold ccip_fee_gas_reserve");
    expect(m.sent.length).toBe(0);
    const ok = await fundingTick(atCcip(), ctxOf(m.io, 0));
    expect([ok.action.startsWith("sent ccip-send"), m.sent[0]!.value]).toEqual([true, 110_000_000_000_000n]);
  });
});

describe("committed steps are credited", () => {
  test("a run abandoned at arrival after ccip-send succeeded has credited its fees, and the next decision does not fire on them", async () => {
    const m = mockIo();
    let r = { state: emptyFundingState(), action: "" }, t = 0;
    while (r.state.run?.step !== "await-arrival") r = await fundingTick(r.state, ctxOf(m.io, t++));
    const usdcIn = r.state.run!.usdcIn;
    const late = await fundingTick(r.state, ctxOf(m.io, 3 * 3_600_000 + 10));
    expect([late.action, late.state.run]).toEqual(["abandoned arrival", null]);
    expect(late.state.funded.usdc).toBe(usdcIn);
    const { funded: _f, ...decision } = input();
    expect(decideFunding({ ...decision, funded: { usdc: BigInt(late.state.funded.usdc), w0g: BigInt(late.state.funded.w0g) } }).fire).toBe(false);
    const again = await fundingTick(late.state, ctxOf(m.io, 4 * 3_600_000));
    expect(again.action).toBe("hold no_fees");
  });
  test("W0G fees are credited when the bridge send succeeds; a reverted swap credits nothing", async () => {
    const m = mockIo();
    const over = { accrued: { usdc: 0n, w0g: 10n * E18 }, wallet: { usdc: 600_000n, w0g: 12n * E18, ethWei: 2n * 10n ** 14n } };
    const { funded: _f, ...decision } = input(over);
    let r = { state: emptyFundingState(), action: "" }, t = 0;
    while (r.state.run?.step !== "await-arrival") r = await fundingTick(r.state, { ...ctxOf(m.io, t++), decision });
    expect(r.state.funded).toEqual({ usdc: "0", w0g: (10n * E18).toString() });
    const m2 = mockIo();
    let q = await fundingTick(emptyFundingState(), ctxOf(m2.io, 0));
    q = await fundingTick(q.state, ctxOf(m2.io, 1));
    q = await fundingTick(q.state, ctxOf(m2.io, 2));
    m2.st.receipt = "reverted";
    q = await fundingTick(q.state, ctxOf(m2.io, 3));
    expect([q.action, q.state.funded.usdc]).toEqual(["reverted swap-usdc-w0g", "0"]);
  });
});
