// One agent tick with no filesystem and no long waits, for a Cloudflare Workers cron (v2 board).
// State lives in whatever store the caller passes back in; every chain read goes through fetch-based viem clients.
import { createWalletClient, defineChain, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, parseAbiParameters, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { askDecision, BrainError, inventoryGoal, validateDecision, type BilledRun, type Decision } from "./brain.js";
import { accountSpend, deviationBps, emptySpendLedger, type SpendLedger } from "./budget.js";
import { MAX_SPOT_TWAP_GAP_BPS, quoterAbi, QUOTER_V2, readTwapMarket, USDC, W0G } from "./price.js";
import { fundingAbi, quoteCcipFee, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER } from "./funding.js";
import { decideFunding, emptyFundingState, fundingTick, harvestAbi, AQUA_SWAPVM_ROUTER, WETH_BASE, type FundingState, type HarvestCtx, type LiveOrder } from "./funding-machine.js";
import { signPair, type Pair } from "./signer.js";
import { boardV2Abi, eip1559Fees, postPair } from "./poster.js";
import { composeQuotes, cronPolicy, depthCap, GAS_FLOOR_WEI, postedHalfSpreads, realizedVolBps, tierSpreadBps } from "./policy.js";

export type InferenceRecord = { requestId: string; model: string; tokens?: number | null; costMicroUsd?: number | null; currency: string | null; totalCost: string | null; time: string; reason?: string | null; bidHalfSpreadBps?: number | null; askHalfSpreadBps?: number | null; postedBidHalfSpreadBps?: number | null; postedAskHalfSpreadBps?: number | null; spreadBps?: number | null; postedSpreadBps?: number | null; skewBps?: number | null; maxAmountIn?: string | null; maxAmountInUsdc?: number | null; ttlSeconds?: number | null; teeVerified?: boolean | null; provider?: string | null; inferenceId?: Hex | null; outcome?: string; attempts?: number; fallbackFrom?: string | null };
export type PostedQuote = { tokenIn: Address; tokenOut: Address; rateE18: string; maxAmountIn?: string; expiry: string; epoch?: string; nonce?: string; inferenceId: Hex; requestId: string; postedTx: Hex; postedBlock: string; board?: Address; gasCostWei?: string };
export type TickRecord = { at: string; outcome: string; error?: string; subrequests?: number; rpcFailures?: Record<string, number> };
export type CronState = {
  version?: 2;
  budget: { tier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED"; model: string | null; computeBalanceWei: string; spentTodayWei: string; spendCapPerDayWei: string; reason: string; gasWei: string; vaultWei?: string; routerDepositWei?: string };
  spend?: SpendLedger;
  lastMid: number | null;
  recentMids: number[];
  quotedAt: number | null;
  day: string;
  spentTodayWei: string;
  lastComputeBalanceWei: string;
  inferences: InferenceRecord[];
  posted: PostedQuote[];
  lastTick: TickRecord | null;
  lastTicks?: TickRecord[];
  funding?: FundingState;
  /** The last decision that passed every guard and was posted: what a refused answer re-posts instead of leaving the book empty. */
  lastValidDecision?: Decision & { inferenceId: Hex; requestId: string };
  market?: { twapMid: number; spotMid: number; gapBps: number; ethUsd: number };
};
export type FillLite = { orderHash?: Hex; taker: Address; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string; timeMs: number | null };
export type FundingEnv = { k: number; gasTopUpBelowWei: bigint; gasShareBps: number; maxSpendWeiPerRun: bigint; zeroGGasReserveWei: bigint; feeBps: number };
export type TickEnv = { base: PublicClient<any, any>; zeroG: PublicClient<any, any>; chain: Chain; baseRpcUrl: string; baseTransport?: Transport; zeroGTransport?: Transport; board: Address; aquaApp: Address; strategyHash: Hex; maker: Address; agent: Address; spendCapPerDayWei: bigint; agentPk?: string; zgApiKey?: string; zgApiBase?: string; fetchImpl?: typeof fetch; fills?: FillLite[]; x402RevenueUsdc?: bigint; funding?: FundingEnv; hook?: Address; liveOrder?: LiveOrder; now?: number; log?: (line: string) => void };

const KEEP = 50;
const TICKS = 12;
export const ETH_USDC_POOL: Address = "0xd0b53D9277642d899DF5C87A3966A349A798F224";
export const AQUA: Address = "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a";
const readAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)", "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"]);
export const ZERO_G_CHAIN = defineChain({ id: 16661, name: "0G Mainnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: ["https://evmrpc.0g.ai"] } } });
export const DEFAULT_FUNDING_ENV: FundingEnv = { k: 3, gasTopUpBelowWei: 100_000_000_000_000n, gasShareBps: 5_000, maxSpendWeiPerRun: 300_000_000_000_000n, zeroGGasReserveWei: 5_000_000_000_000_000n, feeBps: 30 };

export function emptyCronState(): CronState {
  return { version: 2, budget: { tier: "PAUSED", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: "0", reason: "not_started", gasWei: "0" }, spend: emptySpendLedger(), lastMid: null, recentMids: [], quotedAt: null, day: "", spentTodayWei: "0", lastComputeBalanceWei: "", inferences: [], posted: [], lastTick: null, lastTicks: [], funding: emptyFundingState() };
}

/** USDC per ETH from the Uniswap v3 WETH(token0)/USDC(token1) 0.05% pool. */
export const ethUsdFromSqrt = (sqrtPriceX96: bigint) => Number(sqrtPriceX96 * sqrtPriceX96 * 10n ** 12n * 10n ** 6n / (1n << 192n)) / 1e6;
/** Fees the strategy charged, per token, from fills: feeBps of each fill's input amount. */
export function accruedFees(fills: FillLite[], feeBps: number) { let usdc = 0n, w0g = 0n; for (const f of fills) { const fee = BigInt(f.amountIn) * BigInt(feeBps) / 10_000n; if (f.tokenIn.toLowerCase() === USDC.toLowerCase()) usdc += fee; else if (f.tokenIn.toLowerCase() === W0G.toLowerCase()) w0g += fee; } return { usdc, w0g }; }
/** Everything the agent earned: swap fees from fills plus x402 quote revenue settled in USDC to the maker. The funding machine
 *  still spends only wallet headroom above the strategy's commitment, so revenue claimed but not held is never spent. */
export function earnedUsdcAndW0g(fills: FillLite[], feeBps: number, x402RevenueUsdc: bigint) { const f = accruedFees(fills, feeBps); if (x402RevenueUsdc < 0n) throw new RangeError("negative x402 revenue"); return { usdc: f.usdc + x402RevenueUsdc, w0g: f.w0g }; }
/** inferenceId binds the router request id to the provider that answered and the router's TEE verdict. */
export const inferenceIdOf = (run: { requestId: string; provider: string | null; teeVerified: boolean | null }) => keccak256(encodeAbiParameters(parseAbiParameters("string,string,string"), [run.requestId, run.provider ?? "", String(run.teeVerified)]));

export async function cronTick(prev: CronState, env: TickEnv): Promise<{ state: CronState; outcome: string }> {
  const s: CronState = { ...emptyCronState(), ...structuredClone(prev), version: 2 };
  s.spend ??= { day: s.day, spentTodayWei: "0", lastVaultWei: s.lastComputeBalanceWei, routerDepositWei: "0" };
  s.funding ??= emptyFundingState();
  const now = env.now ?? Date.now();
  const log = env.log ?? (() => {});
  const nowSec = Math.floor(now / 1000);
  const fenv = env.funding ?? DEFAULT_FUNDING_ENV;
  const liveOrder = s.funding.live ?? env.liveOrder ?? null;
  const liveHash = liveOrder?.hash ?? env.strategyHash;
  // rawBalances, not safeBalances: a docked hash (mid-harvest) reads as tokensCount 0xff instead of reverting the whole tick.
  const raw = (token: Address) => env.base.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [env.maker, env.aquaApp, liveHash, token] });
  const [market, vault, gasWei, quotes, epoch, onBoard, wW0g, wUsdc, rawStrategy, ethPool, ccipFeeWei, gasPrice] = await Promise.all([
    readTwapMarket(env.base),
    env.zeroG.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [env.agent] }),
    env.base.getBalance({ address: env.agent }),
    Promise.all([[USDC, W0G], [W0G, USDC]].map(([a, b]) => env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "getQuote", args: [env.maker, a as Address, b as Address] }))),
    env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "epochOf", args: [env.maker] }),
    env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "getAgent", args: [env.maker] }),
    env.base.readContract({ address: W0G, abi: readAbi, functionName: "balanceOf", args: [env.maker] }),
    env.base.readContract({ address: USDC, abi: readAbi, functionName: "balanceOf", args: [env.maker] }),
    Promise.all([raw(W0G), raw(USDC)]),
    env.base.readContract({ address: ETH_USDC_POOL, abi: readAbi, functionName: "slot0" }),
    quoteCcipFee(env.base, { agent: env.agent, w0gAmount: 10n ** 18n }).catch(() => null),
    env.base.getGasPrice(),
  ]);
  const docked = rawStrategy[0][1] !== 2 || rawStrategy[1][1] !== 2;
  const hrun = s.funding.run?.harvest;
  // While docked mid-harvest the inventory waiting to be re-shipped is the commitment; a docked hash outside a harvest commits nothing.
  const strategy: readonly [bigint, bigint] = !docked ? [rawStrategy[0][0], rawStrategy[1][0]] : hrun && !hrun.shipped ? [BigInt(hrun.inventory.w0g), BigInt(hrun.inventory.usdc)] : [0n, 0n];
  const ethUsd = ethUsdFromSqrt(ethPool[0]);
  s.market = { twapMid: market.twapMid, spotMid: market.spotMid, gapBps: market.gapBps, ethUsd };
  const live = quotes.filter(q => q.expiry > 0n && q.epoch === epoch);
  const secondsToExpiry = live.length < 2 ? null : Math.min(...live.map(q => Number(q.expiry))) - nowSec;

  const ledger0 = accountSpend(s.spend, { nowMs: now, vaultWei: vault, billedWei: 0n });
  const decision = cronPolicy({ computeBalanceWei: BigInt(ledger0.fundsWei), spendCapPerDayWei: env.spendCapPerDayWei, spentTodayWei: BigInt(ledger0.spentTodayWei), priceDeviationBps: s.lastMid === null ? 0 : deviationBps(s.lastMid, market.twapMid), lastQuoteAgeMs: s.quotedAt === null ? null : now - s.quotedAt, gasWei, secondsToExpiry });
  const setBudget = (l: SpendLedger & { fundsWei: string }) => { s.spend = { day: l.day, spentTodayWei: l.spentTodayWei, lastVaultWei: l.lastVaultWei, routerDepositWei: l.routerDepositWei }; s.day = l.day; s.spentTodayWei = l.spentTodayWei; s.lastComputeBalanceWei = vault.toString(); s.budget = { tier: decision.tier, model: decision.model, computeBalanceWei: l.fundsWei, spentTodayWei: l.spentTodayWei, spendCapPerDayWei: env.spendCapPerDayWei.toString(), reason: decision.reason, gasWei: gasWei.toString(), vaultWei: vault.toString(), routerDepositWei: l.routerDepositWei }; };
  setBudget(ledger0);
  s.recentMids = [...s.recentMids.slice(-19), market.twapMid];

  const fundingStep = async (wallet: ReturnType<typeof createWalletClient> | null) => {
    if (!wallet || !env.agentPk) return "funding_offline";
    const zg = createWalletClient({ account: privateKeyToAccount(env.agentPk as Hex), chain: ZERO_G_CHAIN, transport: env.zeroGTransport ?? http("https://evmrpc.0g.ai") });
    const accrued = earnedUsdcAndW0g(env.fills ?? [], fenv.feeBps, env.x402RevenueUsdc ?? 0n);
    // Fees still inside the live strategy: only fills on its own hash, so a re-ship starts the count again from zero.
    const harvest: HarvestCtx | undefined = env.hook && liveOrder ? {
      live: liveOrder, hook: env.hook, gasFloorWei: GAS_FLOOR_WEI,
      commitment: docked ? null : { w0g: strategy[0], usdc: strategy[1] },
      fees: accruedFees((env.fills ?? []).filter(f => f.orderHash?.toLowerCase() === liveOrder.hash.toLowerCase()), fenv.feeBps),
      io: {
        aquaSlot: async (hash: Hex) => { const [w, u] = await Promise.all([W0G, USDC].map(t => env.base.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [env.maker, AQUA_SWAPVM_ROUTER, hash, t] }))); return { w0g: w![0], usdc: u![0], tokensCount: w![1] === u![1] ? w![1] : Math.max(w![1], u![1]) }; },
        hookOrderHash: () => env.base.readContract({ address: env.hook!, abi: harvestAbi, functionName: "orderHash" }),
        dockedBalances: (hash: Hex, dockTx: Hex | null) => aquaDockedBalances(env.base, env.maker, hash, dockTx),
      },
    } : undefined;
    const ctx = {
      harvest,
      now, agent: env.agent, agentOwner: env.agent, zeroGGasReserveWei: fenv.zeroGGasReserveWei,
      decision: { accrued, wallet: { usdc: wUsdc, w0g: wW0g, ethWei: gasWei }, strategy: { w0g: strategy[0], usdc: strategy[1] }, mid: market.twapMid, ethUsd, ccipFeeWei: ccipFeeWei ?? 0n, baseGasPriceWei: gasPrice, zeroGGasUsdc: 0.002, k: fenv.k, gasTopUpBelowWei: fenv.gasTopUpBelowWei, gasShareBps: fenv.gasShareBps, maxSpendWeiPerRun: fenv.maxSpendWeiPerRun },
      io: {
        send: (tx: { chainId: 8453 | 16661; to: Address; data: Hex; value: bigint }) => sendWithNonceRetry(tx.chainId === 8453 ? env.base : env.zeroG, env.agent, (nonce) => tx.chainId === 8453
          ? (async () => wallet.sendTransaction({ account: wallet.account!, chain: env.chain, to: tx.to, data: tx.data, value: tx.value, nonce, ...(await eip1559Fees(env.base)) }))()
          : zg.sendTransaction({ account: zg.account!, chain: ZERO_G_CHAIN, to: tx.to, data: tx.data, value: tx.value, nonce })),
        receipt: async (chainId: 8453 | 16661, hash: Hex) => { try { const r = await (chainId === 8453 ? env.base : env.zeroG).getTransactionReceipt({ hash }); return r.status; } catch { return null; } },
        readAllowance: (token: Address, spender: Address) => env.base.readContract({ address: token, abi: readAbi, functionName: "allowance", args: [env.agent, spender] }),
        readZeroGW0g: () => env.zeroG.readContract({ address: W0G_ZERO_G, abi: readAbi, functionName: "balanceOf", args: [env.agent] }),
        readZeroGNative: () => env.zeroG.getBalance({ address: env.agent }),
        quoteSwapUsdcToW0g: async (usdcIn: bigint) => (await env.base.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, amountIn: usdcIn, fee: 3000, sqrtPriceLimitX96: 0n }] })).result[0],
        quoteSwapUsdcToEth: async (usdcIn: bigint) => (await env.base.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: WETH_BASE, amountIn: usdcIn, fee: 500, sqrtPriceLimitX96: 0n }] })).result[0],
      },
    };
    // No default fee, ever: CCIP keeps the whole msg.value, so an unread fee holds every run at whatever step it is.
    if (ccipFeeWei === null) { if (!s.funding!.run) s.funding = { ...s.funding!, lastDecision: { ...decideFunding({ ...ctx.decision, funded: { usdc: BigInt(s.funding!.funded.usdc), w0g: BigInt(s.funding!.funded.w0g) } }), fire: false, reason: "ccip_fee_unavailable" } }; return "funding hold ccip_fee_unavailable"; }
    const r = await fundingTick(s.funding!, ctx);
    s.funding = r.state;
    return `funding ${r.action}`;
  };
  const done = (outcome: string, error?: string) => {
    const rec: TickRecord = { at: new Date(now).toISOString(), outcome, ...(error ? { error } : {}) };
    s.lastTick = rec; s.lastTicks = [...(s.lastTicks ?? []), rec].slice(-TICKS);
    log(`tick ${outcome} tier=${decision.tier} reason=${decision.reason} twap=${market.twapMid} spot=${market.spotMid} expiresIn=${secondsToExpiry}`);
    return { state: s, outcome };
  };

  if (!env.agentPk || !env.zgApiKey) { s.budget = { ...s.budget, tier: "PAUSED", model: null, reason: decision.reason === "gas_low" ? "gas_low" : "signer_offline" }; return done("secrets_not_set"); }
  const account = privateKeyToAccount(env.agentPk as Hex);
  if (account.address.toLowerCase() !== env.agent.toLowerCase()) throw new Error("AGENT_PK does not match AGENT_ADDRESS");
  if ((onBoard as Address).toLowerCase() !== env.agent.toLowerCase()) throw new Error("AGENT_ADDRESS is not the registered v2 board agent");
  const wallet = createWalletClient({ account, chain: env.chain, transport: env.baseTransport ?? http(env.baseRpcUrl) });
  const hold = async (why: string, error?: string) => { let f = ""; try { f = await fundingStep(wallet); } catch (e) { f = `funding error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`; } return done(`${why}; ${f}`, error); };

  if (market.gapBps > MAX_SPOT_TWAP_GAP_BPS) return hold(`hold spot_twap_gap ${market.gapBps.toFixed(0)}bps`);
  // One chain write per tick: a harvest in flight owns the nonce until the strategy is re-shipped and the hook follows it.
  if (s.funding.run?.kind === "harvest") return hold("hold harvesting");
  if (!decision.shouldInfer) return hold("hold");

  const w0gDepthUsdc = Number(formatUnits(strategy[0], 18)) * market.twapMid, usdcDepth = Number(formatUnits(strategy[1], 6));
  const fills = (env.fills ?? []).filter(f => f.timeMs !== null).slice(-10);
  const runCost = lastRunCost(s.inferences);
  const runsLeft = runCost ? Number(BigInt(ledger0.fundsWei) / runCost) : null;
  const requotesPerDay = 86_400 / 300;
  const share = w0gDepthUsdc + usdcDepth > 0 ? Number((w0gDepthUsdc / (w0gDepthUsdc + usdcDepth)).toFixed(4)) : 0.5;
  const cap = Number(Math.max(w0gDepthUsdc, usdcDepth).toFixed(6));
  const errText = (e: unknown) => e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message).split("\n").filter(Boolean).slice(0, 2).join(" ") + ((e as { cause?: { data?: { errorName?: string; args?: unknown[] } } }).cause?.data?.errorName ? ` ${(e as any).cause.data.errorName}(${((e as any).cause.data.args ?? []).join(",")})` : "") : String(e);
  /** Signs and posts one pair for a validated decision, and keeps both posted directions; throws when the post fails. */
  const postDecision = async (d: Decision, inferenceId: Hex, requestId: string) => {
    const sides = postedHalfSpreads(d.bidHalfSpreadBps, d.askHalfSpreadBps, decision.tier);
    const composed = composeQuotes({ twapMid: market.twapMid, bidHalfSpreadBps: sides.bid, askHalfSpreadBps: sides.ask, maxAmountInUsdc: d.maxAmountInUsdc });
    // spreadBps / postedSpreadBps / skewBps are the half-spreads restated as width and lean for readers of the older record shape.
    const detail: Partial<InferenceRecord> = { reason: d.reason, bidHalfSpreadBps: d.bidHalfSpreadBps, askHalfSpreadBps: d.askHalfSpreadBps, postedBidHalfSpreadBps: sides.bid, postedAskHalfSpreadBps: sides.ask, spreadBps: Math.round((d.bidHalfSpreadBps + d.askHalfSpreadBps) / 2), postedSpreadBps: Math.round((sides.bid + sides.ask) / 2), skewBps: Math.round((sides.bid - sides.ask) / 2), maxAmountInUsdc: d.maxAmountInUsdc, ttlSeconds: d.ttlSeconds, inferenceId };
    const nonce = (await env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "lastNonce", args: [env.maker, epoch] })) + 1n;
    // Advertise no more than the strategy can pay out: W0G in is paid in USDC depth, USDC in in W0G depth. The board refuses 0, so an empty side posts 1.
    const one = (x: bigint) => (x > 0n ? x : 1n);
    const maxIn0 = one(depthCap(strategy[1], composed.rate01E18, fenv.feeBps, composed.maxIn0)), maxIn1 = one(depthCap(strategy[0], composed.rate10E18, fenv.feeBps, composed.maxIn1));
    const pair: Pair = { maker: env.maker, token0: W0G, token1: USDC, rate01E18: composed.rate01E18, rate10E18: composed.rate10E18, maxIn0, maxIn1, expiry: BigInt(nowSec + d.ttlSeconds), epoch, nonce, inferenceId };
    try {
      const sig = await signPair(wallet, env.chain.id, env.board, pair);
      const sent = await postPair(env.base, wallet, env.board, pair, sig);
      // Base receipts carry the L1 data fee next to L2 gas; together they are what one requote cost.
      const gasCostWei = (BigInt(sent.receipt.gasUsed) * BigInt(sent.receipt.effectiveGasPrice) + BigInt((sent.receipt as { l1Fee?: bigint | null }).l1Fee ?? 0n)).toString();
      for (const [tokenIn, tokenOut, rate, maxIn] of [[W0G, USDC, pair.rate01E18, pair.maxIn0], [USDC, W0G, pair.rate10E18, pair.maxIn1]] as const)
        s.posted = [...s.posted, { tokenIn, tokenOut, rateE18: rate.toString(), maxAmountIn: maxIn.toString(), expiry: pair.expiry.toString(), epoch: epoch.toString(), nonce: nonce.toString(), inferenceId, requestId, postedTx: sent.hash, postedBlock: sent.receipt.blockNumber.toString(), board: env.board, gasCostWei }].slice(-KEEP);
      s.lastValidDecision = { ...d, inferenceId, requestId };
      detail.maxAmountIn = maxIn1.toString();
      s.lastMid = market.twapMid; s.quotedAt = now;
      return { detail, error: null };
    } catch (e) { return { detail, error: errText(e) }; }
  };
  let result: Awaited<ReturnType<typeof askDecision>>;
  try {
    result = await askDecision({
      twapMid: market.twapMid, spotMid: market.spotMid, recentMids: s.recentMids, realizedVolBps: Number(realizedVolBps(s.recentMids).toFixed(2)),
      inventory: { w0g: Number(formatUnits(strategy[0], 18)), usdc: usdcDepth, w0gValueShare: share },
      inventoryGoal: inventoryGoal(share),
      recentFills: fills.map(f => ({ side: f.tokenIn.toLowerCase() === USDC.toLowerCase() ? "taker_bought_w0g" as const : "taker_sold_w0g" as const, amountUsdc: f.tokenIn.toLowerCase() === USDC.toLowerCase() ? Number(formatUnits(BigInt(f.amountIn), 6)) : Number(formatUnits(BigInt(f.amountOut), 6)), minutesAgo: Math.round((now - f.timeMs!) / 60_000) })),
      gas: { baseEth: Number(formatUnits(gasWei, 18)), gasPerRequoteUsd: Number((Number(gasPrice * 120_000n) / 1e18 * ethUsd).toFixed(6)) },
      runway: { vault0g: Number(formatUnits(BigInt(ledger0.fundsWei), 18)), runsLeft, days: runsLeft === null ? null : Number((runsLeft / requotesPerDay).toFixed(2)) },
      budgetTier: decision.tier, tierSpreadBps: tierSpreadBps(decision.tier), maxAmountInUsdcCap: cap,
    }, { apiKey: env.zgApiKey, baseUrl: env.zgApiBase, fetchImpl: env.fetchImpl ?? fetch });
  } catch (e) {
    const run = e instanceof BrainError ? e.run : undefined;
    setBudget(accountSpend(s.spend!, { nowMs: now, vaultWei: vault, billedWei: billedWei(run) }));
    const why = `refused ${e instanceof BrainError ? e.code : "error"}${run ? ` ${run.requestId}` : ""}`, msg = e instanceof Error ? e.message.split("\n")[0]!.slice(0, 300) : String(e);
    // A guard refused a billed answer: keep the book quoted with the last decision that passed every guard, re-checked
    // against this tick's inventory and depth cap and composed around this tick's TWAP, rather than letting it lapse.
    const last = s.lastValidDecision;
    let again: Decision | null = null;
    if (run && last) try { again = validateDecision({ ...last, maxAmountInUsdc: Math.min(last.maxAmountInUsdc, cap) }, cap, share); } catch { again = null; }
    if (run && last && again) {
      const r = await postDecision(again, last.inferenceId, last.requestId);
      const outcome = r.error ? `refused model answer, repost failed` : REPOSTED;
      record(s, run, now, { ...r.detail, reason: msg, outcome });
      return done(`${why}; ${outcome}`, r.error ?? msg);
    }
    if (run) record(s, run, now, { outcome: `refused ${(e as BrainError).code}`, reason: msg });
    return hold(why, msg);
  }
  setBudget(accountSpend(s.spend!, { nowMs: now, vaultWei: vault, billedWei: billedWei(result) }));
  const inferenceId = inferenceIdOf(result);
  const r = await postDecision(result, inferenceId, result.requestId);
  const runDetail = { ...r.detail, tokens: result.tokens, costMicroUsd: result.costMicroUsd, attempts: result.attempts, fallbackFrom: result.fallbackFrom };
  if (r.error) { record(s, result, now, { ...runDetail, outcome: "post_failed" }); return done(`post_failed ${result.requestId}`, r.error); }
  record(s, result, now, { ...runDetail, outcome: "posted" });
  return done(`posted ${result.requestId}`);
}

