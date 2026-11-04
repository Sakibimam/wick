import { BaseError, toFunctionSelector, UserRejectedRequestError } from "viem";

export type SwapFailure = "stale-quote" | "rejected" | "insufficient-funds" | "zero-amount" | "reverted" | "unknown";

const STALE = toFunctionSelector("StaleQuote()");
const ZERO = toFunctionSelector("ZeroSwapAmount()");

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
  if (/exceeds balance|insufficient funds|transfer amount exceeds/i.test(err.message)) return "insufficient-funds";
  if (/StaleQuote/.test(err.message)) return "stale-quote";
  if (/reverted/i.test(err.message)) return quoteExpired ? "stale-quote" : "reverted";
  return "unknown";
}

/** Same classification for the agent quote endpoint, which answers with an error string when the router refuses. */
export function classifyQuoteError(message: string): "stale-quote" | "other" {
  return /stale|expired|revert|no quote/i.test(message) ? "stale-quote" : "other";
}
