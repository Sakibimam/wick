"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";

/** Block timestamp (seconds) of the transaction that posted a quote. Immutable once mined, so cached for good. */
export function usePostedAt(txHash: string | undefined): number | null {
  const client = usePublicClient({ chainId: base.id });
  const { data } = useQuery({
    queryKey: ["posted-at", txHash],
    enabled: Boolean(client && txHash),
    staleTime: Infinity,
    retry: 2,
    queryFn: async () => {
      const receipt = await client!.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const block = await client!.getBlock({ blockNumber: receipt.blockNumber });
      return Number(block.timestamp);
    },
  });
  return data ?? null;
}
