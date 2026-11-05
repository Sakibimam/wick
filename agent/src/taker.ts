import { decodeErrorResult, encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { USDC, W0G } from "./price.js";
export const AQUA_ROUTER: Address = "0x111111338c5091E8440b67B168bAe16a668AC0De";
const routerAbi = parseAbi(["function quote((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) view returns (uint256 amountIn,uint256 amountOut,bytes32 orderHash)", "function swap((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns (uint256 amountIn,uint256 amountOut,bytes32 orderHash)"]);
const erc20Abi = parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]);
export type ShippedOrder = { maker: Address; traits: bigint; data: Hex };
export const takerTraitsExactIn = `0x${"0".repeat(40)}0041` as Hex;
export async function quote(client: PublicClient<any, any>, order: ShippedOrder, input: { tokenIn: Address; tokenOut: Address; amountIn: bigint }) {
  const [amountIn, amountOut, orderHash] = await client.readContract({ address: AQUA_ROUTER, abi: routerAbi, functionName: "quote", args: [order, input.tokenIn, input.tokenOut, input.amountIn, takerTraitsExactIn] });
  return { amountIn, amountOut, orderHash };
}
export async function swap(client: PublicClient<any, any>, wallet: WalletClient<any, any>, order: ShippedOrder, input: { tokenIn: Address; tokenOut: Address; amountIn: bigint }) {
  const acct = wallet.account!;
  const allowanceHash = await wallet.writeContract({ address: input.tokenIn, abi: erc20Abi, functionName: "approve", args: [AQUA_ROUTER, input.amountIn], account: acct, chain: wallet.chain ?? null, ...(await client.estimateFeesPerGas()) });
  const approval = await client.waitForTransactionReceipt({ hash: allowanceHash, retryCount: 8, retryDelay: 1_000 });
  if (approval.status !== "success") throw new Error("taker token approval reverted");
  // Load-balanced RPCs can serve the swap estimate from a node behind the approval block (seen as STF on Base).
  const allowanceAbi = parseAbi(["function allowance(address owner,address spender) view returns (uint256)"]);
  for (let i = 0; (await client.readContract({ address: input.tokenIn, abi: allowanceAbi, functionName: "allowance", args: [acct.address, AQUA_ROUTER] })) < input.amountIn; i++) {
    if (i >= 15) throw new Error("taker approval not visible on the RPC after 30 s");
    await new Promise(r => setTimeout(r, 2_000));
  }
  const hash = await wallet.writeContract({ address: AQUA_ROUTER, abi: routerAbi, functionName: "swap", args: [order, input.tokenIn, input.tokenOut, input.amountIn, takerTraitsExactIn], account: acct, chain: wallet.chain ?? null, ...(await client.estimateFeesPerGas()) });
  const receipt = await client.waitForTransactionReceipt({ hash, retryCount: 8, retryDelay: 1_000 });
  if (receipt.status !== "success") {
    const trace = await client.request({ method: "debug_traceTransaction", params: [hash, {}] } as never).catch(() => undefined) as any;
    const data = trace?.returnValue ? `0x${trace.returnValue}` as Hex : undefined;
    if (data && data !== "0x") { try { const decoded = decodeErrorResult({ abi: parseAbi(["error StaleQuote()", "error ZeroSwapAmount()", "error InvalidArgsLength(uint256)", "error TakerTraitsMissingTraits()", "error TakerTraitsMissingHasPreTransferInFlag()", "error TakerTraitsMissingHasPreTransferOutFlag()"]), data }); throw new Error(`taker swap reverted: ${decoded.errorName}`); } catch (e) { if (e instanceof Error && e.message.startsWith("taker swap reverted:")) throw e; } }
    throw new Error(`taker swap reverted: ${hash}${trace ? ` (${trace.error ?? "no trace error"}; return=${trace.returnValue ?? "none"})` : " (trace unavailable)"}`);
  }
  return { hash, receipt };
}
export const pair = { w0g: W0G, usdc: USDC };
