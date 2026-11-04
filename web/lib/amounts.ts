import { formatUnits, parseUnits } from "viem";

/** Decimal-string amount or raw integer string, to base units. A "." means already decimal. */
export function toBaseUnits(value: string, decimals: number): bigint {
  return value.includes(".") ? parseUnits(value, decimals) : BigInt(value);
}

/** Trim a decimal string to at most `max` fraction digits without rounding up, drop trailing zeros. */
export function trimDecimals(value: string, max: number): string {
  const [whole = "0", frac = ""] = value.split(".");
  const f = frac.slice(0, max).replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole;
}

export function groupDigits(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function formatAmount(units: bigint, decimals: number, maxFraction = 4): string {
  const [whole = "0", frac] = trimDecimals(formatUnits(units, decimals), maxFraction).split(".");
  return frac ? `${groupDigits(whole)}.${frac}` : groupDigits(whole);
}

/** Parse what a person typed. Returns null for empty, partial or invalid input and for more fraction digits than the token has. */
export function parseTyped(value: string, decimals: number): bigint | null {
  const v = value.trim();
  if (!/^\d*\.?\d*$/.test(v) || v === "" || v === ".") return null;
  const frac = v.split(".")[1] ?? "";
  if (frac.length > decimals) return null;
  const units = parseUnits(v, decimals);
  return units > 0n ? units : null;
}

export function percentOf(part: bigint, whole: bigint): number {
  if (whole <= 0n) return 0;
  return Math.min(100, Number((part * 10_000n) / whole) / 100);
}

export function truncateHex(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
