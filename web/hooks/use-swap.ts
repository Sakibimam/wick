"use client";

import { useCallback, useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { parseEventLogs } from "viem";
import { usePublicClient, useWriteContract } from "wagmi";
import { base } from "wagmi/chains";
import { type TokenSymbol, TOKENS } from "@/lib/config";
import { erc20Abi, routerAbi } from "@/lib/abis";
import { effectiveAllowance, HOOK, hookQuoteAbi, PERMIT2, permit2Abi, POOL_ID, urAbi, UNIVERSAL_ROUTER, encodeHookSwap } from "@/lib/v4";
import { classifyFailure, type SwapFailure } from "@/lib/revert";
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

export function useSwapFlow(opts: { account: `0x${string}` | undefined; tokenIn: TokenSymbol; tokenOut: TokenSymbol; amount: bigint | null; quoteExpired: () => boolean; onSettled: () => void }) {
  const client = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const [phase, setPhase] = useState<Phase>("idle");
  const [problem, setProblem] = useState<SwapProblem | null>(null);
  const [result, setResult] = useState<SwapResult | null>(null);
  const { account, tokenIn, tokenOut, amount, quoteExpired, onSettled } = opts;

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
      const token = TOKENS[tokenIn].address;
      const erc20Allowance = await client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, PERMIT2] });
      if (erc20Allowance < amount) {
        const hash = await writeContractAsync({ address: token, abi: erc20Abi, functionName: "approve", args: [PERMIT2, amount], chainId: base.id, ...(await fees(client)) });
        const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
        if (receipt.status !== "success") throw new Error("The approval transaction reverted.");
      }
      const nowSec = Math.floor(Date.now() / 1000);
      const p2 = await client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [account, token, UNIVERSAL_ROUTER] });
      if (p2[0] < amount || p2[1] <= nowSec) {
        const hash = await writeContractAsync({ address: PERMIT2, abi: permit2Abi, functionName: "approve", args: [token, UNIVERSAL_ROUTER, amount, nowSec + 30 * 24 * 60 * 60], chainId: base.id, ...(await fees(client)) });
        const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
        if (receipt.status !== "success") throw new Error("The Permit2 approval transaction reverted.");
      }
      // Load-balanced RPCs can answer from a node behind the approval block; the swap simulation would then fail on allowance.
      for (let i = 0; ; i++) {
        const [erc20Now, p2Now] = await Promise.all([
          client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account, PERMIT2] }),
          client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: "allowance", args: [account, token, UNIVERSAL_ROUTER] }),
        ]);
        if (effectiveAllowance(erc20Now, p2Now, Math.floor(Date.now() / 1000)) >= amount) break;
        if (i >= 15) throw new Error("The approval confirmed but the RPC has not shown it after 30 seconds.");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    },
    onError: fail,
    onSuccess: () => { setPhase("idle"); onSettled(); },
  });

  const swap = useMutation({
    mutationFn: async () => {
      if (!client || !account || !amount) throw new Error("not ready");
      setProblem(null);
      setResult(null);
      const tokenInAddress = TOKENS[tokenIn].address;
      const tokenOutAddress = TOKENS[tokenOut].address;
      const zeroForOne = tokenInAddress.toLowerCase() === TOKENS.W0G.address.toLowerCase();
      setPhase("simulating");
      const { result: expectedOut } = await client.simulateContract({ account, address: HOOK, abi: hookQuoteAbi, functionName: "quote", args: [zeroForOne, -amount, POOL_ID] });
      const minOut = expectedOut * 9_900n / 10_000n;
      const args = encodeHookSwap({ tokenIn: tokenInAddress, tokenOut: tokenOutAddress, amountIn: amount, minOut, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
      await client.simulateContract({ account, address: UNIVERSAL_ROUTER, abi: urAbi, functionName: "execute", args: [args.commands, args.inputs, args.deadline] });
      setPhase("swapping");
      const hash = await writeContractAsync({ address: UNIVERSAL_ROUTER, abi: urAbi, functionName: "execute", args: [args.commands, args.inputs, args.deadline], chainId: base.id, ...(await fees(client)) });
      setPhase("confirming");
      const receipt = await client.waitForTransactionReceipt({ hash, ...RECEIPT });
      if (receipt.status !== "success") throw new Error("The swap transaction reverted on chain.");
      const fill = parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "Swapped" }).find((l) => l.args.taker.toLowerCase() === HOOK.toLowerCase() && l.args.tokenIn.toLowerCase() === tokenInAddress.toLowerCase());
      if (!fill) throw new Error("The swap confirmed but no Swapped event was found in the receipt.");
      setResult({ hash, amountIn: fill.args.amountIn, amountOut: fill.args.amountOut, tokenIn, tokenOut });
    },
    onError: fail,
    onSuccess: () => { setPhase("idle"); onSettled(); },
  });

  return { phase, problem, result, approve: () => approve.mutate(), swap: () => swap.mutate(), dismissResult: () => setResult(null) };
}
