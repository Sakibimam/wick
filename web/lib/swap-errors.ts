import type { SwapFailure } from "./revert";

export type FailureCopy = { title: string; body: string };

export function failureCopy(kind: SwapFailure, sellSymbol: string, detail?: string): FailureCopy {
  switch (kind) {
    case "stale-quote":
      return { title: "The agent's price went stale, so the pool refused.", body: "Nothing was spent. The strategy only fills against a fresh signed price and fails closed. A new price appears on this page as soon as the agent signs one." };
    case "out-of-band":
      return { title: "The pool's price moved away from the signed price, so the swap was refused.", body: "Nothing was spent. Wick only fills while its signed price sits within a set band of the Uniswap average, which protects both sides from a stale or bent price. The agent requotes on its next tick." };
    case "too-large":
      return { title: "That amount is above what this signed price allows.", body: "Nothing was spent. Each signed price carries its own fill cap. Use Max to fill up to it." };
    case "no-depth":
      return { title: "The strategy does not hold enough to pay that out.", body: "Nothing was spent. Use Max to fill what the pool holds right now." };
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
