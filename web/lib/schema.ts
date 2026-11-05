import { z } from "zod";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address");
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "hex");
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "tx hash");
const digits = z.union([z.string().regex(/^\d+$/, "unsigned integer string"), z.number().int().nonnegative().transform(String)]);
const timeLike = z.union([z.string().min(1), z.number().nonnegative()]);

export const tierSchema = z.enum(["NORMAL", "LOW", "CRITICAL", "PAUSED"]);
export type Tier = z.infer<typeof tierSchema>;

export const quoteSchema = z.object({
  tokenIn: address,
  tokenOut: address,
  rateE18: digits,
  expiry: digits,
  inferenceId: hex,
  requestId: z.string().min(1),
  postedTx: txHash.optional(),
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
  model: z.string().min(1),
  costWei: digits.nullable(),
  time: timeLike,
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
});
export type AgentStatus = z.infer<typeof statusSchema>;

export const routerQuoteSchema = z.object({
  amountIn: digits,
  amountOut: digits,
  orderHash: hex,
});
export type RouterQuote = z.infer<typeof routerQuoteSchema>;

export const errorBodySchema = z.object({ error: z.string() });
