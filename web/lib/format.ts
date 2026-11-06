// The one place a figure becomes text. Every amount, price, block, countdown and hash on the site goes through here,
// so the same value reads the same way on every surface.

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function fixed(n: number, dp: number): string {
  const [whole = "0", frac] = Math.abs(n).toFixed(dp).split(".");
  return `${n < 0 ? "-" : ""}${group(whole)}${frac ? `.${frac}` : ""}`;
}

/** `digits` significant figures, never in exponent form, grouped. Zero reads 0.00. */
export function significant(n: number, digits: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "0.00";
  const r = Number(n.toPrecision(digits));
  const dp = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.abs(r))));
  return fixed(r, dp);
}

/** USDC: 2 decimals, or 2 significant figures under 0.01 so a fee of 0.0003 is not shown as 0.00. */
export function fmtUsdc(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n === 0) return "0.00";
  return Math.abs(n) >= 0.01 ? fixed(n, 2) : significant(n, 2);
}

export const fmtUsd = (n: number) => `$${fmtUsdc(n)}`;

/** 0G and W0G: 4 significant figures. */
export const fmt0g = (n: number) => significant(n, 4);

/** A USDC-per-W0G price: 4 significant figures, so bid and ask stay apart. */
export const fmtPrice = (n: number) => significant(n, 4);

export const fmtPct = (n: number) => (n === 0 ? "0%" : Math.abs(n) >= 10 ? `${Math.round(n)}%` : `${significant(n, 2)}%`);

export type Unit = "USDC" | "W0G" | "0G";
export const DECIMALS: Record<Unit, number> = { USDC: 6, W0G: 18, "0G": 18 };

/** Base units of a token to a plain number of whole tokens. Display only; never feeds back into a transaction. */
export const toNumber = (units: bigint | string, unit: Unit) => Number(BigInt(units)) / 10 ** DECIMALS[unit];

/** Base units to display text in that token's rule. */
export function fmtUnits(units: bigint | string, unit: Unit): string {
  const n = toNumber(units, unit);
  return unit === "USDC" ? fmtUsdc(n) : fmt0g(n);
}

export const fmtBlock = (b: bigint | string | number) => group(BigInt(b).toString());

/** One truncation rule for every hash, address and id: 0x plus 4, an ellipsis, the last 4. Ids without 0x keep 4 and 4. */
export function shortHash(value: string): string {
  const head = value.startsWith("0x") ? 6 : 4;
  return value.length <= head + 5 ? value : `${value.slice(0, head)}…${value.slice(-4)}`;
}

/** mm:ss under an hour, h:mm:ss over it. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}

/** The single countdown notation: "expires in 24:10", or how long ago it expired. */
export function countdown(secondsLeft: number): string {
  return secondsLeft > 0 ? `expires in ${clock(secondsLeft)}` : `expired ${duration(-secondsLeft * 1000)} ago`;
}

/** A span of time in the largest sensible unit. */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

export function relativeTime(ms: number, nowMs: number): string {
  const d = nowMs - ms;
  return d < 5000 ? "just now" : `${duration(d)} ago`;
}

export function utcStamp(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const two = (n: number) => String(n).padStart(2, "0");
  return `${mon} ${d.getUTCDate()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} UTC`;
}
