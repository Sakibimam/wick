import { encodeAbiParameters, getAddress, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { USDC, W0G } from "@/lib/config";

export const UNIVERSAL_ROUTER: Address = getAddress("0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40");
export const PERMIT2: Address = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");
export const HOOK: Address = getAddress("0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888");
export const POOL_KEY = { currency0: W0G, currency1: USDC, fee: 0, tickSpacing: 1, hooks: HOOK } as const;
export const POOL_ID = "0xba432fbc03a590fb6576d96b5f91eec9cc94e2b66a5ef1a9c4a0b69b3b69785e" as Hex;

export const urAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
export const permit2Abi = parseAbi([
  "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
]);
export const hookQuoteAbi = parseAbi(["function quote(bool zeroToOne,int256 amountSpecified,bytes32 poolId) returns (uint256)"]);

const swapParamsAbi = parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params");
const actions = "0x060c0f";
const v4SwapCommand = "0x10";

export function encodeHookSwap({ tokenIn, tokenOut, amountIn, minOut, deadline }: { tokenIn: Address; tokenOut: Address; amountIn: bigint; minOut: bigint; deadline: bigint }) {
  const zeroForOne = tokenIn.toLowerCase() === W0G.toLowerCase();
  const swapParams = encodeAbiParameters(swapParamsAbi, [{ poolKey: POOL_KEY, zeroForOne, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  const input = encodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), [actions, [
    swapParams,
    encodeAbiParameters(parseAbiParameters("address,uint256"), [tokenIn, amountIn]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [tokenOut, minOut]),
  ]]);
  return { commands: v4SwapCommand as Hex, inputs: [input] as Hex[], deadline };
}

export function effectiveAllowance(erc20ToPermit2: bigint, p2: readonly [bigint, number, number], nowSec: number): bigint {
  const permit2Amount = p2[1] > nowSec ? p2[0] : 0n;
  return erc20ToPermit2 < permit2Amount ? erc20ToPermit2 : permit2Amount;
}
