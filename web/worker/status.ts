import type { Address, Hex } from "viem";
import type { CronState, InferenceRecord, PostedQuote } from "../../agent/src/worker-tick";
import { CRON_PERIOD_SECONDS as CRON_SECONDS, EXPIRY_REQUOTE_WINDOW_SECONDS as REQUOTE_WINDOW_SECONDS } from "../../agent/src/policy";
import { AGENT, BOARD, EXTRUCTION, FUNDING_EVIDENCE, INFERENCE_EVIDENCE, STRATEGY_HASH } from "../lib/evidence";
import { USDC, W0G } from "../lib/config";
import { fillsOfOrders, readAllFills, readChain, readLogIndex, readV1Index, type FillRow, type Kv, type Post } from "./chain";
import { BOARD_V2, EXTRUCTION_V2, FEE_BPS_V2, liveOrderOf, MAX_DEVIATION_BPS_V2, orderHashesOf, SEED_0G_WEI, V2_TXS, V4_HOOK } from "./v2";

/** Request ids of the two v1 quotes posted by hand before the cron existed, keyed by their post tx (ledger, 2026-11-05). */
const PRE_CRON_REQUEST_BY_TX: Record<string, string> = {
  "0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec": "5319a0b6-562e-4bbe-a141-dfb94fc20aaa",
  "0x79598fe4e59c56cbf7dfb7099955030ac52fb4da4d5d1695119bcd2f7bf1d97e": "5319a0b6-562e-4bbe-a141-dfb94fc20aaa",
};
const lc = (a: string) => a.toLowerCase();

/** Requotes a day at a given TTL: a quote is renewed on the first 5-minute tick inside the agent's requote window. */
export function requotesPerDay(ttlSeconds: number) { return 86_400 / Math.max(CRON_SECONDS, Math.ceil((ttlSeconds - REQUOTE_WINDOW_SECONDS) / CRON_SECONDS) * CRON_SECONDS); }
/** USD cost of one router-billed run: micro-USD as is, 0G wei valued at the W0G mid (W0G is 0G bridged 1:1). */
export function runCostUsd(r: { currency?: string | null; totalCost?: string | null }, mid: number): number | null {
  if (!r.totalCost) return null;
  if (r.currency === "usd") return Number(r.totalCost) / 1e6;
  if (r.currency === "0g") return Number(r.totalCost) / 1e18 * mid;
  return null;
}
const feeOf = (f: FillRow, feeBps: number) => (BigInt(f.amountIn) * BigInt(feeBps)) / 10_000n;
const feeUsdc = (f: FillRow, feeBps: number, mid: number) => f.tokenIn.toLowerCase() === USDC.toLowerCase() ? Number(feeOf(f, feeBps)) / 1e6 : Number(feeOf(f, feeBps)) / 1e18 * mid;

export function economicsOf(input: { fills: FillRow[]; inferences: { currency?: string | null; totalCost?: string | null }[]; mid: number; ethUsd: number; fundsWei: bigint; ttlSeconds: number; gasPerRequoteWei: bigint | null; fundingThresholdUsdc: number | null; funded0gWei: bigint }) {
  const { mid } = input;
  const feesEarnedUsdc = input.fills.reduce((s, f) => s + feeUsdc(f, FEE_BPS_V2, mid), 0);
  const costs = input.inferences.map((r) => runCostUsd(r, mid)).filter((x): x is number => x !== null);
  const aiSpentUsd = costs.reduce((a, b) => a + b, 0);
  const aiSpent0g = input.inferences.reduce((s, r) => s + (r.currency === "0g" && r.totalCost ? Number(r.totalCost) / 1e18 : r.currency === "usd" && r.totalCost ? Number(r.totalCost) / 1e6 / mid : 0), 0);
  const last = [...input.inferences].reverse().map((r) => runCostUsd(r, mid)).find((x): x is number => x !== null && x > 0) ?? null;
  const recent = costs.slice(-12);
  const avgRunUsd = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
  const perDay = requotesPerDay(input.ttlSeconds);
  const gasPerRequoteUsd = input.gasPerRequoteWei === null ? null : Number(input.gasPerRequoteWei) / 1e18 * input.ethUsd;
  const feeRate = FEE_BPS_V2 / 10_000;
  const burn0gPerDay = avgRunUsd === null ? null : avgRunUsd / mid * perDay;
  return {
    feesEarnedUsdc,
    aiSpentUsd,
    aiSpent0g,
    coverage: aiSpentUsd > 0 ? feesEarnedUsdc / aiSpentUsd : null,
    runsPaidByFees: last ? feesEarnedUsdc / last : null,
    fundingThresholdUsdc: input.fundingThresholdUsdc,
    breakEvenFillUsdcPerRun: last ? last / feeRate : null,
    runwayDays: burn0gPerDay ? Number(input.fundsWei) / 1e18 / burn0gPerDay : null,
    inferenceCostUsd: last,
    gasPerRequoteUsd,
    requotesPerDay: perDay,
    breakEvenVolumePerDayUsd: last !== null && gasPerRequoteUsd !== null ? perDay * (last + gasPerRequoteUsd) / feeRate : null,
    gasToInferenceRatio: last && gasPerRequoteUsd !== null ? gasPerRequoteUsd / last : null,
    earned0g: Number(input.funded0gWei) / 1e18,
  };
}

