// Fee-funded funding leg as a resumable state machine: one chain step per cron tick, state persisted by the caller.
// Funds come only from accrued fees above the inventory the Aqua strategy commits; seed inventory is never spent.
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { BASE_CCIP_ROUTER, fundingAbi, SWAP_ROUTER, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER, ZERO_G_SELECTOR } from "./funding.js";
import { USDC, W0G } from "./price.js";

export type HarvestStepId = "harvest-dock" | "harvest-approve-w0g" | "harvest-approve-usdc" | "harvest-ship" | "harvest-set-order";
export type FundingStepId = "approve-usdc-swap" | "swap-usdc-w0g" | "approve-w0g-ccip" | "ccip-send" | "await-arrival" | "withdraw-w0g-0g" | "deposit-payment-layer" | "gas-approve-usdc" | "gas-swap-usdc-eth" | HarvestStepId;
export type FundingDecision = { fire: boolean; kind: "fuel" | "gas" | null; reason: string; k: number; unfundedUsdc: string; unfundedW0g: string; unfundedValueUsdc: number; costUsdc: number; thresholdUsdc: number; ccipFeeWei: string; spendableUsdc: string; spendableW0g: string };
/** The SwapVM order as stored and served: traits as a 32-byte hex word. */
export type OrderJson = { maker: Address; traits: Hex; data: Hex };
/** The Aqua strategy the maker runs now, and every strategy hash it replaced, so fill history survives a re-ship. */
export type LiveOrder = { order: OrderJson; hash: Hex; amounts: { w0g: string; usdc: string }; shipTx: Hex | null; shippedAt: string | null; past: Hex[] };
export type Pair2 = { w0g: string; usdc: string };
export type HarvestRun = { from: Hex; to: Hex; order: OrderJson; inventory: Pair2; released: Pair2; docked: boolean; shipped: boolean; attempts: number; txs: Partial<Record<HarvestStepId, Hex>> };
export type HarvestDecision = { fire: boolean; reason: string; fees: Pair2; released: Pair2; inventory: Pair2; commitment: Pair2; valueUsdc: number; costUsdc: number; costWei: string; thresholdUsdc: number };
export type FundingRun = { id: string; kind: "fuel" | "gas" | "harvest"; startedAt: number; usdcIn: string; w0gFromFees: string; w0gBridge: string; minOut: string; step: FundingStepId; pending: null | { hash: Hex; chainId: 8453 | 16661; step: FundingStepId; sentAt: number }; zeroGW0gBefore?: string; harvest?: HarvestRun };
export type FundingState = { run: null | FundingRun; funded: { usdc: string; w0g: string }; history: { runId: string; step: FundingStepId; txHash: Hex; chainId: number; time: string; ok: boolean }[]; lastDecision: FundingDecision | null; live?: LiveOrder; lastHarvest?: (HarvestRun & { id: string; completedAt: string }) | null; lastHarvestDecision?: HarvestDecision | null };
export type FundingInput = { accrued: { usdc: bigint; w0g: bigint }; funded: { usdc: bigint; w0g: bigint }; wallet: { usdc: bigint; w0g: bigint; ethWei: bigint }; strategy: { usdc: bigint; w0g: bigint }; mid: number; ethUsd: number; ccipFeeWei: bigint; baseGasPriceWei: bigint; zeroGGasUsdc: number; k?: number; gasTopUpBelowWei: bigint; gasShareBps: number; maxSpendWeiPerRun: bigint };
export type FundingIo = { send(tx: { chainId: 8453 | 16661; to: Address; data: Hex; value: bigint }): Promise<Hex>; receipt(chainId: 8453 | 16661, hash: Hex): Promise<"success" | "reverted" | null>; readAllowance(token: Address, spender: Address): Promise<bigint>; readZeroGW0g(): Promise<bigint>; readZeroGNative(): Promise<bigint>; quoteSwapUsdcToW0g(usdcIn: bigint): Promise<bigint>; quoteSwapUsdcToEth(usdcIn: bigint): Promise<bigint> };
/** tokensCount per Aqua balance slot: 0 never shipped, 2 live (W0G + USDC), 0xff docked. */
export type AquaSlot = { w0g: bigint; usdc: bigint; tokensCount: number };
export type HarvestIo = { aquaSlot(strategyHash: Hex): Promise<AquaSlot>; hookOrderHash(): Promise<Hex> };
/** commitment is null while the live strategy is docked mid-harvest (Aqua's safeBalances reverts on a docked hash). */
export type HarvestCtx = { live: LiveOrder; commitment: { w0g: bigint; usdc: bigint } | null; fees: { w0g: bigint; usdc: bigint }; hook: Address; gasFloorWei: bigint; io: HarvestIo };
export type FundingCtx = { now: number; decision: Omit<FundingInput, "funded">; io: FundingIo; agent: Address; agentOwner: Address; slippageBps?: number; zeroGGasReserveWei: bigint; arrivalTimeoutMs?: number; harvest?: HarvestCtx };

