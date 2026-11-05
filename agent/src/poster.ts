import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Quote } from "./signer.js";
export const boardAbi = parseAbi(["function post((address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId) q,bytes sig)", "function quoteDigest((address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId) q) view returns (bytes32)", "function getQuote(address maker,address tokenIn,address tokenOut) view returns ((address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId))", "error ZeroMaker()", "error ZeroToken()", "error MissingInferenceId()", "error QuoteExpired(uint64 expiry)", "error InvalidPair()", "error InvalidRate()", "error InvalidAgentSignature()", "error NonceNotIncreasing(uint64 nonce,uint64 lastNonce)"]);
export async function post(client: PublicClient<any, any>, wallet: WalletClient<any, any>, board: Address, quote: Quote, sig: Hex) {
  const hash = await wallet.writeContract({ address: board, abi: boardAbi, functionName: "post", args: [quote, sig] as const, account: wallet.account!, chain: wallet.chain ?? null, ...(await client.estimateFeesPerGas()) });
  const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 8, retryDelay: 1_500 });
  if (receipt.status !== "success") {
    try {
      await client.call({ account: wallet.account, to: board, data: encodeFunctionData({ abi: boardAbi, functionName: "post", args: [quote, sig] }), blockNumber: receipt.blockNumber > 0n ? receipt.blockNumber - 1n : 0n });
    } catch (e) {
      const data = (e as any)?.data ?? (e as any)?.cause?.data;
      if (typeof data === "string" && data.startsWith("0x")) { try { const decoded = decodeErrorResult({ abi: boardAbi, data: data as Hex }); throw new Error(`AgentQuoteBoard.${decoded.errorName}`); } catch (decoded) { if (decoded instanceof Error && decoded.message.startsWith("AgentQuoteBoard.")) throw decoded; } }
    }
    throw new Error(`AgentQuoteBoard.post reverted: ${hash}`);
  }
  return { hash, receipt };
}