export const REPOSTED = "refused model answer, reposted last valid decision";
const billedWei = (run?: { billing: { currency: string | null; totalCost: string | null } }) => run?.billing.currency === "0g" && run.billing.totalCost ? BigInt(run.billing.totalCost) : 0n;
function lastRunCost(inferences: InferenceRecord[]): bigint | null { for (let i = inferences.length - 1; i >= 0; i--) { const r = inferences[i]!; if (r.currency === "0g" && r.totalCost && BigInt(r.totalCost) > 0n) return BigInt(r.totalCost); } return null; }
function record(s: CronState, run: BilledRun, now: number, extra: Partial<InferenceRecord>) {
  s.inferences = [...s.inferences, { requestId: run.requestId, model: run.model, currency: run.billing.currency, totalCost: run.billing.totalCost, time: new Date(now).toISOString(), teeVerified: run.teeVerified, provider: run.provider, ...extra }].slice(-KEEP);
}

const aquaFlowAbi = parseAbi(["event Pushed(address maker,address app,bytes32 strategyHash,address token,uint256 amount)", "event Pulled(address maker,address app,bytes32 strategyHash,address token,uint256 amount)"]);
/** What a dock closed: Aqua.dock stores (0, 0xff), so the balance is read at the block before the dock and moved by every
 *  Aqua push and pull on the same strategy that executed earlier in the dock's own block. Null when the dock tx is unknown. */
