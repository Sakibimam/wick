import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createPublicClient, defineChain, formatUnits, http, keccak256, parseAbi, parseAbiItem, parseUnits, toHex, type Address, type Chain, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { askBrain } from "./brain.js";
import { decideBudget, deviationBps, DEFAULT_BUDGET_CONFIG, type BudgetInput } from "./budget.js";
import { quoteUsdcForW0g, readMarket, USDC, W0G } from "./price.js";
import { ZERO_G_PAYMENT_LAYER, W0G_ZERO_G, buildFundingPlan, quoteCcipFee, fundingAbi } from "./funding.js";
import { localSigner, signQuote, type Quote, unlockedSigner } from "./signer.js";
import { boardAbi, post } from "./poster.js";
import { AQUA_ROUTER, type ShippedOrder } from "./taker.js";
import { createStatusServer, type RuntimeState } from "./status.js";

const ZG = defineChain({ id: 16661, name: "0G Mainnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [process.env.ZG_RPC_URL || "https://evmrpc.0g.ai"] } } });
const board = process.env.BOARD_ADDRESS as Address;
const maker = process.env.MAKER_ADDRESS as Address;
const boardAbiRuntime = [...boardAbi, ...parseAbi(["function getAgent(address) view returns (address)", "function lastNonce(address) view returns (uint64)"])];
const baseClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com") });
const zeroClient = createPublicClient({ chain: ZG, transport: http(process.env.ZG_RPC_URL || "https://evmrpc.0g.ai") });
const statePath = process.env.STATE_PATH || "./state/upkeep.json";
const requiredAddress = (v: string | undefined, name: string) => { if (!v || !/^0x[\da-fA-F]{40}$/.test(v)) throw new Error(`${name} must be a valid address`); return v as Address; };
const runtimeAddress = process.env.AGENT_ADDRESS as Address;
const makerAddress = maker;
const boardAddress = board;
const orderFromEnv = (): ShippedOrder => {
  const raw = process.env.ORDER_JSON;
  if (!raw) throw new Error("ORDER_JSON is required (order JSON printed by ShipStrategy.s.sol)");
  const v = JSON.parse(raw);
  if (!v.maker || !v.traits || !v.data || !/^0x[\da-fA-F]{64}$/.test(v.traits) || !/^0x([\da-fA-F]{2})*$/.test(v.data)) throw new Error("ORDER_JSON must contain maker, traits, and data from ShipStrategy");
  return { maker: v.maker, traits: BigInt(v.traits), data: v.data } as ShippedOrder;
};
export type Persisted = RuntimeState & { recentMids: number[]; lastMid: number | null; quoteTimes: Record<string, number>; lastNonce: string; lastComputeBalanceWei: string; spentTodayWei: string; day: string; lastFillBlock: string; pendingFunding?: { bridgeAmount: string; usdcFees: string; ccipHash: Hex; zeroGBalanceBefore: string } };
function initial(): Persisted { return { agent: requiredAddress(runtimeAddress, "AGENT_ADDRESS"), maker: requiredAddress(makerAddress, "MAKER_ADDRESS"), chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: null, quotes: [], budget: { tier: "PAUSED", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: process.env.SPEND_CAP_PER_DAY_WEI || "0", reason: "not_started" }, fees: { accruedUsdc: "0", accruedW0g: "0" }, funding: [], inferences: [], order: orderFromEnv(), recentMids: [], lastMid: null, quoteTimes: {}, lastNonce: "0", lastComputeBalanceWei: "", spentTodayWei: "0", day: "", lastFillBlock: "" }; }
export async function loadState(): Promise<Persisted> {
  try {
    const saved = JSON.parse(await readFile(statePath, "utf8"));
    return { ...saved, agent: saved.agent ?? requiredAddress(runtimeAddress, "AGENT_ADDRESS"), maker: saved.maker ?? requiredAddress(makerAddress, "MAKER_ADDRESS"), order: saved.order ? { ...saved.order, traits: BigInt(saved.order.traits) } : orderFromEnv() } as Persisted;
  } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; return initial(); }
}
// Write then rename, so the status server never reads a half-written file.
async function save(s: Persisted) { await mkdir(dirname(statePath), { recursive: true }); const tmp = `${statePath}.tmp`; await writeFile(tmp, JSON.stringify(s, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { mode: 0o600 }); await rename(tmp, statePath); }
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const paymentBalance = (client: PublicClient<any, any>, who: Address) => client.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [who] });
// SwapVM.sol declares Swapped with no indexed fields, so the maker filter runs on decoded args, not topics.
const swapEvent = parseAbiItem("event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)");
async function recordFees(s: Persisted) {
  const latest = await baseClient.getBlockNumber();
  if (!s.lastFillBlock) { s.lastFillBlock = latest.toString(); return; }
  let from = BigInt(s.lastFillBlock) + 1n;
  while (from <= latest) {
    const to = from + 4_999n < latest ? from + 4_999n : latest;
    const logs = (await baseClient.getLogs({ address: AQUA_ROUTER, event: swapEvent, fromBlock: from, toBlock: to })).filter(l => l.args.maker?.toLowerCase() === makerAddress.toLowerCase());
    for (const log of logs) {
      const q = [...s.quotes].filter(x => x.tokenIn.toLowerCase() === log.args.tokenIn!.toLowerCase() && x.tokenOut.toLowerCase() === log.args.tokenOut!.toLowerCase() && BigInt(x.postedBlock ?? 0) <= log.blockNumber!).sort((a, b) => BigInt(a.postedBlock ?? 0) < BigInt(b.postedBlock ?? 0) ? 1 : -1)[0];
      if (!q) continue;
      const gross = log.args.amountIn! * BigInt(q.rateE18) / 10n ** 18n;
      const fee = gross > log.args.amountOut! ? gross - log.args.amountOut! : 0n;
      if (log.args.tokenOut!.toLowerCase() === USDC.toLowerCase()) s.fees.accruedUsdc = (BigInt(s.fees.accruedUsdc) + fee).toString();
      if (log.args.tokenOut!.toLowerCase() === W0G.toLowerCase()) s.fees.accruedW0g = (BigInt(s.fees.accruedW0g) + fee).toString();
    }
    s.lastFillBlock = to.toString(); from = to + 1n;
  }
}
async function fundPaymentLayer(s: Persisted, mid: number) {
  const usdcFees = BigInt(s.fees.accruedUsdc), w0gFees = BigInt(s.fees.accruedW0g);
  const threshold = parseUnits(process.env.FUNDING_THRESHOLD_USDC || "10", 6);
  const priceE18 = BigInt(Math.round(mid * 1e18));
  const accruedValueUsdc = usdcFees + w0gFees * priceE18 / 10n ** 30n;
  if (!s.pendingFunding && !(await thresholdTriggered(accruedValueUsdc, threshold))) return;
  if (runtimeAddress.toLowerCase() !== makerAddress.toLowerCase()) throw new Error("fee funding requires the agent signer to control the maker fee inventory");
  const gasReserve = BigInt(process.env.ZG_GAS_RESERVE_WEI || "10000000000000000");
  const { wallet } = await signerFor();
  const planFor = (amount: bigint, usdc: bigint) => buildFundingPlan({ agent: runtimeAddress, agentOwner: runtimeAddress, usdcAmountIn: usdc || 1n, w0gAmountOut: amount, slippageBps: 0, ccipFeeWei: 0n, nativeGasReserveWei: gasReserve });
  const writeStep = async (step: ReturnType<typeof buildFundingPlan>["steps"][number], client: PublicClient<any, any>, signer: any) => {
    const hash = await signer.sendTransaction({ account: signer.account!, to: step.to, data: step.data, value: step.value, chain: signer.chain! });
    const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 20, retryDelay: 2_000 });
    if (receipt.status !== "success") throw new Error(`funding step ${step.id} reverted: ${hash}`);
    s.funding.push({ step: step.id, txHash: hash, chainId: step.chainId, time: new Date().toISOString() }); await save(s); return receipt;
  };
  if (!s.pendingFunding) {
    if (usdcFees <= 0n) throw new Error("fee funding threshold reached without an accrued USDC share to swap");
    const before = await baseClient.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [runtimeAddress] });
    const expected = await quoteUsdcForW0g(baseClient, { usdcAmountIn: usdcFees, fee: 3000 });
    const swapPlan = planFor(expected.amountOut, usdcFees);
    await writeStep(swapPlan.steps[0]!, baseClient, wallet); await writeStep(swapPlan.steps[1]!, baseClient, wallet);
    const afterSwap = await baseClient.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [runtimeAddress] });
    const bridgeAmount = afterSwap - before + w0gFees;
    if (bridgeAmount <= gasReserve) throw new Error("funding output is below the native 0G gas reserve");
    const fee = await quoteCcipFee(baseClient, { agent: runtimeAddress, w0gAmount: bridgeAmount });
    const bridgePlan = buildFundingPlan({ agent: runtimeAddress, agentOwner: runtimeAddress, usdcAmountIn: usdcFees, w0gAmountOut: bridgeAmount, slippageBps: 0, ccipFeeWei: fee, nativeGasReserveWei: gasReserve });
    await writeStep(bridgePlan.steps[2]!, baseClient, wallet);
    const zeroGBalanceBefore = await zeroClient.readContract({ address: W0G_ZERO_G, abi: tokenAbi, functionName: "balanceOf", args: [runtimeAddress] });
    const ccipReceipt = await writeStep(bridgePlan.steps[3]!, baseClient, wallet);
    s.pendingFunding = { bridgeAmount: bridgeAmount.toString(), usdcFees: usdcFees.toString(), ccipHash: ccipReceipt.transactionHash, zeroGBalanceBefore: zeroGBalanceBefore.toString() };
    await save(s);
  }
  const bridgeAmount = BigInt(s.pendingFunding.bridgeAmount);
  const bridgePlan = planFor(bridgeAmount, BigInt(s.pendingFunding.usdcFees));
  const { wallet: zeroWallet } = await signerFor(true);
  const w0gBefore = BigInt(s.pendingFunding.zeroGBalanceBefore);
  const deadline = Date.now() + Number(process.env.CCIP_TIMEOUT_MS || "1200000");
  let received = 0n;
  while (Date.now() < deadline) { const now = await zeroClient.readContract({ address: W0G_ZERO_G, abi: tokenAbi, functionName: "balanceOf", args: [runtimeAddress] }); received = now - w0gBefore; if (received >= bridgeAmount) break; await Bun.sleep(10_000); }
  if (received < bridgeAmount) throw new Error(`CCIP delivery timed out after ${process.env.CCIP_TIMEOUT_MS || "1200000"}ms`);
  await writeStep(bridgePlan.steps[4]!, zeroClient, zeroWallet); await writeStep(bridgePlan.steps[5]!, zeroClient, zeroWallet);
  s.fees.accruedUsdc = "0"; s.fees.accruedW0g = "0"; delete s.pendingFunding; await save(s);
}
export function directionalRates(price: bigint, spread: number) {
  const w0gToUsdc = price * 1_000_000n / 10n ** 18n * BigInt(10000 - spread) / 10000n;
  const usdcToW0g = 10n ** 48n * BigInt(10000 - spread) / (price * BigInt(10000));
  return { w0gToUsdc, usdcToW0g };
}
async function signerFor(zeroG = false) {
  const chain: Chain = zeroG ? ZG : base;
  if (process.env.AGENT_PK) {
    const signer = localSigner(process.env.AGENT_PK, chain);
    if (signer.account.address.toLowerCase() !== runtimeAddress.toLowerCase()) throw new Error("AGENT_PK does not match AGENT_ADDRESS");
    return { ...signer, mode: "local" as const };
  }
  return { ...unlockedSigner(zeroG ? process.env.ZG_RPC_URL || "https://evmrpc.0g.ai" : process.env.BASE_RPC_URL || "http://127.0.0.1:8545", runtimeAddress, chain), mode: "unlocked" as const };
}
export async function runTick(s: Persisted, now = Date.now()) {
  const market = await readMarket(baseClient); const balance = await paymentBalance(zeroClient, runtimeAddress);
  await recordFees(s);
  const day = new Date(now).toISOString().slice(0, 10);
  if (s.day !== day) { s.day = day; s.spentTodayWei = "0"; s.lastComputeBalanceWei = balance.toString(); }
  else {
    const previousBalance = s.lastComputeBalanceWei ? BigInt(s.lastComputeBalanceWei) : balance;
    if (previousBalance > balance) s.spentTodayWei = (BigInt(s.spentTodayWei || "0") + previousBalance - balance).toString();
  }
  s.lastComputeBalanceWei = balance.toString();
  const spent = BigInt(s.spentTodayWei || "0");
  const elapsed = s.lastMid === null ? null : now - (s.quoteTimes.mid ?? now);
  const deviation = s.lastMid === null ? 0 : deviationBps(s.lastMid, market.mid);
  const cap = BigInt(process.env.SPEND_CAP_PER_DAY_WEI || "1000000000000000000");
  const decision = decideBudget({ computeBalanceWei: balance, spendCapPerDayWei: cap, spentTodayWei: spent, priceDeviationBps: deviation, lastQuoteAgeMs: elapsed }, DEFAULT_BUDGET_CONFIG);
  s.fundingThresholdUsdc = process.env.FUNDING_THRESHOLD_USDC || "10";
  s.mid = market.mid; s.budget = { tier: decision.tier, model: decision.model, computeBalanceWei: balance.toString(), spentTodayWei: spent.toString(), spendCapPerDayWei: cap.toString(), reason: decision.reason };
  s.recentMids = [...s.recentMids.slice(-19), market.mid];
  if (shouldRunInference(decision.tier, decision.requote)) {
    const [wbal, ubal] = await Promise.all([baseClient.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [makerAddress] }), baseClient.readContract({ address: USDC, abi: tokenAbi, functionName: "balanceOf", args: [makerAddress] })]);
    const result = await askBrain({ mid: market.mid, recentMids: s.recentMids, inventory: { w0g: Number(formatUnits(wbal, 18)), usdc: Number(formatUnits(ubal, 6)) }, budgetTier: decision.tier });
    const time = new Date().toISOString();
    const tokenCost = process.env.INFERENCE_COST_PER_TOKEN_WEI;
    s.inferences.push({ requestId: result.requestId, model: result.model, tokens: result.tokens, costWei: result.tokens === null || !tokenCost ? null : (BigInt(result.tokens) * BigInt(tokenCost)).toString(), time });
    const [agentOnBoard, nonce] = await Promise.all([baseClient.readContract({ address: boardAddress, abi: boardAbiRuntime, functionName: "getAgent", args: [makerAddress] }), baseClient.readContract({ address: boardAddress, abi: boardAbiRuntime, functionName: "lastNonce", args: [makerAddress] })]);
    if (agentOnBoard.toLowerCase() !== runtimeAddress.toLowerCase()) throw new Error("AGENT_ADDRESS is not the registered board agent");
    const { wallet } = await signerFor(); let next = BigInt(nonce);
    const rates = directionalRates(result.rateE18, result.spreadBps);
    for (const [tokenIn, tokenOut, rate] of [[USDC, W0G, rates.usdcToW0g], [W0G, USDC, rates.w0gToUsdc]] as const) {
      next++; const q: Quote = { maker: makerAddress, tokenIn, tokenOut, rateE18: rate, expiry: BigInt(Math.floor(now / 1000) + Number(process.env.QUOTE_TTL_SECONDS || "3600")), nonce: next, inferenceId: keccak256(toHex(result.requestId + tokenIn + tokenOut)) };
      const sig = await signQuote(wallet, 8453, boardAddress, q); const sent = await post(baseClient, wallet, boardAddress, q, sig);
      s.quotes.push({ tokenIn, tokenOut, rateE18: rate.toString(), expiry: q.expiry.toString(), inferenceId: q.inferenceId, requestId: result.requestId, postedTx: sent.hash, postedBlock: sent.receipt.blockNumber.toString() });
    }
    s.lastNonce = next.toString(); s.lastMid = market.mid; s.quoteTimes.mid = now;
  }
  await fundPaymentLayer(s, market.mid);
  await save(s); return { s, decision };
}
export async function thresholdTriggered(accrued: bigint, threshold: bigint) { if (accrued < 0n || threshold <= 0n) throw new RangeError("invalid funding threshold"); return accrued >= threshold; }
export function shouldRunInference(tier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED", requote: boolean) { return (tier === "NORMAL" || tier === "LOW") && requote; }
export function tickPolicy(input: BudgetInput) { const decision = decideBudget(input); return { ...decision, shouldInfer: shouldRunInference(decision.tier, decision.requote) }; }
async function main() {
  requiredAddress(board, "BOARD_ADDRESS"); requiredAddress(maker, "MAKER_ADDRESS"); requiredAddress(runtimeAddress, "AGENT_ADDRESS");
  const s = await loadState();
  if (process.argv.includes("--once")) await runTick(s);
  else { while (true) { const { s: updated } = await runTick(s); await Bun.sleep(15_000); Object.assign(s, updated); } }
}
if (import.meta.main) main().catch(e => { process.stderr.write(`runtime failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
