import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import type { Pair, Quote } from "./signer.js";
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

const pairTuple = "(address maker,address token0,address token1,uint256 rate01E18,uint256 rate10E18,uint256 maxIn0,uint256 maxIn1,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)";
export const boardV2Abi = parseAbi([`function postPair(${pairTuple} p,bytes sig)`, `function pairDigest(${pairTuple} p) view returns (bytes32)`, "function getQuote(address maker,address tokenIn,address tokenOut) view returns ((uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId))", "function getAgent(address maker) view returns (address)", "function epochOf(address maker) view returns (uint64)", "function lastNonce(address maker,uint64 epoch) view returns (uint64)", "function isQuoteCurrent(address maker,address tokenIn,address tokenOut) view returns (bool)", "event QuotePosted(address indexed maker,address indexed tokenIn,address indexed tokenOut,uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)", "error ZeroMaker()", "error ZeroToken()", "error InvalidPair()", "error InvalidRate()", "error ZeroMaxAmountIn()", "error MissingInferenceId()", "error QuoteExpired(uint64 expiry)", "error TtlTooLong(uint64 expiry,uint64 maxExpiry)", "error WrongEpoch(uint64 epoch,uint64 currentEpoch)", "error NonceNotIncreasing(uint64 nonce,uint64 lastNonce)", "error InvalidAgentSignature()"]);
/** Base priority fees run near 0.001 gwei; an explicit EIP-1559 tip keeps a thin wallet from overpaying viem's 1 gwei default. */
export const PRIORITY_FEE_WEI = 1_000_000n;
export async function eip1559Fees(client: PublicClient<any, any>) { const block = await client.getBlock(); const base = block.baseFeePerGas ?? 0n; return { maxPriorityFeePerGas: PRIORITY_FEE_WEI, maxFeePerGas: base * 2n + PRIORITY_FEE_WEI }; }
export async function postPair(client: PublicClient<any, any>, wallet: WalletClient<any, any>, board: Address, pair: Pair, sig: Hex) {
  const hash = await wallet.writeContract({ address: board, abi: boardV2Abi, functionName: "postPair", args: [pair, sig] as const, account: wallet.account!, chain: wallet.chain ?? null, ...(await eip1559Fees(client)) });
  const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 8, retryDelay: 1_500 });
  if (receipt.status !== "success") throw new Error(`AgentQuoteBoardV2.postPair reverted: ${hash}`);
  return { hash, receipt };
}