export async function aquaDockedBalances(client: PublicClient<any, any>, maker: Address, hash: Hex, dockTx: Hex | null): Promise<{ w0g: bigint; usdc: bigint } | null> {
  if (!dockTx) return null;
  const rc = await client.getTransactionReceipt({ hash: dockTx });
  if (rc.status !== "success") return null;
  const at = (token: Address) => client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, hash, token], blockNumber: rc.blockNumber - 1n });
  const [w, u, logs] = await Promise.all([at(W0G), at(USDC), client.getLogs({ address: AQUA, events: aquaFlowAbi, fromBlock: rc.blockNumber, toBlock: rc.blockNumber })]);
  if (w[1] !== 2 || u[1] !== 2) return null;
  const bal = { w0g: BigInt(w[0]), usdc: BigInt(u[0]) };
  for (const l of logs as { eventName: "Pushed" | "Pulled"; transactionIndex: number; args: { maker: Address; app: Address; strategyHash: Hex; token: Address; amount: bigint } }[]) {
    if (l.transactionIndex >= rc.transactionIndex || l.args.maker.toLowerCase() !== maker.toLowerCase() || l.args.app.toLowerCase() !== AQUA_SWAPVM_ROUTER.toLowerCase() || l.args.strategyHash.toLowerCase() !== hash.toLowerCase()) continue;
    const k = l.args.token.toLowerCase() === W0G.toLowerCase() ? "w0g" : l.args.token.toLowerCase() === USDC.toLowerCase() ? "usdc" : null;
    if (k) bal[k] += l.eventName === "Pushed" ? l.args.amount : -l.args.amount;
  }
  return bal;
}

const NONCE_ERR = /nonce too low|nonce has already been used|replacement transaction underpriced|invalid nonce/i;
/** The maker wallet is shared with other work, so a nonce can be taken between read and send: each attempt reads the
 *  pending nonce afresh, and only a nonce error is retried. */
export async function sendWithNonceRetry(client: PublicClient<any, any>, address: Address, send: (nonce: number) => Promise<Hex>, tries = 3): Promise<Hex> {
  for (let i = 0; ; i++) {
    const nonce = await client.getTransactionCount({ address, blockTag: "pending" });
    try { return await send(nonce); }
    catch (e) { const m = e instanceof Error ? `${e.message} ${(e as { details?: string }).details ?? ""}` : String(e); if (i + 1 >= tries || !NONCE_ERR.test(m)) throw e; }
  }
}
