export type QuoteState = "idle" | "loading" | "ready" | "stale" | "error";
export type Phase = "idle" | "approving" | "simulating" | "swapping" | "confirming";

export type CtaInput = {
  connected: boolean;
  chainId: number | undefined;
  baseChainId: number;
  hasPrice: boolean;
  priceExpired: boolean;
  amount: bigint | null;
  balance: bigint | undefined;
  quote: QuoteState;
  allowance: bigint | undefined;
  phase: Phase;
  sellSymbol: string;
  /** Largest input the strategy can fill right now; above it the router reverts. */
  maxIn?: bigint | null;
};

export type Cta = { kind: "connect" | "switch" | "no-price" | "expired" | "enter" | "balance" | "quoting" | "stale" | "quote-error" | "approve" | "swap" | "busy" | "depth"; label: string; enabled: boolean };

/** The one button's state, in the order a taker would hit the problems. */
export function ctaFor(i: CtaInput): Cta {
  if (i.phase !== "idle") {
    const label = { approving: "Approving in your wallet", simulating: "Checking the price on chain", swapping: "Confirm the swap in your wallet", confirming: "Waiting for Base to confirm" }[i.phase];
    return { kind: "busy", label, enabled: false };
  }
  if (!i.connected) return { kind: "connect", label: "Connect wallet", enabled: true };
  if (i.chainId !== i.baseChainId) return { kind: "switch", label: "Switch to Base", enabled: true };
  if (!i.hasPrice) return { kind: "no-price", label: "Waiting for the agent's price", enabled: false };
  if (i.priceExpired) return { kind: "expired", label: "Price expired, new signature pending", enabled: false };
  if (i.amount === null) return { kind: "enter", label: "Enter an amount", enabled: false };
  if (i.maxIn != null && i.amount > i.maxIn) return { kind: "depth", label: "Above the pool's depth right now", enabled: false };
  if (i.balance !== undefined && i.amount > i.balance) return { kind: "balance", label: `Not enough ${i.sellSymbol}`, enabled: false };
  if (i.quote === "loading" || i.quote === "idle") return { kind: "quoting", label: "Getting the router quote", enabled: false };
  if (i.quote === "stale") return { kind: "stale", label: "Price is stale, swap refused", enabled: false };
  if (i.quote === "error") return { kind: "quote-error", label: "Router quote unavailable", enabled: false };
  if (i.allowance !== undefined && i.allowance < i.amount) return { kind: "approve", label: `Approve ${i.sellSymbol}`, enabled: true };
  return { kind: "swap", label: "Swap", enabled: true };
}
