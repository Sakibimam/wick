import type { Tier } from "./schema";

export type TierEntry = { tier: Tier; reason: string; atMs: number };

export const TIER_HISTORY_KEY = "upkeep.tier-history.v1";
const MAX_ENTRIES = 50;

/** Append only when the tier differs from the newest entry. Returns the same array when nothing changed. */
export function recordTier(history: TierEntry[], tier: Tier, reason: string, atMs: number): TierEntry[] {
  const last = history[history.length - 1];
  if (last && last.tier === tier) return history;
  return [...history, { tier, reason, atMs }].slice(-MAX_ENTRIES);
}

export function parseHistory(raw: string | null): TierEntry[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (v): v is TierEntry =>
        typeof v === "object" && v !== null && ["NORMAL", "LOW", "CRITICAL", "PAUSED"].includes((v as TierEntry).tier) && typeof (v as TierEntry).atMs === "number" && typeof (v as TierEntry).reason === "string",
    );
  } catch (e) {
    if (e instanceof SyntaxError) return [];
    throw e;
  }
}
