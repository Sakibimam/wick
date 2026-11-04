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
      if (!client || !amount) throw new Error("not ready");
      setProblem(null);
      setPhase("approving");
      const hash = await writeContractAsync({ address: TOKENS[tokenIn].address, abi: erc20Abi, functionName: "approve", args: [AQUA_ROUTER, amount], chainId: base.id });
      const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
      if (receipt.status !== "success") throw new Error("The approval transaction reverted.");
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
      const hash = await writeContractAsync({ address: AQUA_ROUTER, abi: routerAbi, functionName: "swap", args, chainId: base.id });
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
