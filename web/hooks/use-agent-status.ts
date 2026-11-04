"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchStatus } from "@/lib/agent-api";

export const STATUS_POLL_MS = 5_000;

export function useAgentStatus() {
  return useQuery({
    queryKey: ["agent-status"],
    queryFn: ({ signal }) => fetchStatus(signal),
    refetchInterval: STATUS_POLL_MS,
    retry: 1,
  });
}
