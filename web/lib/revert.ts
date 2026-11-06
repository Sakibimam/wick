import { BaseError, toFunctionSelector, UserRejectedRequestError } from "viem";

export type SwapFailure = "stale-quote" | "out-of-band" | "too-large" | "no-depth" | "rejected" | "insufficient-funds" | "zero-amount" | "reverted" | "unknown";

const STALE = toFunctionSelector("StaleQuote()");
const ZERO = toFunctionSelector("ZeroSwapAmount()");
// AgentQuoteExtructionV2 errors.
const V2: [string, QuoteRefusal][] = [
  [toFunctionSelector("QuoteExpired(uint64)"), "stale-quote"],
  [toFunctionSelector("PriceOutOfBand(uint256,uint256,uint16)"), "out-of-band"],
  [toFunctionSelector("AmountInTooLarge(uint256,uint256)"), "too-large"],
  [toFunctionSelector("InsufficientDepth(uint256,uint256)"), "no-depth"],
];
type QuoteRefusal = "stale-quote" | "out-of-band" | "too-large" | "no-depth";
const V2_NAMES: [RegExp, QuoteRefusal][] = [[/QuoteExpired/, "stale-quote"], [/PriceOutOfBand/, "out-of-band"], [/AmountInTooLarge/, "too-large"], [/InsufficientDepth/, "no-depth"]];

function revertData(err: unknown): string | null {
  if (!(err instanceof BaseError)) return null;
  const hit = err.walk((e) => typeof (e as { data?: unknown }).data === "string" && /^0x[0-9a-fA-F]{8,}/.test((e as { data: string }).data));
  return hit ? (hit as unknown as { data: string }).data : null;
}

/** Classify a failed simulate or write. Stale means the pool refused because the signed quote is expired or replaced. */
export function classifyFailure(err: unknown, quoteExpired: boolean): SwapFailure {
  if (!(err instanceof BaseError)) return "unknown";
  if (err.walk((e) => e instanceof UserRejectedRequestError)) return "rejected";
  const data = revertData(err)?.toLowerCase() ?? "";
  if (data.startsWith(STALE.toLowerCase())) return "stale-quote";
  if (data.startsWith(ZERO.toLowerCase())) return "zero-amount";
  for (const [sel, kind] of V2) if (data.startsWith(sel.toLowerCase())) return kind;
  for (const [re, kind] of V2_NAMES) if (re.test(err.message)) return kind;
  if (/exceeds balance|insufficient funds|transfer amount exceeds/i.test(err.message)) return "insufficient-funds";
  if (/StaleQuote/.test(err.message)) return "stale-quote";
  if (/reverted/i.test(err.message)) return quoteExpired ? "stale-quote" : "reverted";
  return "unknown";
}

/** Same classification for the agent quote endpoint, which answers with an error string when the router refuses. */
export function classifyQuoteError(message: string): QuoteRefusal | "other" {
  for (const [re, kind] of V2_NAMES) if (re.test(message)) return kind;
  return /stale|expired|no quote/i.test(message) ? "stale-quote" : "other";
}
