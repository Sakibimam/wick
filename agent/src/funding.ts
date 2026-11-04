import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, parseAbiParameters, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { USDC, W0G } from "./price.js";
export const SWAP_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";
export const BASE_CCIP_ROUTER: Address = "0x881e3A65B4d4a04dD529061dd0071cf975F58bCD";
export const W0G_BASE_CCIP_POOL: Address = "0x049DF7Ed53037C58BCAB45510c153D5CD5564830";
export const ZERO_G_PAYMENT_LAYER: Address = "0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32";
export const ZERO_G_CCIP_ROUTER: Address = "0x0aA145a62153190B8f0D3cA00c441e451529f755";
export const W0G_ZERO_G: Address = "0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c";
export const BASE_SELECTOR = 15971525489660198786n, ZERO_G_SELECTOR = 4426351306075016396n;
export const fundingAbi = {
  erc20: parseAbi(["function approve(address spender,uint256 amount) returns (bool)"]),
  router: parseAbi(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)", "function ccipSend(uint64 destinationChainSelector,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs)) payable returns (bytes32)"]),
  token: parseAbi(["function withdraw(uint256 amount)"]),
  payment: parseAbi(["function depositFor(address user) payable", "function balanceOf(address user) view returns (uint256)", "event Deposited(address indexed from,address indexed user,uint256 amount)", "error ZeroAmount()"])
};
export type UnsignedTx = { id: string; chainId: 8453 | 16661; from: Address; to: Address; data: Hex; value: bigint; description: string };
export function quoteCcipFee(client: PublicClient<any, any>, input: { agent: Address; w0gAmount: bigint; extraArgs?: Hex }): Promise<bigint> {
  const extraArgs = input.extraArgs ?? ("0x181dcf10" + encodeAbiParameters(parseAbiParameters("uint256,bool"), [0n, false]).slice(2)) as Hex;
  const data = encodeFunctionData({ abi: parseAbi(["function getFee(uint64,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs)) view returns (uint256)"]), functionName: "getFee", args: [ZERO_G_SELECTOR, { receiver: encodeAbiParameters(parseAbiParameters("address"), [input.agent]), data: "0x", tokenAmounts: [{ token: W0G, amount: input.w0gAmount }], feeToken: "0x0000000000000000000000000000000000000000", extraArgs }] });
  return client.call({ to: BASE_CCIP_ROUTER, data }).then(r => { if (!r.data) throw new Error("CCIP getFee returned no data"); return BigInt(r.data); });
}
export function buildFundingPlan(p: { agent: Address; agentOwner: Address; usdcAmountIn: bigint; w0gAmountOut: bigint; slippageBps: number; ccipFeeWei: bigint; nativeGasReserveWei?: bigint; extraArgs?: Hex }) {
  const reserve = p.nativeGasReserveWei ?? 0n;
  if (p.agent.toLowerCase() === zeroAddress || p.agentOwner.toLowerCase() === zeroAddress || p.usdcAmountIn <= 0n || p.w0gAmountOut <= 0n || p.ccipFeeWei < 0n || reserve < 0n || reserve >= p.w0gAmountOut || !Number.isInteger(p.slippageBps) || p.slippageBps < 0 || p.slippageBps > 9999) throw new RangeError("invalid funding plan amounts or slippage");
  const minW0gOut = p.w0gAmountOut * BigInt(10000 - p.slippageBps) / 10000n, depositAmountWei = p.w0gAmountOut - reserve;
  const tx = (id: string, chainId: 8453 | 16661, to: Address, data: Hex, value = 0n, description = id): UnsignedTx => ({ id, chainId, from: p.agent, to, data, value, description });
  const approve = (token: Address, spender: Address, amount: bigint) => encodeFunctionData({ abi: fundingAbi.erc20, functionName: "approve", args: [spender, amount] });
  const extraArgs = p.extraArgs ?? ("0x181dcf10" + encodeAbiParameters(parseAbiParameters("uint256,bool"), [0n, false]).slice(2)) as Hex;
  const swapTx = tx("swap-usdc-to-w0g", 8453, SWAP_ROUTER, encodeFunctionData({ abi: fundingAbi.router, functionName: "exactInputSingle", args: [{ tokenIn: USDC, tokenOut: W0G, fee: 3000, recipient: p.agent, amountIn: p.usdcAmountIn, amountOutMinimum: minW0gOut, sqrtPriceLimitX96: 0n }] }));
  const message = { receiver: encodeAbiParameters(parseAbiParameters("address"), [p.agent]), data: "0x" as Hex, tokenAmounts: [{ token: W0G, amount: p.w0gAmountOut }], feeToken: "0x0000000000000000000000000000000000000000" as Address, extraArgs };
  const ccipSendTx = tx("ccip-send-w0g", 8453, BASE_CCIP_ROUTER, encodeFunctionData({ abi: fundingAbi.router, functionName: "ccipSend", args: [ZERO_G_SELECTOR, message] }), p.ccipFeeWei);
  const withdrawTx = tx("withdraw-w0g-0g", 16661, W0G_ZERO_G, encodeFunctionData({ abi: fundingAbi.token, functionName: "withdraw", args: [p.w0gAmountOut] }));
  const depositTx = tx("deposit-payment-layer", 16661, ZERO_G_PAYMENT_LAYER, encodeFunctionData({ abi: fundingAbi.payment, functionName: "depositFor", args: [p.agentOwner] }), depositAmountWei);
  const steps = [tx("approve-usdc", 8453, USDC, approve(USDC, SWAP_ROUTER, p.usdcAmountIn)), swapTx, tx("approve-w0g-ccip", 8453, W0G, approve(W0G, BASE_CCIP_ROUTER, p.w0gAmountOut)), ccipSendTx, withdrawTx, depositTx];
  return { minW0gOut, depositAmountWei, steps, swapTx, ccipSendTx, withdrawTx, depositTx };
}
const pad = (x: string) => x.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const mappingSlot = (owner: Address, slot: bigint) => keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [owner, slot]));
const allowanceSlot = (owner: Address, spender: Address, slot: bigint) => keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [spender, BigInt(mappingSlot(owner, slot))]));
async function rpc(client: PublicClient, tx: UnsignedTx, overrides?: Record<string, { balance?: Hex; stateDiff?: Record<string, Hex> }>) {
  const call = { from: tx.from, to: tx.to, data: tx.data, value: `0x${tx.value.toString(16)}` };
  const params: unknown[] = overrides ? [call, "latest", overrides] : [call, "latest"];
  return client.request({ method: "eth_call", params } as never);
}
export async function simulate(plan: ReturnType<typeof buildFundingPlan>, clients: { base: PublicClient; zeroG: PublicClient }) {
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const step of plan.steps) {
    try {
      let overrides: Record<string, { balance?: Hex; stateDiff?: Record<string, Hex> }> | undefined;
      if (step.id === "swap-usdc-to-w0g") {
        const amountIn = (decodeFunctionData({ abi: fundingAbi.router, data: plan.swapTx.data }) as unknown as { args: [{ amountIn: bigint }] }).args[0].amountIn;
        overrides = { [USDC]: { stateDiff: { [mappingSlot(step.from, 9n)]: `0x${pad(amountIn.toString(16))}`, [allowanceSlot(step.from, SWAP_ROUTER, 10n)]: `0x${pad(amountIn.toString(16))}` } } };
      } else if (step.id === "ccip-send-w0g") {
        const a = (decodeFunctionData({ abi: fundingAbi.router, data: plan.ccipSendTx.data }) as unknown as { args: [bigint, { tokenAmounts: [{ amount: bigint }] }] }).args[1].tokenAmounts[0]!.amount;
        overrides = { [W0G]: { stateDiff: { [mappingSlot(step.from, 0n)]: `0x${pad(a.toString(16))}`, [allowanceSlot(step.from, BASE_CCIP_ROUTER, 1n)]: `0x${pad(a.toString(16))}` } }, [step.from]: { balance: `0x${(plan.ccipSendTx.value + 10n ** 18n).toString(16)}` } };
      } else if (step.id === "withdraw-w0g-0g") overrides = { [W0G_ZERO_G]: { stateDiff: { [mappingSlot(step.from, 3n)]: `0x${pad(decodeFunctionData({ abi: fundingAbi.token, data: step.data }).args[0].toString(16))}` } } };
      else if (step.id === "deposit-payment-layer") overrides = { [step.from]: { balance: `0x${(step.value + 10n ** 18n).toString(16)}` } };
      const client = step.chainId === 8453 ? clients.base : clients.zeroG;
      await rpc(client, step, overrides);
      results.push({ id: step.id, ok: true });
    } catch (e) { results.push({ id: step.id, ok: false, error: e instanceof Error ? e.message : String(e) }); }
  }
  return { ok: results.every(x => x.ok), results };
}
