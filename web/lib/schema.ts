import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address");
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "hex");
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "tx hash");
const digits = z.union([z.string().regex(/^\d+$/, "unsigned integer string"), z.number().int().nonnegative().transform(String)]);
const timeLike = z.union([z.string().min(1), z.number().nonnegative()]);

const tickSchema = z.object({ at: z.string(), outcome: z.string() });
// Fields another service is still rolling out: a shape this page does not expect is dropped, never fatal.
const soft = <T extends z.ZodType>(t: T) => t.optional().catch(undefined);
// A figure the agent may send as a number or a decimal string; null means it could not be computed.
const num = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?(e-?\d+)?$/i).transform(Number)]).nullable();

export const tierSchema = z.enum(["NORMAL", "LOW", "CRITICAL", "PAUSED"]);
export type Tier = z.infer<typeof tierSchema>;

export const quoteSchema = z.object({
  tokenIn: address,
  tokenOut: address,
  rateE18: digits,
  expiry: digits,
  inferenceId: hex,
  requestId: z.string().min(1).nullable(),
  postedTx: txHash.optional(),
  // Per-quote fill cap the agent signs on the v2 board.
  maxAmountIn: soft(digits.nullable()),
});
export type AgentQuote = z.infer<typeof quoteSchema>;

export const fundingSchema = z.object({
  step: z.string().min(1),
  txHash: txHash,
  chainId: z.number().int().positive(),
  time: timeLike,
});
export type FundingStep = z.infer<typeof fundingSchema>;

export const inferenceSchema = z.object({
  requestId: z.string().min(1),
  model: z.string().min(1).nullable(),
  // x_0g_trace.billing.total_cost: wei when currency is "0g", micro-USD when "usd".
  currency: z.string().nullable().optional(),
  totalCost: digits.nullable().optional(),
  time: timeLike,
  // What the run decided, when the agent reports it.
  reason: soft(z.string().nullable()),
  skewBps: soft(z.number().nullable()),
  maxAmountIn: soft(digits.nullable()),
  ttlSeconds: soft(z.number().nullable()),
});
export type Inference = z.infer<typeof inferenceSchema>;

export const statusSchema = z.object({
  agent: address,
  maker: address,
  chainId: z.number().int().positive(),
  pair: z.object({ w0g: address, usdc: address }),
  mid: z.number().positive().nullable(),
  quotes: z.array(quoteSchema),
  budget: z.object({
    tier: tierSchema,
    model: z.string().nullable(),
    computeBalanceWei: digits,
    spentTodayWei: digits,
    spendCapPerDayWei: digits,
    reason: z.string(),
  }),
  fees: z.object({ accruedUsdc: z.string(), accruedW0g: z.string() }),
  funding: z.array(fundingSchema),
  inferences: z.array(inferenceSchema),
  order: z.object({ maker: address, traits: hex, data: hex }),
  fundingThresholdUsdc: z.string().regex(/^\d+(\.\d+)?$/, "decimal").nullable().optional(),
  quoteTtlSeconds: z.number().int().positive().optional(),
  // Served by the Worker status route; the fork-dev status server omits them.
  strategy: z.object({ hash: hex, w0g: digits, usdc: digits, feeBps: z.number().int().nonnegative() }).optional(),
  gasWei: digits.optional(),
  readAt: z.object({ baseBlock: digits, zeroGBlock: digits, logsThroughBlock: digits.nullable() }).optional(),
  lastTick: tickSchema.nullable().optional(),
  lastTicks: soft(z.array(tickSchema)),
  // Loop economics computed by the agent. Each field is optional; the UI derives what is missing from the fields above.
  economics: soft(z.object({
    feesEarnedUsdc: num,
    aiSpentUsd: num,
    coverage: num,
    runsPaidByFees: num,
    fundingThresholdUsdc: num,
    breakEvenFillUsdcPerRun: num,
    runwayDays: num,
    inferenceCostUsd: num,
  }).partial()),
  seedVsEarned: soft(z.object({ seedUsdc: num, earnedUsdc: num }).partial().nullable()),
  distinctTakers: soft(z.number().int().nonnegative()),
});
export type AgentStatus = z.infer<typeof statusSchema>;

export const routerQuoteSchema = z.object({
  amountIn: digits,
  amountOut: digits,
  orderHash: hex,
  maxAmountIn: soft(digits.nullable()),
  maxAmountOut: soft(digits.nullable()),
  depthLimited: soft(z.boolean()),
});
export type RouterQuote = z.infer<typeof routerQuoteSchema>;

export const errorBodySchema = z.object({ error: z.string() });
