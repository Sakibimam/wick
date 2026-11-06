// Fee-funded funding leg as a resumable state machine: one chain step per cron tick, state persisted by the caller.
// Funds come only from accrued fees above the inventory the Aqua strategy commits; seed inventory is never spent.
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { BASE_CCIP_ROUTER, fundingAbi, SWAP_ROUTER, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER, ZERO_G_SELECTOR } from "./funding.js";
import { USDC, W0G } from "./price.js";

export type FundingStepId = "approve-usdc-swap" | "swap-usdc-w0g" | "approve-w0g-ccip" | "ccip-send" | "await-arrival" | "withdraw-w0g-0g" | "deposit-payment-layer" | "gas-approve-usdc" | "gas-swap-usdc-eth";
export type FundingDecision = { fire: boolean; kind: "fuel" | "gas" | null; reason: string; k: number; unfundedUsdc: string; unfundedW0g: string; unfundedValueUsdc: number; costUsdc: number; thresholdUsdc: number; ccipFeeWei: string; spendableUsdc: string; spendableW0g: string };
export type FundingState = { run: null | { id: string; kind: "fuel" | "gas"; startedAt: number; usdcIn: string; w0gFromFees: string; w0gBridge: string; minOut: string; step: FundingStepId; pending: null | { hash: Hex; chainId: 8453 | 16661; step: FundingStepId; sentAt: number }; zeroGW0gBefore?: string }; funded: { usdc: string; w0g: string }; history: { runId: string; step: FundingStepId; txHash: Hex; chainId: number; time: string; ok: boolean }[]; lastDecision: FundingDecision | null };
export type FundingInput = { accrued: { usdc: bigint; w0g: bigint }; funded: { usdc: bigint; w0g: bigint }; wallet: { usdc: bigint; w0g: bigint; ethWei: bigint }; strategy: { usdc: bigint; w0g: bigint }; mid: number; ethUsd: number; ccipFeeWei: bigint; baseGasPriceWei: bigint; zeroGGasUsdc: number; k?: number; gasTopUpBelowWei: bigint; gasShareBps: number; maxSpendWeiPerRun: bigint };
export type FundingIo = { send(tx: { chainId: 8453 | 16661; to: Address; data: Hex; value: bigint }): Promise<Hex>; receipt(chainId: 8453 | 16661, hash: Hex): Promise<"success" | "reverted" | null>; readAllowance(token: Address, spender: Address): Promise<bigint>; readZeroGW0g(): Promise<bigint>; readZeroGNative(): Promise<bigint>; quoteSwapUsdcToW0g(usdcIn: bigint): Promise<bigint>; quoteSwapUsdcToEth(usdcIn: bigint): Promise<bigint> };
export type FundingCtx = { now: number; decision: Omit<FundingInput, "funded">; io: FundingIo; agent: Address; agentOwner: Address; slippageBps?: number; zeroGGasReserveWei: bigint; arrivalTimeoutMs?: number };

