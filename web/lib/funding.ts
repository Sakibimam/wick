import { EXPLORERS } from "./config";
import type { FundingStep } from "./schema";

export type StageKind = "approve" | "swap" | "bridge" | "withdraw" | "deposit" | "other";

export type StageInfo = { kind: StageKind; title: string; plain: string; tech: string };

/** Funding step ids come from the agent (approve-usdc, swap-usdc-to-w0g, ccip-send-w0g, withdraw-w0g-0g, deposit-payment-layer). */
export function describeStep(step: string): StageInfo {
  const s = step.toLowerCase();
  if (s.includes("approve")) return { kind: "approve", title: "Spending approval", plain: "Lets the next contract move the tokens for this step.", tech: "approve" };
  if (s.includes("swap")) return { kind: "swap", title: "Fees swapped to 0G", plain: "Dollar fees bought wrapped 0G on Uniswap.", tech: "Uniswap swap" };
  if (s.includes("ccip") || s.includes("bridge") || s.includes("send")) return { kind: "bridge", title: "Sent to the 0G chain", plain: "Wrapped 0G crossed from Base to the 0G chain.", tech: "CCIP send" };
  if (s.includes("withdraw")) return { kind: "withdraw", title: "Unwrapped to native 0G", plain: "Wrapped 0G became the coin that pays for compute.", tech: "withdraw" };
  if (s.includes("deposit")) return { kind: "deposit", title: "Deposited for AI runs", plain: "0G went into the 0G Payment Layer account that pays for the agent's AI runs.", tech: "depositFor" };
  return { kind: "other", title: step, plain: "Funding step reported by the agent.", tech: step };
}

export function txUrl(chainId: number, hash: string): string | null {
  return EXPLORERS[chainId]?.tx(hash) ?? null;
}

/** Epoch seconds, epoch milliseconds or an ISO string, to epoch milliseconds. Null when unreadable. */
export function toMillis(time: string | number): number | null {
  if (typeof time === "number") return time < 1e12 ? time * 1000 : time;
  if (/^\d+$/.test(time)) return toMillis(Number(time));
  const ms = Date.parse(time);
  return Number.isNaN(ms) ? null : ms;
}

export function sortFunding(steps: FundingStep[]): FundingStep[] {
  return [...steps].sort((a, b) => (toMillis(a.time) ?? 0) - (toMillis(b.time) ?? 0));
}
