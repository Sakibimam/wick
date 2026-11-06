import { TOKENS } from "./config";
import { formatAmount, toBaseUnits } from "./amounts";
import { describeStep, sortFunding, toMillis } from "./funding";
import type { AgentStatus, FundingStep, Inference } from "./schema";

export type Fill = {
  txHash: string;
  blockNumber: bigint;
  timeMs: number | null;
  taker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
};

export type Loop = {
  fills: Fill[];
  accruedUsdc: bigint;
  accruedW0g: bigint;
  funding: FundingStep[];
  inferences: Inference[];
  signedPrices: number;
};

/** Fee fields may be raw base units or decimal strings; both are read into base units. */
export function buildLoop(status: AgentStatus, fills: Fill[]): Loop {
  return {
    fills: [...fills].sort((a, b) => Number(b.blockNumber - a.blockNumber)),
    accruedUsdc: toBaseUnits(status.fees.accruedUsdc, TOKENS.USDC.decimals),
    accruedW0g: toBaseUnits(status.fees.accruedW0g, TOKENS.W0G.decimals),
    funding: sortFunding(status.funding),
    inferences: [...status.inferences].sort((a, b) => (toMillis(b.time) ?? 0) - (toMillis(a.time) ?? 0)),
    signedPrices: status.quotes.length,
  };
}

export type LoopState = "no-activity" | "fees-only" | "funded" | "paying";

export function loopState(loop: Loop): LoopState {
  if (loop.inferences.length > 0 && loop.funding.length > 0) return "paying";
  if (loop.funding.length > 0) return "funded";
  if (loop.fills.length > 0 || loop.accruedUsdc > 0n || loop.accruedW0g > 0n) return "fees-only";
  return "no-activity";
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One sentence that states the loop result from the rows beneath it, nothing else. */
export function loopSentence(loop: Loop): string {
  const state = loopState(loop);
  const usdc = `${formatAmount(loop.accruedUsdc, TOKENS.USDC.decimals, 6)} USDC`;
  if (state === "no-activity") {
    return loop.signedPrices > 0
      ? `The agent has signed ${plural(loop.signedPrices, "price", "prices")}. No taker has filled against them yet, so no fee has reached its AI account.`
      : "No fill has paid the agent yet, so there is nothing to trace.";
  }
  if (state === "fees-only") return `Takers have paid ${usdc} in fees. It has not been turned into AI money yet.`;
  const steps = plural(loop.funding.filter((f) => describeStep(f.step).kind !== "charge").length, "funding step", "funding steps");
  if (state === "funded") return `Takers paid ${usdc} in fees and the agent recorded ${steps}. No AI run has been paid yet.`;
  return `Takers paid ${usdc} in fees. ${steps} moved money into the agent's AI account, and the 0G router billed ${plural(loop.inferences.length, "AI run", "AI runs")} against it.`;
}
