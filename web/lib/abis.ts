import { parseAbi } from "viem";

export const erc20Abi = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const orderTuple = "(address maker, uint256 traits, bytes data)";

export const routerAbi = parseAbi([
  `function swap(${orderTuple} order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
  `function quote(${orderTuple} order, address tokenIn, address tokenOut, uint256 amount, bytes takerTraitsAndData) view returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)`,
  `function hash(${orderTuple} order) view returns (bytes32)`,
  "event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut)",
]);

export const swapErrorsAbi = parseAbi([
  "error StaleQuote()",
  "error ZeroSwapAmount()",
]);
