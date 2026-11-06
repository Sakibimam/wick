import { keccak256, toHex, type Hex } from "viem";
import type { CronState } from "../../agent/src/worker-tick";
import { AGENT, FUNDING_EVIDENCE, INFERENCE_EVIDENCE, STRATEGY_HASH } from "../lib/evidence";
import { USDC, W0G } from "../lib/config";
import order from "../lib/live-order.json";
import { readChain, readLogIndex, type Kv } from "./chain";

const FEE_BPS = BigInt(order.pair.feeBps);

/** The status document the swap and ledger pages render: chain reads first, then the cron's KV record for what only the agent knows. */
export async function buildStatus(kv: Kv | null) {
  const [chain, idx, cron] = await Promise.all([readChain(), readLogIndex(kv).catch(() => null), kv ? (kv.get("cron-state", "json") as Promise<CronState | null>) : Promise.resolve(null)]);
  const inferences = [
    ...INFERENCE_EVIDENCE.map((r) => ({ ...r })),
    ...(cron?.inferences ?? []).map((r) => ({ requestId: r.requestId, model: r.model, currency: r.currency, totalCost: r.totalCost, time: r.time })),
  ];
  // inferenceId on chain is keccak256(requestId + tokenIn + tokenOut), so a known request id names the AI run behind each posted quote.
  const byInference = new Map<string, string>();
  for (const { requestId } of inferences) for (const [a, b] of [[USDC, W0G], [W0G, USDC]]) byInference.set(keccak256(toHex(requestId + a + b)).toLowerCase(), requestId);
  const postedTx = new Map((idx?.posts ?? []).map((p) => [`${p.inferenceId.toLowerCase()}:${p.expiry}`, p.postedTx]));
  const seen = new Set<string>();
  const quotes = [
    ...chain.current.map((q) => ({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, rateE18: q.rateE18.toString(), expiry: q.expiry.toString(), inferenceId: q.inferenceId as Hex })),
    ...(idx?.posts ?? []),
  ].filter((q) => { const k = `${q.inferenceId.toLowerCase()}:${q.expiry}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .map((q) => ({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, rateE18: q.rateE18, expiry: q.expiry, inferenceId: q.inferenceId, requestId: byInference.get(q.inferenceId.toLowerCase()) ?? null, postedTx: postedTx.get(`${q.inferenceId.toLowerCase()}:${q.expiry}`) }));
  // The strategy charges feeBps on the input amount, so each fill's fee is exact from its own event.
  const fills = idx?.fills ?? [];
  const fee = (token: string) => fills.filter((f) => f.tokenIn.toLowerCase() === token.toLowerCase()).reduce((sum, f) => sum + (BigInt(f.amountIn) * FEE_BPS) / 10_000n, 0n).toString();
  const budget = cron?.budget ?? { tier: "PAUSED" as const, model: null, spentTodayWei: "0", spendCapPerDayWei: process.env.SPEND_CAP_PER_DAY_WEI || "1000000000000000000", reason: "not_started" };
  return {
    agent: AGENT,
    maker: AGENT,
    chainId: 8453,
    pair: { w0g: W0G, usdc: USDC },
    mid: chain.mid,
    quotes,
    budget: { tier: budget.tier, model: budget.model, computeBalanceWei: chain.vaultWei.toString(), spentTodayWei: budget.spentTodayWei, spendCapPerDayWei: budget.spendCapPerDayWei, reason: budget.reason },
    fees: { accruedUsdc: fee(USDC), accruedW0g: fee(W0G) },
    funding: FUNDING_EVIDENCE.map((f) => ({ ...f })),
    inferences,
    order: order.order,
    fundingThresholdUsdc: process.env.FUNDING_THRESHOLD_USDC || "10",
    quoteTtlSeconds: Number(process.env.QUOTE_TTL_SECONDS || "3600"),
    strategy: { hash: STRATEGY_HASH, w0g: chain.strategy.w0g.toString(), usdc: chain.strategy.usdc.toString(), feeBps: order.pair.feeBps },
    gasWei: chain.gasWei.toString(),
    readAt: { baseBlock: chain.baseBlock.toString(), zeroGBlock: chain.zeroGBlock.toString(), logsThroughBlock: idx?.cursor ?? null },
    lastTick: cron?.lastTick ?? null,
  };
}
