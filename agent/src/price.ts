import { parseAbi, type Address, type PublicClient } from "viem";

export const BASE_CHAIN_ID = 8453;
export const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const W0G: Address = "0x23cd099eB438CcA50349EE2BC809196b1ae00861";
export const POOL: Address = "0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e";
export const QUOTER_V2: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
export const poolAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function fee() view returns (uint24)", "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)", "function liquidity() view returns (uint128)"]);
export const quoterAbi = parseAbi(["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)"]);
export type MarketSnapshot = { mid: number; sqrtPriceX96: bigint; tick: number; fee: number; liquidity: bigint; token0: Address; token1: Address; decimals0: number; decimals1: number };
function rationalToNumber(numerator: bigint, denominator: bigint): number {
  if (numerator <= 0n || denominator <= 0n) throw new RangeError("price must be positive");
  const scale = 10n ** 24n;
  const scaled = numerator * scale / denominator;
  const value = Number(scaled) / Number(scale);
  if (!Number.isFinite(value) || value <= 0) throw new RangeError("price is outside the representable range");
  return value;
}
export function midPriceUsdcPerW0g(sqrtPriceX96: bigint, token0: Address, token1: Address, decimals0: number, decimals1: number): number {
  if (sqrtPriceX96 <= 0n || !Number.isInteger(decimals0) || !Number.isInteger(decimals1) || decimals0 < 0 || decimals1 < 0) throw new RangeError("invalid price inputs");
  const q192 = 1n << 192n;
  const square = sqrtPriceX96 * sqrtPriceX96;
  const scale = 10n ** BigInt(Math.abs(decimals0 - decimals1));
  if (token0.toLowerCase() === W0G.toLowerCase() && token1.toLowerCase() === USDC.toLowerCase() && decimals0 === 18 && decimals1 === 6) return rationalToNumber(square * scale, q192);
  if (token0.toLowerCase() === USDC.toLowerCase() && token1.toLowerCase() === W0G.toLowerCase() && decimals0 === 6 && decimals1 === 18) return rationalToNumber(q192 * scale, square);
  throw new RangeError("pool token pair must be W0G/USDC");
}
export async function readMarket(client: PublicClient<any, any>): Promise<MarketSnapshot> {
  const [token0, token1, fee, slot0, liquidity] = await Promise.all([client.readContract({ address: POOL, abi: poolAbi, functionName: "token0" }), client.readContract({ address: POOL, abi: poolAbi, functionName: "token1" }), client.readContract({ address: POOL, abi: poolAbi, functionName: "fee" }), client.readContract({ address: POOL, abi: poolAbi, functionName: "slot0" }), client.readContract({ address: POOL, abi: poolAbi, functionName: "liquidity" })]);
  const t0 = token0 as Address, t1 = token1 as Address;
  const decimals0 = t0.toLowerCase() === W0G.toLowerCase() ? 18 : 6, decimals1 = t1.toLowerCase() === W0G.toLowerCase() ? 18 : 6;
  const sqrtPriceX96 = slot0[0];
  return { mid: midPriceUsdcPerW0g(sqrtPriceX96, t0, t1, decimals0, decimals1), sqrtPriceX96, tick: Number(slot0[1]), fee: Number(fee), liquidity: liquidity as bigint, token0: t0, token1: t1, decimals0, decimals1 };
}
export async function quoteUsdcForW0g(client: PublicClient<any, any>, input: { usdcAmountIn: bigint; fee: number }) {
  const result = await client.readContract({ address: QUOTER_V2, abi: quoterAbi, functionName: "quoteExactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, amountIn: input.usdcAmountIn, fee: input.fee, sqrtPriceLimitX96: 0n }] });
  return { amountIn: input.usdcAmountIn, amountOut: result[0], sqrtPriceX96After: result[1], initializedTicksCrossed: Number(result[2]), gasEstimate: result[3] };
}
