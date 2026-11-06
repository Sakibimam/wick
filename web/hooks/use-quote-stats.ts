"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { QUOTES_API } from "@/lib/config";

const statsSchema = z.object({ paidQuotes: z.number().int().nonnegative(), revenueUsdc: z.union([z.string(), z.number()]).transform(Number), distinctPayers: z.number().int().nonnegative(), lastSettlementTx: z.string().nullable() });
export type QuoteStats = z.infer<typeof statsSchema>;

/** The x402 quote feed's own counters: signed prices other agents paid for. */
export function useQuoteStats() {
  return useQuery({
    queryKey: ["quote-stats"],
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async ({ signal }) => statsSchema.parse(await (await fetch(`${QUOTES_API}/v1/stats`, { signal, cache: "no-store" })).json()),
  });
}
