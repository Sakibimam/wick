import type { SwapFailure } from "./revert";

export type FailureCopy = { title: string; body: string };

export function failureCopy(kind: SwapFailure, sellSymbol: string, detail?: string): FailureCopy {
  switch (kind) {
    case "stale-quote":
      return { title: "The agent's price went stale, so the pool refused.", body: "Nothing was spent. The strategy only fills against a fresh signed price and fails closed. A new price appears on this page as soon as the agent signs one." };
    case "rejected":
      return { title: "You declined the request in your wallet.", body: "Nothing was sent." };
    case "insufficient-funds":
      return { title: `Your wallet cannot cover this swap.`, body: `It needs enough ${sellSymbol} for the amount and a little ETH on Base for gas.` };
    case "zero-amount":
      return { title: "That amount is too small to produce any output.", body: "Try a larger amount." };
    case "reverted":
      return { title: "The router rejected this swap, and the price was not the reason.", body: detail ? `Nothing was spent. ${detail}` : "Nothing was spent." };
    default:
      return { title: "The swap did not go through.", body: detail ?? "Nothing was spent." };
  }
}