export const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
export const FUEL_GAS_UNITS = 46_000n + 130_000n + 46_000n + 260_000n;
export const GAS_LEG_UNITS = 46_000n + 160_000n;
export const PENDING_TIMEOUT_MS = 20 * 60_000;
const KEEP = 50;
const router02Abi = parseAbi(["function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])", "function unwrapWETH9(uint256 amountMinimum,address recipient) payable"]);
const extraArgs = ("0x181dcf10" + encodeAbiParameters(parseAbiParameters("uint256,bool"), [0n, false]).slice(2)) as Hex;
const max0 = (x: bigint) => (x > 0n ? x : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const weiUsd = (wei: bigint, ethUsd: number) => Number(wei) / 1e18 * ethUsd;

export function emptyFundingState(): FundingState { return { run: null, funded: { usdc: "0", w0g: "0" }, history: [], lastDecision: null }; }

export function decideFunding(i: FundingInput): FundingDecision {
  const k = i.k ?? 3;
  if (!(k > 0) || !(i.mid > 0) || !(i.ethUsd > 0) || i.gasShareBps < 0 || i.gasShareBps > 10_000 || i.ccipFeeWei < 0n || i.baseGasPriceWei < 0n) throw new RangeError("invalid funding input");
  const unfundedUsdc = max0(i.accrued.usdc - i.funded.usdc), unfundedW0g = max0(i.accrued.w0g - i.funded.w0g);
  const spendableUsdc = min(unfundedUsdc, max0(i.wallet.usdc - i.strategy.usdc)), spendableW0g = min(unfundedW0g, max0(i.wallet.w0g - i.strategy.w0g));
  const base = { k, unfundedUsdc: unfundedUsdc.toString(), unfundedW0g: unfundedW0g.toString(), ccipFeeWei: i.ccipFeeWei.toString(), spendableUsdc: spendableUsdc.toString(), spendableW0g: spendableW0g.toString() };
  if (i.wallet.ethWei < i.gasTopUpBelowWei) {
    const share = spendableUsdc * BigInt(i.gasShareBps) / 10_000n, costUsdc = weiUsd(GAS_LEG_UNITS * i.baseGasPriceWei, i.ethUsd), shareValue = Number(share) / 1e6;
    const fire = share > 0n && shareValue >= k * costUsdc;
    return { ...base, fire, kind: fire ? "gas" : null, reason: fire ? "fire_gas" : share === 0n ? "no_fees" : "below_threshold", unfundedValueUsdc: shareValue, costUsdc, thresholdUsdc: k * costUsdc };
  }
  const spendWei = i.ccipFeeWei + FUEL_GAS_UNITS * i.baseGasPriceWei, costUsdc = weiUsd(spendWei, i.ethUsd) + i.zeroGGasUsdc, thresholdUsdc = k * costUsdc;
  const unfundedValueUsdc = Number(spendableUsdc) / 1e6 + Number(spendableW0g) / 1e18 * i.mid;
  const reason = spendableUsdc === 0n && spendableW0g === 0n ? "no_fees" : unfundedValueUsdc < thresholdUsdc ? "below_threshold" : spendWei > i.maxSpendWeiPerRun ? "spend_cap" : i.wallet.ethWei - spendWei < i.gasTopUpBelowWei ? "gas_reserve" : "fire_fuel";
  const fire = reason === "fire_fuel";
  return { ...base, fire, kind: fire ? "fuel" : null, reason, unfundedValueUsdc, costUsdc, thresholdUsdc };
}

const NEXT: Record<FundingStepId, FundingStepId | null> = { "approve-usdc-swap": "swap-usdc-w0g", "swap-usdc-w0g": "approve-w0g-ccip", "approve-w0g-ccip": "ccip-send", "ccip-send": "await-arrival", "await-arrival": "withdraw-w0g-0g", "withdraw-w0g-0g": "deposit-payment-layer", "deposit-payment-layer": null, "gas-approve-usdc": "gas-swap-usdc-eth", "gas-swap-usdc-eth": null };

export async function fundingTick(prev: FundingState, ctx: FundingCtx): Promise<{ state: FundingState; action: string }> {
  const s: FundingState = structuredClone(prev);
  const slip = BigInt(ctx.slippageBps ?? 100), io = ctx.io;
  const log = (step: FundingStepId, txHash: Hex, chainId: number, ok: boolean) => { s.history = [...s.history, { runId: s.run!.id, step, txHash, chainId, time: new Date(ctx.now).toISOString(), ok }].slice(-KEEP); };
  const run = s.run;
  if (run?.pending) {
    const p = run.pending, r = await io.receipt(p.chainId, p.hash);
    if (r === null) {
      if (ctx.now - p.sentAt <= PENDING_TIMEOUT_MS) return { state: s, action: `waiting ${p.step}` };
      log(p.step, p.hash, p.chainId, false); s.run = null; return { state: s, action: "abandoned" };
    }
    log(p.step, p.hash, p.chainId, r === "success");
    if (r === "reverted") { s.run = null; return { state: s, action: `reverted ${p.step}` }; }
    run.pending = null;
    const next = NEXT[p.step];
    if (next) { run.step = next; return { state: s, action: `done ${p.step}` }; }
    s.funded = { usdc: (BigInt(s.funded.usdc) + BigInt(run.usdcIn)).toString(), w0g: (BigInt(s.funded.w0g) + (run.kind === "fuel" ? BigInt(run.w0gFromFees) : 0n)).toString() };
    s.run = null;
    return { state: s, action: `funded ${run.id}` };
  }
  if (!run) {
    const d = decideFunding({ ...ctx.decision, funded: { usdc: BigInt(s.funded.usdc), w0g: BigInt(s.funded.w0g) } });
    s.lastDecision = d;
    if (!d.fire) return { state: s, action: `hold ${d.reason}` };
    const usdcIn = d.kind === "gas" ? BigInt(d.spendableUsdc) * BigInt(ctx.decision.gasShareBps) / 10_000n : BigInt(d.spendableUsdc);
    const w0gFromFees = d.kind === "fuel" ? BigInt(d.spendableW0g) : 0n;
    s.run = { id: `${d.kind}-${ctx.now}`, kind: d.kind!, startedAt: ctx.now, usdcIn: usdcIn.toString(), w0gFromFees: w0gFromFees.toString(), w0gBridge: w0gFromFees.toString(), minOut: "0", step: d.kind === "gas" ? "gas-approve-usdc" : usdcIn > 0n ? "approve-usdc-swap" : "approve-w0g-ccip", pending: null };
  }
  return step(s, ctx, slip);
}

async function step(s: FundingState, ctx: FundingCtx, slip: bigint): Promise<{ state: FundingState; action: string }> {
  const run = s.run!, io = ctx.io, usdcIn = BigInt(run.usdcIn);
  const send = async (chainId: 8453 | 16661, to: Address, data: Hex, value = 0n) => { const hash = await io.send({ chainId, to, data, value }); run.pending = { hash, chainId, step: run.step, sentAt: ctx.now }; return { state: s, action: `sent ${run.step} ${hash}` }; };
  const approve = (token: Address, spender: Address, amount: bigint) => send(8453, token, encodeFunctionData({ abi: fundingAbi.erc20, functionName: "approve", args: [spender, amount] }));
  // Load-balanced RPCs can serve the next call from a node behind the approval block; wait until the allowance is visible.
  const visible = async (token: Address, spender: Address, amount: bigint) => (await io.readAllowance(token, spender)) >= amount;
  switch (run.step) {
    case "approve-usdc-swap": return approve(USDC, SWAP_ROUTER, usdcIn);
    case "swap-usdc-w0g": {
      if (!(await visible(USDC, SWAP_ROUTER, usdcIn))) return { state: s, action: "allowance_not_visible" };
      const minOut = (await io.quoteSwapUsdcToW0g(usdcIn)) * (10_000n - slip) / 10_000n;
      if (minOut <= 0n) { s.run = null; return { state: s, action: "swap_quote_zero" }; }
      run.minOut = minOut.toString(); run.w0gBridge = (BigInt(run.w0gFromFees) + minOut).toString();
      return send(8453, SWAP_ROUTER, encodeFunctionData({ abi: fundingAbi.router, functionName: "exactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, fee: 3000, recipient: ctx.agent, amountIn: usdcIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] }));
    }
    case "approve-w0g-ccip": return approve(W0G, BASE_CCIP_ROUTER, BigInt(run.w0gBridge));
    case "ccip-send": {
      const amount = BigInt(run.w0gBridge);
      if (!(await visible(W0G, BASE_CCIP_ROUTER, amount))) return { state: s, action: "allowance_not_visible" };
      run.zeroGW0gBefore = (await io.readZeroGW0g()).toString();
      const message = { receiver: encodeAbiParameters(parseAbiParameters("address"), [ctx.agent]), data: "0x" as Hex, tokenAmounts: [{ token: W0G, amount }], feeToken: "0x0000000000000000000000000000000000000000" as Address, extraArgs };
      return send(8453, BASE_CCIP_ROUTER, encodeFunctionData({ abi: fundingAbi.router, functionName: "ccipSend", args: [ZERO_G_SELECTOR, message] }), ctx.decision.ccipFeeWei);
    }
    case "await-arrival": {
      if ((await io.readZeroGW0g()) >= BigInt(run.zeroGW0gBefore ?? "0") + BigInt(run.w0gBridge)) { run.step = "withdraw-w0g-0g"; return { state: s, action: "arrived" }; }
      if (ctx.now - run.startedAt > (ctx.arrivalTimeoutMs ?? 3 * 3_600_000)) { s.run = null; return { state: s, action: "abandoned arrival" }; }
      return { state: s, action: "waiting arrival" };
    }
    case "withdraw-w0g-0g": return send(16661, W0G_ZERO_G, encodeFunctionData({ abi: fundingAbi.token, functionName: "withdraw", args: [BigInt(run.w0gBridge)] }));
    case "deposit-payment-layer": {
      const amount = min(BigInt(run.w0gBridge), (await io.readZeroGNative()) - ctx.zeroGGasReserveWei);
      if (amount <= 0n) return { state: s, action: "reserve_short" };
      return send(16661, ZERO_G_PAYMENT_LAYER, encodeFunctionData({ abi: fundingAbi.payment, functionName: "depositFor", args: [ctx.agentOwner] }), amount);
    }
    case "gas-approve-usdc": return approve(USDC, SWAP_ROUTER, usdcIn);
    case "gas-swap-usdc-eth": {
      if (!(await visible(USDC, SWAP_ROUTER, usdcIn))) return { state: s, action: "allowance_not_visible" };
      const minOut = (await io.quoteSwapUsdcToEth(usdcIn)) * (10_000n - slip) / 10_000n;
      if (minOut <= 0n) { s.run = null; return { state: s, action: "swap_quote_zero" }; }
      run.minOut = minOut.toString();
      const swap = encodeFunctionData({ abi: fundingAbi.router, functionName: "exactInputSingle", args: [{ tokenIn: USDC, tokenOut: WETH_BASE, fee: 500, recipient: ADDRESS_THIS, amountIn: usdcIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }] });
      const unwrap = encodeFunctionData({ abi: router02Abi, functionName: "unwrapWETH9", args: [minOut, ctx.agent] });
      return send(8453, SWAP_ROUTER, encodeFunctionData({ abi: router02Abi, functionName: "multicall", args: [BigInt(Math.floor(ctx.now / 1000) + 600), [swap, unwrap]] }));
    }
  }
}