export const WETH_BASE: Address = "0x4200000000000000000000000000000000000006";
export const ADDRESS_THIS: Address = "0x0000000000000000000000000000000000000002";
export const FUEL_GAS_UNITS = 46_000n + 130_000n + 46_000n + 260_000n;
export const CCIP_SEND_GAS_UNITS = 260_000n;
export const GAS_LEG_UNITS = 46_000n + 160_000n;
export const PENDING_TIMEOUT_MS = 20 * 60_000;
const KEEP = 50;
const router02Abi = parseAbi(["function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])", "function unwrapWETH9(uint256 amountMinimum,address recipient) payable"]);
const extraArgs = ("0x181dcf10" + encodeAbiParameters(parseAbiParameters("uint256,bool"), [0n, false]).slice(2)) as Hex;
const max0 = (x: bigint) => (x > 0n ? x : 0n);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const weiUsd = (wei: bigint, ethUsd: number) => Number(wei) / 1e18 * ethUsd;

export function emptyFundingState(): FundingState { return { run: null, funded: { usdc: "0", w0g: "0" }, history: [], lastDecision: null }; }

export const AQUA: Address = "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a";
export const AQUA_SWAPVM_ROUTER: Address = "0x111111338c5091E8440b67B168bAe16a668AC0De";
const orderTuple = "(address maker,uint256 traits,bytes data)";
export const harvestAbi = parseAbi([
  "function dock(address app,bytes32 strategyHash,address[] tokens)",
  "function ship(address app,bytes strategy,address[] tokens,uint256[] amounts) returns (bytes32)",
  "function rawBalances(address maker,address app,bytes32 strategyHash,address token) view returns (uint248 balance,uint8 tokensCount)",
  `function setOrder(${orderTuple} order)`,
  "function orderHash() view returns (bytes32)",
]);
/** dock + 2 approves + ship + setOrder measured 241,797 gas on a Base fork (agent/scripts/fork-harvest.ts), with headroom. */
export const HARVEST_GAS_UNITS = 300_000n;
const MAX_PRE_DOCK_ATTEMPTS = 3;
const SALT_OP = "1408";
/** Aqua's strategy hash: keccak256(abi.encode(order)), the same value AquaSwapVMRouter.hash(order) returns. */
export const strategyHashOf = (o: OrderJson) => keccak256(encodeAbiParameters(parseAbiParameters(`${orderTuple}`), [{ maker: o.maker, traits: BigInt(o.traits), data: o.data }]));
/** Aqua strategies are immutable per hash and a docked hash can never ship again, so the re-ship carries a SwapVM salt
 *  instruction (opcode 0x14, a no-op with an 8-byte argument) ahead of the unchanged program: same extruction, fee and band. */
export function saltedOrder(o: OrderJson, salt: bigint): OrderJson {
  const body = o.data.slice(2), program = body.startsWith(SALT_OP) ? body.slice(4 + 16) : body;
  return { ...o, data: `0x${SALT_OP}${(salt & 0xffff_ffff_ffff_ffffn).toString(16).padStart(16, "0")}${program}` as Hex };
}

/** HARVEST: swap fees sit inside the strategy's virtual balance, where the funding machine cannot spend them. Docking and
 *  re-shipping at (commitment - fees) moves exactly the fees to wallet spare. The new inventory never exceeds the wallet and
 *  never drops below (commitment - fees) unless the wallet itself holds less, so harvest frees fees and never seed. */
