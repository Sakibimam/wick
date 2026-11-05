"use client";

import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";
import { AQUA_ROUTER, FILL_FROM_BLOCK, FILL_LOOKBACK_BLOCKS, LOG_CHUNK_BLOCKS } from "@/lib/config";
import { routerAbi } from "@/lib/abis";
import type { Fill } from "@/lib/ledger";
import type { AgentStatus } from "@/lib/schema";

export type FillsResult = { fills: Fill[]; fromBlock: bigint; toBlock: bigint; orderHash: string };

/**
 * Swapped events from the AquaSwapVMRouter for this strategy, read from Base.
 * The event does not index the order hash, so the window is bounded (FILL_LOOKBACK_BLOCKS, or from the
 * ship block when FILL_FROM_BLOCK is known, chunked at LOG_CHUNK_BLOCKS per request) and matched by hash client side.
 */
export function useFills(order: AgentStatus["order"] | undefined) {
  const client = usePublicClient({ chainId: base.id });
  return useQuery({
    queryKey: ["fills", order?.maker, order?.traits, order?.data],
    enabled: Boolean(client && order),
    refetchInterval: 30_000,
    retry: 1,
    queryFn: async (): Promise<FillsResult> => {
      if (!client || !order) throw new Error("not ready");
      const orderHash = await client.readContract({
        address: AQUA_ROUTER,
        abi: routerAbi,
        functionName: "hash",
        args: [{ maker: order.maker as `0x${string}`, traits: BigInt(order.traits), data: order.data as `0x${string}` }],
      });
      const latest = await client.getBlockNumber();
      const lookbackStart = latest > BigInt(FILL_LOOKBACK_BLOCKS) ? latest - BigInt(FILL_LOOKBACK_BLOCKS) : 0n;
      const fromBlock = FILL_FROM_BLOCK !== null && FILL_FROM_BLOCK > lookbackStart ? (FILL_FROM_BLOCK > latest ? latest : FILL_FROM_BLOCK) : lookbackStart;
      const chunks: Array<[bigint, bigint]> = [];
      for (let start = fromBlock; start <= latest; start += BigInt(LOG_CHUNK_BLOCKS)) {
        const end = start + BigInt(LOG_CHUNK_BLOCKS) - 1n;
        chunks.push([start, end > latest ? latest : end]);
      }
      const event = routerAbi.find((i) => i.type === "event" && i.name === "Swapped")!;
      const pages = await Promise.all(
        chunks.map(([a, b]) => client.getLogs({ address: AQUA_ROUTER, event, fromBlock: a, toBlock: b })),
      );
      const mine = pages.flat().filter((l) => l.args.orderHash?.toLowerCase() === orderHash.toLowerCase());
      const newest = mine.sort((a, b) => Number(b.blockNumber - a.blockNumber)).slice(0, 25);
      const blockTimes = new Map<bigint, number>();
      await Promise.all(
        [...new Set(newest.map((l) => l.blockNumber))].map(async (n) => {
          const block = await client.getBlock({ blockNumber: n });
          blockTimes.set(n, Number(block.timestamp) * 1000);
        }),
      );
      const fills: Fill[] = newest.map((l) => ({
        txHash: l.transactionHash,
        blockNumber: l.blockNumber,
        timeMs: blockTimes.get(l.blockNumber) ?? null,
        taker: l.args.taker!,
        tokenIn: l.args.tokenIn!,
        tokenOut: l.args.tokenOut!,
        amountIn: l.args.amountIn!,
        amountOut: l.args.amountOut!,
      }));
      return { fills, fromBlock, toBlock: latest, orderHash };
    },
  });
}
