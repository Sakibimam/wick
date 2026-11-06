// One agent tick with no filesystem and no long waits, for a Cloudflare Workers cron (v2 board).
// State lives in whatever store the caller passes back in; every chain read goes through fetch-based viem clients.
import { createWalletClient, defineChain, encodeAbiParameters, formatUnits, http, keccak256, parseAbi, parseAbiParameters, type Address, type Chain, type Hex, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { askDecision, BrainError, type BilledRun } from "./brain.js";
import { accountSpend, deviationBps, emptySpendLedger, type SpendLedger } from "./budget.js";
import { MAX_SPOT_TWAP_GAP_BPS, quoterAbi, QUOTER_V2, readTwapMarket, USDC, W0G } from "./price.js";
import { fundingAbi, quoteCcipFee, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER } from "./funding.js";
import { decideFunding, emptyFundingState, fundingTick, WETH_BASE, type FundingState } from "./funding-machine.js";
import { signPair, type Pair } from "./signer.js";
import { boardV2Abi, eip1559Fees, postPair } from "./poster.js";
import { composePair, cronPolicy, postedSpreadBps, realizedVolBps, tierSpreadBps } from "./policy.js";

export type InferenceRecord = { requestId: string; model: string; tokens?: number | null; costMicroUsd?: number | null; currency: string | null; totalCost: string | null; time: string; reason?: string | null; spreadBps?: number | null; postedSpreadBps?: number | null; skewBps?: number | null; maxAmountIn?: string | null; maxAmountInUsdc?: number | null; ttlSeconds?: number | null; teeVerified?: boolean | null; provider?: string | null; inferenceId?: Hex | null; outcome?: string; attempts?: number };
export type PostedQuote = { tokenIn: Address; tokenOut: Address; rateE18: string; maxAmountIn?: string; expiry: string; epoch?: string; nonce?: string; inferenceId: Hex; requestId: string; postedTx: Hex; postedBlock: string; board?: Address };
export type TickRecord = { at: string; outcome: string; error?: string; subrequests?: number };
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
  market?: { twapMid: number; spotMid: number; gapBps: number; ethUsd: number };
};
export type FillLite = { taker: Address; tokenIn: Address; tokenOut: Address; amountIn: string; amountOut: string; timeMs: number | null };
export type FundingEnv = { k: number; gasTopUpBelowWei: bigint; gasShareBps: number; maxSpendWeiPerRun: bigint; zeroGGasReserveWei: bigint; feeBps: number };
export type TickEnv = { base: PublicClient<any, any>; zeroG: PublicClient<any, any>; chain: Chain; baseRpcUrl: string; baseTransport?: Transport; zeroGTransport?: Transport; board: Address; aquaApp: Address; strategyHash: Hex; maker: Address; agent: Address; spendCapPerDayWei: bigint; agentPk?: string; zgApiKey?: string; zgApiBase?: string; fetchImpl?: typeof fetch; fills?: FillLite[]; funding?: FundingEnv; now?: number; log?: (line: string) => void };

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
  const [market, vault, gasWei, quotes, epoch, onBoard, wW0g, wUsdc, strategy, ethPool, ccipFeeWei, gasPrice] = await Promise.all([
    readTwapMarket(env.base),
    env.zeroG.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [env.agent] }),
    env.base.getBalance({ address: env.agent }),
    Promise.all([[USDC, W0G], [W0G, USDC]].map(([a, b]) => env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "getQuote", args: [env.maker, a as Address, b as Address] }))),
    env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "epochOf", args: [env.maker] }),
    env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "getAgent", args: [env.maker] }),
    env.base.readContract({ address: W0G, abi: readAbi, functionName: "balanceOf", args: [env.maker] }),
    env.base.readContract({ address: USDC, abi: readAbi, functionName: "balanceOf", args: [env.maker] }),
    env.base.readContract({ address: AQUA, abi: readAbi, functionName: "safeBalances", args: [env.maker, env.aquaApp, env.strategyHash, W0G, USDC] }),
    env.base.readContract({ address: ETH_USDC_POOL, abi: readAbi, functionName: "slot0" }),
    quoteCcipFee(env.base, { agent: env.agent, w0gAmount: 10n ** 18n }).catch(() => null),
    env.base.getGasPrice(),
  ]);
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
    const accrued = accruedFees(env.fills ?? [], fenv.feeBps);
    const ctx = {
      now, agent: env.agent, agentOwner: env.agent, zeroGGasReserveWei: fenv.zeroGGasReserveWei,
      decision: { accrued, wallet: { usdc: wUsdc, w0g: wW0g, ethWei: gasWei }, strategy: { w0g: strategy[0], usdc: strategy[1] }, mid: market.twapMid, ethUsd, ccipFeeWei: ccipFeeWei ?? 10n ** 18n, baseGasPriceWei: gasPrice, zeroGGasUsdc: 0.002, k: fenv.k, gasTopUpBelowWei: fenv.gasTopUpBelowWei, gasShareBps: fenv.gasShareBps, maxSpendWeiPerRun: fenv.maxSpendWeiPerRun },
      io: {
        send: async (tx: { chainId: 8453 | 16661; to: Address; data: Hex; value: bigint }) => tx.chainId === 8453 ? wallet.sendTransaction({ account: wallet.account!, chain: env.chain, to: tx.to, data: tx.data, value: tx.value, ...(await eip1559Fees(env.base)) }) : zg.sendTransaction({ account: zg.account!, chain: ZERO_G_CHAIN, to: tx.to, data: tx.data, value: tx.value }),
        receipt: async (chainId: 8453 | 16661, hash: Hex) => { try { const r = await (chainId === 8453 ? env.base : env.zeroG).getTransactionReceipt({ hash }); return r.status; } catch { return null; } },
        readAllowance: (token: Address, spender: Address) => env.base.readContract({ address: token, abi: readAbi, functionName: "allowance", args: [env.agent, spender] }),
        readZeroGW0g: () => env.zeroG.readContract({ address: W0G_ZERO_G, abi: readAbi, functionName: "balanceOf", args: [env.agent] }),
        readZeroGNative: () => env.zeroG.getBalance({ address: env.agent }),
        quoteSwapUsdcToW0g: async (usdcIn: bigint) => (await env.base.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, amountIn: usdcIn, fee: 3000, sqrtPriceLimitX96: 0n }] })).result[0],
        quoteSwapUsdcToEth: async (usdcIn: bigint) => (await env.base.simulateContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: WETH_BASE, amountIn: usdcIn, fee: 500, sqrtPriceLimitX96: 0n }] })).result[0],
      },
    };
    if (ccipFeeWei === null && !s.funding!.run) { s.funding = { ...s.funding!, lastDecision: { ...decideFunding({ ...ctx.decision, funded: { usdc: BigInt(s.funding!.funded.usdc), w0g: BigInt(s.funding!.funded.w0g) } }), fire: false, reason: "ccip_fee_unavailable" } }; return "funding hold ccip_fee_unavailable"; }
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
  const hold = async (why: string) => { let f = ""; try { f = await fundingStep(wallet); } catch (e) { f = `funding error: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`; } return done(`${why}; ${f}`); };

  if (market.gapBps > MAX_SPOT_TWAP_GAP_BPS) return hold(`hold spot_twap_gap ${market.gapBps.toFixed(0)}bps`);
  if (!decision.shouldInfer) return hold("hold");

  const w0gDepthUsdc = Number(formatUnits(strategy[0], 18)) * market.twapMid, usdcDepth = Number(formatUnits(strategy[1], 6));
  const fills = (env.fills ?? []).filter(f => f.timeMs !== null).slice(-10);
  const runCost = lastRunCost(s.inferences);
  const runsLeft = runCost ? Number(BigInt(ledger0.fundsWei) / runCost) : null;
  const requotesPerDay = 86_400 / 300;
  let result: Awaited<ReturnType<typeof askDecision>>;
  try {
    result = await askDecision({
      twapMid: market.twapMid, spotMid: market.spotMid, recentMids: s.recentMids, realizedVolBps: Number(realizedVolBps(s.recentMids).toFixed(2)),
      inventory: { w0g: Number(formatUnits(strategy[0], 18)), usdc: usdcDepth, w0gValueShare: w0gDepthUsdc + usdcDepth > 0 ? Number((w0gDepthUsdc / (w0gDepthUsdc + usdcDepth)).toFixed(4)) : 0.5 },
      recentFills: fills.map(f => ({ side: f.tokenIn.toLowerCase() === USDC.toLowerCase() ? "taker_bought_w0g" as const : "taker_sold_w0g" as const, amountUsdc: f.tokenIn.toLowerCase() === USDC.toLowerCase() ? Number(formatUnits(BigInt(f.amountIn), 6)) : Number(formatUnits(BigInt(f.amountOut), 6)), minutesAgo: Math.round((now - f.timeMs!) / 60_000) })),
      gas: { baseEth: Number(formatUnits(gasWei, 18)), gasPerRequoteUsd: Number((Number(gasPrice * 120_000n) / 1e18 * ethUsd).toFixed(6)) },
      runway: { vault0g: Number(formatUnits(BigInt(ledger0.fundsWei), 18)), runsLeft, days: runsLeft === null ? null : Number((runsLeft / requotesPerDay).toFixed(2)) },
      budgetTier: decision.tier, tierSpreadBps: tierSpreadBps(decision.tier), maxAmountInUsdcCap: Number(Math.max(w0gDepthUsdc, usdcDepth).toFixed(6)),
    }, { apiKey: env.zgApiKey, baseUrl: env.zgApiBase, fetchImpl: env.fetchImpl ?? fetch });
  } catch (e) {
    const run = e instanceof BrainError ? e.run : undefined;
    if (run) record(s, run, now, { outcome: `refused ${(e as BrainError).code}` });
    setBudget(accountSpend(s.spend!, { nowMs: now, vaultWei: vault, billedWei: billedWei(run) }));
    return hold(`refused ${e instanceof BrainError ? e.code : "error"}${run ? ` ${run.requestId}` : ""}`);
  }
  setBudget(accountSpend(s.spend!, { nowMs: now, vaultWei: vault, billedWei: billedWei(result) }));
  const spread = postedSpreadBps(result.spreadBps, decision.tier);
  const ttl = result.ttlSeconds;
  const inferenceId = inferenceIdOf(result);
  const composed = composePair({ twapMid: market.twapMid, spreadBps: spread, skewBps: result.skewBps, maxAmountInUsdc: result.maxAmountInUsdc });
  const nonce = (await env.base.readContract({ address: env.board, abi: boardV2Abi, functionName: "lastNonce", args: [env.maker, epoch] })) + 1n;
  const pair: Pair = { maker: env.maker, token0: W0G, token1: USDC, rate01E18: composed.rate01E18, rate10E18: composed.rate10E18, maxIn0: composed.maxIn0, maxIn1: composed.maxIn1, expiry: BigInt(nowSec + ttl), epoch, nonce, inferenceId };
  const detail = { reason: result.reason, spreadBps: result.spreadBps, postedSpreadBps: spread, skewBps: result.skewBps, maxAmountIn: composed.maxIn1.toString(), maxAmountInUsdc: result.maxAmountInUsdc, ttlSeconds: ttl, inferenceId, tokens: result.tokens, costMicroUsd: result.costMicroUsd, attempts: result.attempts };
  try {
    const sig = await signPair(wallet, env.chain.id, env.board, pair);
    const sent = await postPair(env.base, wallet, env.board, pair, sig);
    for (const [tokenIn, tokenOut, rate, maxIn] of [[W0G, USDC, pair.rate01E18, pair.maxIn0], [USDC, W0G, pair.rate10E18, pair.maxIn1]] as const)
      s.posted = [...s.posted, { tokenIn, tokenOut, rateE18: rate.toString(), maxAmountIn: maxIn.toString(), expiry: pair.expiry.toString(), epoch: epoch.toString(), nonce: nonce.toString(), inferenceId, requestId: result.requestId, postedTx: sent.hash, postedBlock: sent.receipt.blockNumber.toString(), board: env.board }].slice(-KEEP);
    record(s, result, now, { ...detail, outcome: "posted" });
  } catch (e) {
    record(s, result, now, { ...detail, outcome: "post_failed" });
    return done(`post_failed ${result.requestId}`, e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message).split("\n").filter(Boolean).slice(0, 2).join(" ") + ((e as { cause?: { data?: { errorName?: string; args?: unknown[] } } }).cause?.data?.errorName ? ` ${(e as any).cause.data.errorName}(${((e as any).cause.data.args ?? []).join(",")})` : "") : String(e));
  }
  s.lastMid = market.twapMid; s.quotedAt = now;
  return done(`posted ${result.requestId}`);
}

const billedWei = (run?: { billing: { currency: string | null; totalCost: string | null } }) => run?.billing.currency === "0g" && run.billing.totalCost ? BigInt(run.billing.totalCost) : 0n;
function lastRunCost(inferences: InferenceRecord[]): bigint | null { for (let i = inferences.length - 1; i >= 0; i--) { const r = inferences[i]!; if (r.currency === "0g" && r.totalCost && BigInt(r.totalCost) > 0n) return BigInt(r.totalCost); } return null; }
function record(s: CronState, run: BilledRun, now: number, extra: Partial<InferenceRecord>) {
  s.inferences = [...s.inferences, { requestId: run.requestId, model: run.model, currency: run.billing.currency, totalCost: run.billing.totalCost, time: new Date(now).toISOString(), teeVerified: run.teeVerified, provider: run.provider, ...extra }].slice(-KEEP);
}