export function decideHarvest(i: { commitment: { w0g: bigint; usdc: bigint }; fees: { w0g: bigint; usdc: bigint }; wallet: { w0g: bigint; usdc: bigint; ethWei: bigint }; mid: number; ethUsd: number; baseGasPriceWei: bigint; k: number; gasFloorWei: bigint; maxSpendWeiPerRun: bigint }, fundingFiresAfter?: (strategy: { w0g: bigint; usdc: bigint }) => boolean): HarvestDecision {
  if (!(i.k > 0) || !(i.mid > 0) || !(i.ethUsd > 0) || i.baseGasPriceWei < 0n || i.fees.w0g < 0n || i.fees.usdc < 0n) throw new RangeError("invalid harvest input");
  const released = { w0g: min(i.fees.w0g, i.commitment.w0g), usdc: min(i.fees.usdc, i.commitment.usdc) };
  const inventory = { w0g: min(i.wallet.w0g, i.commitment.w0g - released.w0g), usdc: min(i.wallet.usdc, i.commitment.usdc - released.usdc) };
  const costWei = HARVEST_GAS_UNITS * i.baseGasPriceWei, costUsdc = weiUsd(costWei, i.ethUsd), thresholdUsdc = i.k * costUsdc;
  const valueUsdc = Number(released.usdc) / 1e6 + Number(released.w0g) / 1e18 * i.mid;
  const s = (p: { w0g: bigint; usdc: bigint }) => ({ w0g: p.w0g.toString(), usdc: p.usdc.toString() });
  const base = { fees: s(i.fees), released: s(released), inventory: s(inventory), commitment: s(i.commitment), valueUsdc, costUsdc, costWei: costWei.toString(), thresholdUsdc };
  const reason = released.w0g === 0n && released.usdc === 0n ? "no_fees"
    : costWei > i.maxSpendWeiPerRun ? "spend_cap"
    : i.wallet.ethWei - costWei < i.gasFloorWei ? "gas_floor"
    : valueUsdc >= thresholdUsdc ? "fire"
    : valueUsdc >= costUsdc && fundingFiresAfter?.(inventory) ? "fire_before_funding" : "below_threshold";
  return { ...base, fire: reason.startsWith("fire"), reason };
}

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

const NEXT: Record<FundingStepId, FundingStepId | null> = { "approve-usdc-swap": "swap-usdc-w0g", "swap-usdc-w0g": "approve-w0g-ccip", "approve-w0g-ccip": "ccip-send", "ccip-send": "await-arrival", "await-arrival": "withdraw-w0g-0g", "withdraw-w0g-0g": "deposit-payment-layer", "deposit-payment-layer": null, "gas-approve-usdc": "gas-swap-usdc-eth", "gas-swap-usdc-eth": null, "harvest-dock": "harvest-approve-w0g", "harvest-approve-w0g": "harvest-approve-usdc", "harvest-approve-usdc": "harvest-ship", "harvest-ship": "harvest-set-order", "harvest-set-order": null };

/** Fees are credited as funded at the step that spends them (the USDC swap, the W0G bridge send), not at run end, so a run
 *  abandoned after either step has already counted what it spent. */
function credit(s: FundingState, run: FundingRun, step: FundingStepId) {
  const usdc = step === "swap-usdc-w0g" || step === "gas-swap-usdc-eth" ? BigInt(run.usdcIn) : 0n, w0g = step === "ccip-send" && run.kind === "fuel" ? BigInt(run.w0gFromFees) : 0n;
  if (usdc || w0g) s.funded = { usdc: (BigInt(s.funded.usdc) + usdc).toString(), w0g: (BigInt(s.funded.w0g) + w0g).toString() };
}

