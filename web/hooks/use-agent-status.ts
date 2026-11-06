"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/agent-api";
import { statusSchema, type AgentStatus } from "@/lib/schema";

export const STATUS_POLL_MS = 5_000;
const TIMEOUT_MS = 12_000;
const KEY = "wick:last-good-status";

/** The last status that parsed, kept in the browser so a 500 or a slow read never blanks the page. */
function lastGood(): { data: AgentStatus; at: number } | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as { data: unknown; at: number } | null;
    const parsed = raw ? statusSchema.safeParse(raw.data) : null;
    return parsed?.success ? { data: parsed.data, at: raw!.at } : undefined;
  } catch {
    return undefined;
  }
}

export function useAgentStatus() {
  const q = useQuery({
    queryKey: ["agent-status"],
    queryFn: ({ signal }) => fetchStatus(AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])),
    refetchInterval: STATUS_POLL_MS,
    retry: 1,
  });
  const client = useQueryClient();
  // Seeded after mount, not as initialData, so the server render and the first client render agree.
  useEffect(() => {
    if (client.getQueryData(["agent-status"])) return;
    const lg = lastGood();
    if (lg) client.setQueryData(["agent-status"], lg.data, { updatedAt: lg.at });
  }, [client]);
  useEffect(() => {
    if (q.data && q.isSuccess && q.dataUpdatedAt) {
      try { window.localStorage.setItem(KEY, JSON.stringify({ data: q.data, at: q.dataUpdatedAt })); } catch { /* storage full or disabled: the in-memory copy still holds */ }
    }
  }, [q.data, q.isSuccess, q.dataUpdatedAt]);
  return q;
}