/** v1 board posts from its frozen log index, each joined to its stored record by post tx: the cron's record, or the ledger's for the two pre-cron posts. */
export function v1Records(posts: Post[], posted: PostedQuote[]): PostedQuote[] {
  const byTx = new Map(posted.map((p) => [`${lc(p.postedTx)}:${lc(p.tokenIn)}`, p.requestId]));
  return posts.map((p) => ({ tokenIn: p.tokenIn, tokenOut: p.tokenOut, rateE18: p.rateE18, expiry: p.expiry, inferenceId: p.inferenceId, requestId: byTx.get(`${lc(p.postedTx)}:${lc(p.tokenIn)}`) ?? PRE_CRON_REQUEST_BY_TX[lc(p.postedTx)] ?? "", postedTx: p.postedTx, postedBlock: p.block, board: BOARD }));
}

/** Every quote the agent posted, each with the request id from its own stored record (never a reverse lookup). maxAmountInPerSwap
 *  is what the board caps one swap at; perQuoteBudgetIn is the size the decision intended for the quote's whole life, which the
 *  agent enforces by cutting the cap once fills reach it. maxAmountIn repeats the per-swap cap for readers of the old key. */
export function quotesOf(posted: PostedQuote[], current: { tokenIn: Address; tokenOut: Address; inferenceId: Hex; expiry: bigint }[], nowSec: number) {
  const live = new Set(current.map((q) => `${lc(q.tokenIn)}:${lc(q.inferenceId)}:${q.expiry}`));
  const seen = new Set<string>();
  return [...posted].reverse().filter((p) => { const k = `${lc(p.postedTx)}:${lc(p.tokenIn)}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((p) => ({ tokenIn: p.tokenIn, tokenOut: p.tokenOut, rateE18: p.rateE18, expiry: p.expiry, inferenceId: p.inferenceId, requestId: p.requestId || null, postedTx: p.postedTx, maxAmountInPerSwap: p.maxAmountIn ?? null, perQuoteBudgetIn: p.budgetIn ?? null, budgetFromBlock: p.budgetFromBlock ?? null, maxAmountIn: p.maxAmountIn ?? null, epoch: p.epoch ?? null, nonce: p.nonce ?? null, board: p.board ?? BOARD, current: live.has(`${lc(p.tokenIn)}:${lc(p.inferenceId)}:${p.expiry}`) && Number(p.expiry) > nowSec }));
}

/** The status document the swap and ledger pages render: chain reads first, then the cron's KV record for what only the agent knows. */
export async function buildStatus(kv: Kv | null) {
  const cron = kv ? ((await kv.get("cron-state", "json")) as CronState | null) : null;
  const live = liveOrderOf(cron), orderHashes = orderHashesOf(live);
  const [chain, idx, all, v1] = await Promise.all([readChain(live.hash), readLogIndex(kv).catch(() => null), readAllFills(kv).catch(() => null), readV1Index(kv).catch(() => null)]);
  const nowSec = Math.floor(Date.now() / 1000);
  const inferences = [
    ...INFERENCE_EVIDENCE.map((r) => ({ requestId: r.requestId, model: r.model, currency: r.currency, totalCost: r.totalCost, time: r.time, reason: null, skewBps: null, maxAmountIn: null, ttlSeconds: null, teeVerified: null, provider: null, outcome: "posted" })),
    ...(cron?.inferences ?? []).map((r) => ({ requestId: r.requestId, model: r.model, currency: r.currency, totalCost: r.totalCost, time: r.time, reason: r.reason ?? null, skewBps: r.skewBps ?? null, spreadBps: r.spreadBps ?? null, postedSpreadBps: r.postedSpreadBps ?? null, maxAmountIn: r.maxAmountIn ?? null, maxAmountInUsdc: r.maxAmountInUsdc ?? null, ttlSeconds: r.ttlSeconds ?? null, teeVerified: r.teeVerified ?? null, provider: r.provider ?? null, inferenceId: r.inferenceId ?? null, outcome: r.outcome ?? "posted" })),
  ];
  const v2Posted = (cron?.posted ?? []).filter((p) => p.board && lc(p.board) === lc(BOARD_V2));
  const v1All = v1Records(v1?.posts ?? [], cron?.posted ?? []);
  const quotes = quotesOf([...v1All.filter((p) => p.requestId), ...v2Posted], chain.current, nowSec);
  // A post the agent sent but whose tick never persisted its record has no request id to name: listed by tx, never shown as a quote.
  const recordedTx = new Set(v2Posted.map((p) => lc(p.postedTx)));
  const unrecordedPosts = [...v1All.filter((p) => !p.requestId).map((p) => p.postedTx), ...(idx?.posts ?? []).filter((p) => !recordedTx.has(lc(p.postedTx))).map((p) => p.postedTx)];
  // Only fills on a strategy this maker shipped for Wick: the wallet is shared, and other strategies are not this agent's revenue.
  const fills = fillsOfOrders(all?.fills ?? [], live);
  const feesSinceShip = (token: string) => fills.filter((f) => lc(f.orderHash) === lc(live.hash) && lc(f.tokenIn) === lc(token)).reduce((sum, f) => sum + feeOf(f, FEE_BPS_V2), 0n).toString();
  const harvestRun = cron?.funding?.run?.harvest ? cron.funding.run : null;
  const fee = (token: string) => fills.filter((f) => lc(f.tokenIn) === lc(token)).reduce((sum, f) => sum + feeOf(f, FEE_BPS_V2), 0n).toString();
  const lastPost = [...(cron?.posted ?? [])].reverse().find((p) => (p as PostedQuote & { gasCostWei?: string }).gasCostWei) as (PostedQuote & { gasCostWei?: string }) | undefined;
  const ttl = [...(cron?.inferences ?? [])].reverse().find((r) => r.ttlSeconds)?.ttlSeconds ?? 900;
  const fundsWei = BigInt(cron?.budget.computeBalanceWei ?? chain.vaultWei.toString());
  const decision = cron?.funding?.lastDecision ?? null;
  const funded = cron?.funding?.funded ?? { usdc: "0", w0g: "0" };
  const funded0gWei = BigInt(funded.w0g) + BigInt(Math.floor(Number(funded.usdc) / 1e6 / chain.mid * 1e18));
  const economics = economicsOf({ fills, inferences, mid: chain.mid, ethUsd: chain.ethUsd, fundsWei, ttlSeconds: ttl, gasPerRequoteWei: lastPost?.gasCostWei ? BigInt(lastPost.gasCostWei) : null, fundingThresholdUsdc: decision?.thresholdUsdc ?? null, funded0gWei });
  const lastRun = economics.inferenceCostUsd;
  const budget = cron?.budget ?? { tier: "PAUSED" as const, model: null, spentTodayWei: "0", spendCapPerDayWei: process.env.SPEND_CAP_PER_DAY_WEI || "1000000000000000000", reason: "not_started", routerDepositWei: "0" };
  const claimed = { w0g: chain.strategy.w0g, usdc: chain.strategy.usdc };
  return {
    agent: AGENT,
    maker: AGENT,
    chainId: 8453,
    version: 2,
    contracts: { board: BOARD_V2, extruction: EXTRUCTION_V2, v1: { board: BOARD, extruction: EXTRUCTION, strategyHash: STRATEGY_HASH, docked: true }, deployTxs: V2_TXS },
    pair: { w0g: W0G, usdc: USDC },
    mid: chain.mid,
    spotMid: chain.spotMid,
    spotTwapGapBps: chain.gapBps,
    quotes,
    unrecordedPosts,
    budget: { tier: budget.tier, model: budget.model, computeBalanceWei: fundsWei.toString(), vaultWei: chain.vaultWei.toString(), routerDepositWei: budget.routerDepositWei ?? "0", spentTodayWei: budget.spentTodayWei, spendCapPerDayWei: budget.spendCapPerDayWei, reason: budget.reason, spendBasis: "router-billed total_cost" },
    fees: { accruedUsdc: fee(USDC), accruedW0g: fee(W0G) },
    fills: fills.map((f) => ({ txHash: f.txHash, orderHash: f.orderHash, taker: f.taker, tokenIn: f.tokenIn, amountIn: f.amountIn, amountOut: f.amountOut, timeMs: f.timeMs, feeUsdc: feeUsdc(f, FEE_BPS_V2, chain.mid), decisionsFunded: lastRun ? feeUsdc(f, FEE_BPS_V2, chain.mid) / lastRun : null })),
    distinctTakers: new Set(fills.map((f) => lc(f.taker)).filter((t) => t !== lc(AGENT))).size,
    funding: [
      ...FUNDING_EVIDENCE.map((f) => ({ ...f, source: "operator seed via the agent rail", ...(f.step === "ccip-send-w0g" ? { explorer: `https://ccip.chain.link/tx/${f.txHash}` } : {}) })),
      ...(cron?.funding?.history ?? []).filter((h) => h.ok).map((h) => ({ step: h.step, txHash: h.txHash, chainId: h.chainId, time: h.time, source: h.step.startsWith("harvest-") ? "fee harvest" : "accrued fees", ...(h.step === "ccip-send" ? { explorer: `https://ccip.chain.link/tx/${h.txHash}` } : {}) })),
    ],
    fundingMachine: { run: cron?.funding?.run ?? null, lastDecision: decision, funded },
    inferences,
    order: live.order,
    harvest: {
      hook: V4_HOOK.address,
      liveHash: live.hash,
      orderHashes,
      shipTx: live.shipTx,
      shippedAt: live.shippedAt,
      pastHashes: live.past,
      amounts: live.amounts,
      feesSinceShip: { usdc: feesSinceShip(USDC), w0g: feesSinceShip(W0G) },
      run: harvestRun ? { id: harvestRun.id, step: harvestRun.step, pending: harvestRun.pending, from: harvestRun.harvest!.from, to: harvestRun.harvest!.to, inventory: harvestRun.harvest!.inventory, released: harvestRun.harvest!.released, docked: harvestRun.harvest!.docked, shipped: harvestRun.harvest!.shipped, attempts: harvestRun.harvest!.attempts, txs: harvestRun.harvest!.txs } : null,
      last: cron?.funding?.lastHarvest ?? null,
      decision: cron?.funding?.lastHarvestDecision ?? null,
    },
    fundingThresholdUsdc: decision ? decision.thresholdUsdc.toFixed(6) : null,
    quoteTtlSeconds: ttl,
    quoteBudget: cron?.quoteBudget ?? null,
    strategy: { hash: live.hash, docked: chain.strategy.docked, w0g: claimed.w0g.toString(), usdc: claimed.usdc.toString(), feeBps: FEE_BPS_V2, maxDeviationBps: MAX_DEVIATION_BPS_V2 },
    strategyBacking: {
      w0g: { claimed: claimed.w0g.toString(), held: chain.wallet.w0g.toString(), backed: chain.wallet.w0g >= claimed.w0g },
      usdc: { claimed: claimed.usdc.toString(), held: chain.wallet.usdc.toString(), backed: chain.wallet.usdc >= claimed.usdc },
    },
    economics,
    seedVsEarned: { seed0g: Number(SEED_0G_WEI) / 1e18, earned0g: economics.earned0g, seedUsdc: Number(SEED_0G_WEI) / 1e18 * chain.mid, earnedUsdc: economics.earned0g * chain.mid },
    gasWei: chain.gasWei.toString(),
    readAt: { baseBlock: chain.baseBlock.toString(), zeroGBlock: chain.zeroGBlock.toString(), logsThroughBlock: idx?.cursor ?? null },
    lastTick: cron?.lastTick ?? null,
    lastTicks: cron?.lastTicks ?? [],
  };
}

/** One inference as the router reported it: billing, TEE verdict, provider, the decision, and the quotes it signed. */
export async function runRecord(kv: Kv | null, requestId: string) {
  const cron = kv ? ((await kv.get("cron-state", "json")) as CronState | null) : null;
  const rec = cron?.inferences.find((r) => r.requestId === requestId) ?? INFERENCE_EVIDENCE.find((r) => r.requestId === requestId);
  if (!rec) return null;
  const v1 = await readV1Index(kv).catch(() => null);
  const posted = [...v1Records(v1?.posts ?? [], cron?.posted ?? []), ...(cron?.posted ?? []).filter((p) => p.board && lc(p.board) === lc(BOARD_V2))].filter((p) => p.requestId === requestId);
  return { ...rec, billing: { currency: rec.currency, totalCost: rec.totalCost }, quotes: posted.map((p) => ({ tokenIn: p.tokenIn, tokenOut: p.tokenOut, rateE18: p.rateE18, maxAmountIn: p.maxAmountIn ?? null, expiry: p.expiry, inferenceId: p.inferenceId, postedTx: p.postedTx, board: p.board ?? BOARD })) };
}