export async function fundingTick(prev: FundingState, ctx: FundingCtx): Promise<{ state: FundingState; action: string }> {
  const s: FundingState = structuredClone(prev);
  const slip = BigInt(ctx.slippageBps ?? 100), io = ctx.io;
  const log = (step: FundingStepId, txHash: Hex, chainId: number, ok: boolean) => { s.history = [...s.history, { runId: s.run!.id, step, txHash, chainId, time: new Date(ctx.now).toISOString(), ok }].slice(-KEEP); };
  const run = s.run;
  if (run?.pending) {
    const p = run.pending, r = await io.receipt(p.chainId, p.hash);
    if (r === null) {
      if (ctx.now - p.sentAt <= PENDING_TIMEOUT_MS) return { state: s, action: `waiting ${p.step}` };
      log(p.step, p.hash, p.chainId, false);
      if (run.harvest) { run.harvest.txs[p.step as HarvestStepId] ??= p.hash; return harvestRetry(s, ctx, `timeout ${p.step}`); }
      // A spend step that timed out may still have mined: credit it, so the same fees are never spent twice.
      credit(s, run, p.step);
      s.run = null; return { state: s, action: "abandoned" };
    }
    log(p.step, p.hash, p.chainId, r === "success");
    if (r === "reverted") { if (run.harvest) return harvestRetry(s, ctx, `reverted ${p.step}`); s.run = null; return { state: s, action: `reverted ${p.step}` }; }
    run.pending = null;
    if (!run.harvest) credit(s, run, p.step);
    if (run.harvest) { run.harvest.txs[p.step as HarvestStepId] = p.hash; return harvestDone(s, ctx, p.step as HarvestStepId); }
    const next = NEXT[p.step];
    if (next) { run.step = next; return { state: s, action: `done ${p.step}` }; }
    s.run = null;
    return { state: s, action: `funded ${run.id}` };
  }
  if (run?.harvest) return harvestStep(s, ctx);
  if (!run) {
    const funded = { usdc: BigInt(s.funded.usdc), w0g: BigInt(s.funded.w0g) };
    const h = ctx.harvest;
    // A docked live strategy outside a harvest reads as zero commitment, which would make seed inventory look spare.
    if (h && !h.commitment) return { state: s, action: "hold strategy_docked" };
    if (h?.commitment) {
      const dec = ctx.decision;
      const hd = decideHarvest({ commitment: h.commitment, fees: h.fees, wallet: dec.wallet, mid: dec.mid, ethUsd: dec.ethUsd, baseGasPriceWei: dec.baseGasPriceWei, k: dec.k ?? 3, gasFloorWei: h.gasFloorWei, maxSpendWeiPerRun: dec.maxSpendWeiPerRun }, (strategy) => decideFunding({ ...dec, strategy, funded }).fire);
      s.lastHarvestDecision = hd;
      if (hd.fire) {
        const order = saltedOrder(h.live.order, BigInt(Math.floor(ctx.now / 1000)));
        s.run = { id: `harvest-${ctx.now}`, kind: "harvest", startedAt: ctx.now, usdcIn: "0", w0gFromFees: "0", w0gBridge: "0", minOut: "0", step: "harvest-dock", pending: null, harvest: { from: h.live.hash, to: strategyHashOf(order), order, inventory: hd.inventory, released: hd.released, docked: false, shipped: false, attempts: 0, txs: {} } };
        return harvestStep(s, ctx);
      }
    }
    const d = decideFunding({ ...ctx.decision, funded });
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
      // CCIP keeps all of msg.value: send only a read fee inside the per-run cap that leaves the gas top-up line intact.
      const fee = ctx.decision.ccipFeeWei, gas = CCIP_SEND_GAS_UNITS * ctx.decision.baseGasPriceWei;
      if (fee <= 0n || fee > ctx.decision.maxSpendWeiPerRun) return { state: s, action: "hold ccip_fee_cap" };
      if (ctx.decision.wallet.ethWei - fee - gas < ctx.decision.gasTopUpBelowWei) return { state: s, action: "hold ccip_fee_gas_reserve" };
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
    default: throw new Error(`step ${run.step} is not a funding step`);
  }
}

const pair2 = (p: { w0g: bigint; usdc: bigint }): Pair2 => ({ w0g: p.w0g.toString(), usdc: p.usdc.toString() });

/** A harvest step's receipt succeeded: record what it changed and move on. One chain write per tick. */
function harvestDone(s: FundingState, ctx: FundingCtx, step: HarvestStepId): { state: FundingState; action: string } {
  const run = s.run!, h = run.harvest!;
  if (step === "harvest-dock") h.docked = true;
  if (step === "harvest-ship") {
    h.shipped = true;
    const prev = s.live ?? ctx.harvest?.live;
    s.live = { order: h.order, hash: h.to, amounts: h.inventory, shipTx: h.txs["harvest-ship"] ?? null, shippedAt: new Date(ctx.now).toISOString(), past: [...new Set([...(prev?.past ?? []), h.from])] };
  }
  const next = NEXT[step];
  if (next) { run.step = next; return { state: s, action: `done ${step}` }; }
  s.lastHarvest = { ...h, id: run.id, completedAt: new Date(ctx.now).toISOString() };
  s.run = null;
  return { state: s, action: `harvested ${run.id}` };
}

/** A harvest never abandons once the strategy is docked: the docked inventory must be re-shipped, so the step is retried
 *  next tick, where its on-chain post-condition is checked before anything is sent again. */
