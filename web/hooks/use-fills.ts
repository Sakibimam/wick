"use client";

import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { AGENT_URL } from "@/lib/config";
import type { Fill } from "@/lib/ledger";

export type FillsResult = { fills: Fill[]; fromBlock: bigint; toBlock: bigint; orderHash: string };

const fillsSchema = z.object({
  fills: z.array(z.object({ txHash: z.string(), block: z.string(), timeMs: z.number().nullable(), taker: z.string(), tokenIn: z.string(), tokenOut: z.string(), amountIn: z.string(), amountOut: z.string(), feeUsdc: z.number().nullable().optional().catch(undefined), decisionsFunded: z.number().nullable().optional().catch(undefined) })),
  fromBlock: z.string(),
  toBlock: z.string(),
  orderHash: z.string(),
});

/** Swapped events of the AquaSwapVMRouter for this strategy, decoded and filtered by maker on the server from the board's deploy block. */
export function useFills(order: unknown) {
  return useQuery({
    queryKey: ["fills"],
    enabled: Boolean(order),
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async ({ signal }): Promise<FillsResult> => {
      const res = await fetch(`${AGENT_URL}/api/fills`, { cache: "no-store", signal });
      const body: unknown = await res.json();
      if (!res.ok) throw new Error(typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${res.status}`);
      const d = fillsSchema.parse(body);
      return {
        fills: d.fills.map((f) => ({ txHash: f.txHash, blockNumber: BigInt(f.block), timeMs: f.timeMs, taker: f.taker, tokenIn: f.tokenIn, tokenOut: f.tokenOut, amountIn: BigInt(f.amountIn), amountOut: BigInt(f.amountOut), feeUsdc: f.feeUsdc ?? null, decisionsFunded: f.decisionsFunded ?? null })),
        fromBlock: BigInt(d.fromBlock),
        toBlock: BigInt(d.toBlock),
        orderHash: d.orderHash,
      };
    },
  });
}
