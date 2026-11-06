"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";
import { gasRunwayDays } from "@/lib/machine";
import type { AgentStatus } from "@/lib/schema";

/** What one postPair cost the agent in Base wei: execution gas times its price, plus the L1 data fee Base charges. */
export function usePostCost(txHash: string | undefined): bigint | null {
  const client = usePublicClient({ chainId: base.id });
  const { data } = useQuery({
    queryKey: ["post-cost", txHash],
    enabled: Boolean(client && txHash),
    staleTime: Infinity,
    retry: 2,
    queryFn: async () => {
      const r = await client!.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const l1 = (r as { l1Fee?: bigint | null }).l1Fee ?? 0n;
      return (r.gasUsed * r.effectiveGasPrice + l1).toString();
    },
  });
  return data ? BigInt(data) : null;
}

/** Days of requotes the agent's Base gas still pays for, from the cost of its latest post and the cadence the status reports. */
export function useGasRunway(status: AgentStatus | undefined): { days: number; costWei: bigint; perDay: number } | null {
  const latest = status ? [...status.quotes].filter((q) => q.postedTx).sort((a, b) => Number(BigInt(b.expiry) - BigInt(a.expiry)))[0] : undefined;
  const cost = usePostCost(latest?.postedTx);
  if (!status?.gasWei || cost === null) return null;
  const perDay = status.economics?.requotesPerDay ?? 288;
  const days = gasRunwayDays(BigInt(status.gasWei), cost, perDay);
  return days === null ? null : { days, costWei: cost, perDay };
}
