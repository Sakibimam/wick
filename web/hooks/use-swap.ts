"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseEventLogs } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { base } from "wagmi/chains";
import { AQUA_ROUTER, TAKER_TRAITS_EXACT_IN, type TokenSymbol, TOKENS } from "@/lib/config";
import { erc20Abi, routerAbi } from "@/lib/abis";
import { classifyFailure, type SwapFailure } from "@/lib/revert";
import type { AgentStatus } from "@/lib/schema";
import type { Phase } from "@/lib/cta";

export type SwapResult = { hash: `0x${string}`; amountIn: bigint; amountOut: bigint; tokenIn: TokenSymbol; tokenOut: TokenSymbol };
export type SwapProblem = { kind: SwapFailure; detail: string };

const RECEIPT = { retryCount: 8, retryDelay: 1_000, timeout: 90_000 } as const;
// Explicit EIP-1559 fees from the latest Base block: wallets that fall back to a 1 gwei tip overpay on Base by orders of magnitude.
const PRIORITY_WEI = 1_000_000n;
async function fees(client: NonNullable<ReturnType<typeof usePublicClient>>) {
  const baseFee = (await client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
  return { type: "eip1559" as const, maxPriorityFeePerGas: PRIORITY_WEI, maxFeePerGas: baseFee * 2n + PRIORITY_WEI };
}
const firstLine = (e: unknown) => (e instanceof Error ? (("shortMessage" in e && typeof e.shortMessage === "string" ? e.shortMessage : e.message).split("\n")[0] ?? "") : String(e));

export function useSwapFlow(opts: { account: `0x${string}` | undefined; order: AgentStatus["order"] | undefined; tokenIn: TokenSymbol; tokenOut: TokenSymbol; amount: bigint | null; quoteExpired: () => boolean; onSettled: () => void }) {
  const client = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<SwapProblem | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const { account, order, tokenIn, tokenOut, amount, quoteExpired, onSettled } = opts;

  useEffect(() => {
    setProblem(null);
  }, [amount, tokenIn]);

  const fail = useCallback((e: unknown) => {
    setProblem({ kind: classifyFailure(e, quoteExpired()), detail: firstLine(e) });
    setPhase("idle");
  }, [quoteExpired]);

  const approve = useMutation({
    mutationFn: async () => {
      if (!client || !account || !amount) throw new Error("not ready");
      setProblem(null);
      setPhase("approving");
      const hash = await writeContractAsync({ address: TOKENS[tokenIn].address, abi: erc20Abi, functionName: "approve", args: [AQUA_ROUTER, amount], chainId: base.id, ...(await fees(client)) });
      const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
      if (receipt.status !== "success") throw new Error("The approval transaction reverted.");
      // Load-balanced RPCs can answer from a node behind the approval block; the swap simulation would then fail on allowance.
      for (let i = 0; (await client.readContract({ address: TOKENS[tokenIn].address, abi: erc20Abi, functionName: "allowance", args: [account, AQUA_ROUTER] })) < amount; i++) {
        if (i >= 15) throw new Error("The approval confirmed but the RPC has not shown it after 30 seconds.");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
    onError: fail,
    onSuccess: () => { setPhase("idle"); onSettled(); },
  });

  const swap = useMutation({
    mutationFn: async () => {
      if (!client || !account || !order || !amount) throw new Error("not ready");
      setProblem(null);
      setResult(null);
      const args = [
        { maker: order.maker as `0x${string}`, traits: BigInt(order.traits), data: order.data as `0x${string}` },
        TOKENS[tokenIn].address,
        TOKENS[tokenOut].address,
        amount,
        TAKER_TRAITS_EXACT_IN,
      ] as const;
      setPhase("simulating");
      await client.simulateContract({ account, address: AQUA_ROUTER, abi: routerAbi, functionName: "swap", args });
      setPhase("swapping");
      const hash = await writeContractAsync({ address: AQUA_ROUTER, abi: routerAbi, functionName: "swap", args, chainId: base.id, ...(await fees(client)) });
      setPhase("confirming");
      const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
      if (receipt.status !== "success") throw new Error("The swap transaction reverted on chain.");
      const fill = parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "Swapped" }).find((l) => l.args.taker.toLowerCase() === account.toLowerCase());
      if (!fill) throw new Error("The swap confirmed but no Swapped event was found in the receipt.");
      setResult({ hash, amountIn: fill.args.amountIn, amountOut: fill.args.amountOut, tokenIn, tokenOut });
    },
    onError: fail,
    onSuccess: () => { setPhase("idle"); onSettled(); },
  });

  return { phase, problem, result, approve: () => approve.mutate(), swap: () => swap.mutate(), dismissResult: () => setResult(null) };
}