async function harvestRetry(s: FundingState, ctx: FundingCtx, why: string): Promise<{ state: FundingState; action: string }> {
  const run = s.run!, h = run.harvest!;
  run.pending = null; h.attempts++;
  if (!h.docked && ctx.harvest && (await ctx.harvest.io.aquaSlot(h.from)).tokensCount === 0xff) return harvestDone(s, ctx, "harvest-dock");
  if (!h.docked && h.attempts >= MAX_PRE_DOCK_ATTEMPTS) { s.run = null; return { state: s, action: `harvest abandoned ${why}` }; }
  return { state: s, action: `harvest retry ${why}` };
}

/** Sends the current harvest step, unless the chain already shows its effect (a lost receipt, a tx mined after a timeout,
 *  or state saved before the reply), in which case it advances without sending. */
async function harvestStep(s: FundingState, ctx: FundingCtx): Promise<{ state: FundingState; action: string }> {
  const run = s.run!, h = run.harvest!, hc = ctx.harvest, io = ctx.io;
  if (!hc) return { state: s, action: "harvest_offline" };
  // A send that throws may still have broadcast: keep the run (and its planned inventory) so the next tick checks the chain.
  const send = async (to: Address, data: Hex) => {
    let hash: Hex;
    try { hash = await io.send({ chainId: 8453, to, data, value: 0n }); }
    catch (e) { h.attempts++; if (!h.docked && h.attempts >= MAX_PRE_DOCK_ATTEMPTS && (await hc.io.aquaSlot(h.from)).tokensCount === 2) s.run = null; return { state: s, action: `harvest send_failed ${run.step}: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]!.slice(0, 160)}` }; }
    run.pending = { hash, chainId: 8453, step: run.step, sentAt: ctx.now }; return { state: s, action: `sent ${run.step} ${hash}` };
  };
  const approve = (token: Address, amount: bigint) => send(token, encodeFunctionData({ abi: fundingAbi.erc20, functionName: "approve", args: [AQUA, amount] }));
  const skip = (step: HarvestStepId) => { const r = harvestDone(s, ctx, step); return r.action.startsWith("harvested") ? r : null; };
  for (let i = 0; i < 5 && s.run; i++) {
    const inv = { w0g: BigInt(h.inventory.w0g), usdc: BigInt(h.inventory.usdc) };
    switch (run.step) {
      case "harvest-dock":
        if ((await hc.io.aquaSlot(h.from)).tokensCount === 0xff) { skip("harvest-dock"); continue; }
        return send(AQUA, encodeFunctionData({ abi: harvestAbi, functionName: "dock", args: [AQUA_SWAPVM_ROUTER, h.from, [W0G, USDC]] }));
      case "harvest-approve-w0g":
        if ((await io.readAllowance(W0G, AQUA)) >= inv.w0g) { skip("harvest-approve-w0g"); continue; }
        return approve(W0G, inv.w0g);
      case "harvest-approve-usdc":
        if ((await io.readAllowance(USDC, AQUA)) >= inv.usdc) { skip("harvest-approve-usdc"); continue; }
        return approve(USDC, inv.usdc);
      case "harvest-ship": {
        if ((await hc.io.aquaSlot(h.to)).tokensCount !== 0) { skip("harvest-ship"); continue; }
        // The wallet is shared with other work: ship no more than it holds at this tick, never the plan's figure blindly.
        const w = ctx.decision.wallet, amt = { w0g: min(inv.w0g, w.w0g), usdc: min(inv.usdc, w.usdc) };
        h.inventory = pair2(amt);
        const [aw, au] = await Promise.all([io.readAllowance(W0G, AQUA), io.readAllowance(USDC, AQUA)]);
        if (aw < amt.w0g || au < amt.usdc) return { state: s, action: "allowance_not_visible" };
        const strategy = encodeAbiParameters(parseAbiParameters(orderTuple), [{ maker: h.order.maker, traits: BigInt(h.order.traits), data: h.order.data }]);
        return send(AQUA, encodeFunctionData({ abi: harvestAbi, functionName: "ship", args: [AQUA_SWAPVM_ROUTER, strategy, [W0G, USDC], [amt.w0g, amt.usdc]] }));
      }
      case "harvest-set-order": {
        if ((await hc.io.hookOrderHash()).toLowerCase() === h.to.toLowerCase()) { const r = skip("harvest-set-order"); if (r) return r; continue; }
        return send(hc.hook, encodeFunctionData({ abi: harvestAbi, functionName: "setOrder", args: [{ maker: h.order.maker, traits: BigInt(h.order.traits), data: h.order.data }] }));
      }
      default: throw new Error(`step ${run.step} is not a harvest step`);
    }
  }
  return { state: s, action: s.run ? `harvest at ${run.step}` : `harvested ${run.id}` };
}
