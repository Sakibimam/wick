import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbiParameters } from "viem";
import { effectiveAllowance, encodeHookSwap, POOL_KEY, urAbi } from "./v4";
import { USDC, W0G } from "./config";

describe("Universal Router v4 encoding", () => {
  test("matches the live USDC to W0G execute calldata", () => {
    const amountIn = 50_000n;
    const minOut = 327430311808404931n;
    const deadline = 1_800_000_000n;
    const result = encodeHookSwap({ tokenIn: USDC, tokenOut: W0G, amountIn, minOut, deadline });
    const swapParams = encodeAbiParameters(
      parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params"),
      [{ poolKey: POOL_KEY, zeroForOne: false, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }],
    );
    const input = encodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), ["0x060c0f", [
      swapParams,
      encodeAbiParameters(parseAbiParameters("address,uint256"), [USDC, amountIn]),
      encodeAbiParameters(parseAbiParameters("address,uint256"), [W0G, minOut]),
    ]]);
    expect(result.commands).toBe("0x10");
    expect(result.inputs).toEqual([input]);
    const expected = encodeFunctionData({ abi: urAbi, functionName: "execute", args: ["0x10", [input], deadline] });
    const actual = encodeFunctionData({ abi: urAbi, functionName: "execute", args: [result.commands, result.inputs, result.deadline] });
    expect(actual).toBe(expected);
    expect(decodeSwap(swapParams).zeroForOne).toBe(false);
  });

  test("encodes W0G to USDC direction and token actions", () => {
    const { inputs } = encodeHookSwap({ tokenIn: W0G, tokenOut: USDC, amountIn: 1n, minOut: 1n, deadline: 2n });
    const [, params] = decodeInput(inputs[0]!);
    const decoded = decodeSwap(params[0]!);
    expect(decoded.zeroForOne).toBe(true);
    expect(decoded.poolKey.currency0).toBe(W0G);
    expect(decodeAddressAmount(params[1]!)).toEqual([W0G, 1n]);
    expect(decodeAddressAmount(params[2]!)).toEqual([USDC, 1n]);
  });

  test("uses only active allowance", () => {
    expect(effectiveAllowance(100n, [80n, 10, 0], 10)).toBe(0n);
    expect(effectiveAllowance(100n, [80n, 11, 0], 10)).toBe(80n);
    expect(effectiveAllowance(50n, [80n, 11, 0], 10)).toBe(50n);
  });
});

function decodeInput(input: `0x${string}`) {
  return decodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), input);
}
function decodeSwap(param: `0x${string}`) {
  return decodeAbiParameters(parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params"), param)[0];
}
function decodeAddressAmount(param: `0x${string}`) {
  return decodeAbiParameters(parseAbiParameters("address,uint256"), param);
}
