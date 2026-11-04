"use client";

import { useEffect, useState } from "react";
import type { Tier } from "@/lib/schema";
import { parseHistory, recordTier, TIER_HISTORY_KEY, type TierEntry } from "@/lib/tier-history";

/** Tier changes this browser has seen from the status API. The API reports only the current tier. */
export function useTierHistory(current: { tier: Tier; reason: string } | null): TierEntry[] {
  const [history, setHistory] = useState<TierEntry[]>([]);
  useEffect(() => {
    setHistory(parseHistory(window.localStorage.getItem(TIER_HISTORY_KEY)));
  }, []);
  const tier = current?.tier;
  const reason = current?.reason;
  useEffect(() => {
    if (!tier || reason === undefined) return;
    setHistory((prev) => {
      const stored = parseHistory(window.localStorage.getItem(TIER_HISTORY_KEY));
      const base = stored.length > prev.length ? stored : prev;
      const next = recordTier(base, tier, reason, Date.now());
      if (next !== base) window.localStorage.setItem(TIER_HISTORY_KEY, JSON.stringify(next));
      return next;
    });
  }, [tier, reason]);
  return history;
}
