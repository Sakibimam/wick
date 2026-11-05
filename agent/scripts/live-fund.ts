// Mainnet funding leg: turns Base-side value into 0G compute credit for the agent's own Payment Layer account.
//   bun run scripts/live-fund.ts gas      LI.FI Base USDC -> native 0G on 0G chain (gas + seed credit)
//   bun run scripts/live-fund.ts ccip     CCIP W0G Base -> 0G chain (fee in native ETH)
//   bun run scripts/live-fund.ts deposit  W0G.withdraw on 0G chain, then PaymentLayer.depositFor(agent)
// Spends real funds. Each phase reads balances first and refuses to run twice.
import { createPublicClient, createWalletClient, defineChain, erc20Abi, formatUnits, http, parseEventLogs, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { BASE_CCIP_ROUTER, buildFundingPlan, fundingAbi, quoteCcipFee, W0G_ZERO_G, ZERO_G_PAYMENT_LAYER } from "../src/funding.js";
import { USDC, W0G } from "../src/price.js";

const phase = process.argv[2];
const LIFI_USDC_IN = BigInt(process.env.LIFI_USDC_IN || "300000");
const BRIDGE_W0G = BigInt(process.env.BRIDGE_W0G_WEI || "1000000000000000000");
const STRATEGY_W0G_FLOOR = BigInt(process.env.STRATEGY_W0G_FLOOR_WEI || "1357492788767429240");
const GAS_RESERVE_0G = BigInt(process.env.ZG_GAS_RESERVE_WEI || "200000000000000000");
const zeroG = defineChain({ id: 16661, name: "0G Mainnet", nativeCurrency: { name: "0G", symbol: "0G", decimals: 18 }, rpcUrls: { default: { http: [process.env.ZG_RPC_URL || "https://evmrpc.0g.ai"] } } });
const baseRpc = process.env.BASE_RPC_URL || "https://mainnet.base.org";

const raw = process.env.AGENT_PK || (await Bun.file(new URL("../../contracts/.env", import.meta.url)).text()).match(/^DEPLOYER_PK=(.+)$/m)?.[1];
const key = raw?.trim().replace(/^["']|["']$/g, "");
if (!key) throw new Error("no agent key");
const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
const baseClient = createPublicClient({ chain: base, transport: http(baseRpc) });
const zgClient = createPublicClient({ chain: zeroG, transport: http() });
const baseWallet = createWalletClient({ account, chain: base, transport: http(baseRpc) });
const zgWallet = createWalletClient({ account, chain: zeroG, transport: http() });
const me = account.address;

const confirm = async (client: typeof baseClient | typeof zgClient, label: string, hash: Hex) => {
  const r = await client.waitForTransactionReceipt({ hash, retryCount: 20, pollingInterval: 3_000, timeout: 180_000 });
  if (r.status !== "success") throw new Error(`${label} reverted: ${hash}`);
  console.log(`${label}_TX=${hash} chain=${client.chain!.id} gasUsed=${r.gasUsed}`);
  return r;
};
const waitUntil = async (label: string, read: () => Promise<bigint>, target: bigint, timeoutMs: number) => {
  const t0 = Date.now();
  for (;;) {
    const v = await read();
    if (v >= target) { console.log(`${label}_ARRIVED value=${v} after_s=${Math.round((Date.now() - t0) / 1000)}`); return v; }
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} not arrived after ${timeoutMs / 1000}s (have ${v}, need ${target})`);
    await Bun.sleep(15_000);
  }
};
const baseUsdc = () => baseClient.readContract({ address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [me] });
const baseW0g = () => baseClient.readContract({ address: W0G, abi: erc20Abi, functionName: "balanceOf", args: [me] });
const zgNative = () => zgClient.getBalance({ address: me });
const zgW0g = () => zgClient.readContract({ address: W0G_ZERO_G, abi: erc20Abi, functionName: "balanceOf", args: [me] });
const credit = () => zgClient.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [me] });

console.log(`AGENT=${me} phase=${phase}`);
console.log(`BEFORE base_eth=${formatUnits(await baseClient.getBalance({ address: me }), 18)} base_usdc=${formatUnits(await baseUsdc(), 6)} base_w0g=${formatUnits(await baseW0g(), 18)} zg_native=${formatUnits(await zgNative(), 18)} zg_w0g=${formatUnits(await zgW0g(), 18)} credit=${formatUnits(await credit(), 18)}`);

if (phase === "gas") {
  if ((await zgNative()) > 0n) throw new Error("agent already holds native 0G; gas phase already done");
  const q = await (await fetch(`https://li.quest/v1/quote?fromChain=8453&toChain=16661&fromToken=${USDC}&toToken=0x0000000000000000000000000000000000000000&fromAmount=${LIFI_USDC_IN}&fromAddress=${me}&toAddress=${me}&slippage=0.01`)).json() as any;
  if (!q?.transactionRequest || !q?.estimate?.approvalAddress) throw new Error(`LI.FI quote failed: ${JSON.stringify(q).slice(0, 300)}`);
  console.log(`LIFI tool=${q.tool} toAmount=${q.estimate.toAmount} toAmountMin=${q.estimate.toAmountMin} etaS=${q.estimate.executionDuration}`);
  const spender = q.estimate.approvalAddress as Address;
  await confirm(baseClient, "APPROVE_USDC_LIFI", await baseWallet.writeContract({ address: USDC, abi: erc20Abi, functionName: "approve", args: [spender, LIFI_USDC_IN], ...(await baseClient.estimateFeesPerGas()) }));
  for (let i = 0; (await baseClient.readContract({ address: USDC, abi: erc20Abi, functionName: "allowance", args: [me, spender] })) < LIFI_USDC_IN; i++) { if (i > 15) throw new Error("LI.FI allowance not visible"); await Bun.sleep(2_000); }
  const tr = q.transactionRequest;
  await confirm(baseClient, "LIFI_BRIDGE", await baseWallet.sendTransaction({ to: tr.to, data: tr.data, value: BigInt(tr.value ?? "0"), gas: BigInt(tr.gasLimit), ...(await baseClient.estimateFeesPerGas()) }));
  await waitUntil("ZG_NATIVE", zgNative, BigInt(q.estimate.toAmountMin), 15 * 60_000);
} else if (phase === "ccip") {
  const have = await baseW0g();
  if (have - BRIDGE_W0G < STRATEGY_W0G_FLOOR) throw new Error(`bridging ${BRIDGE_W0G} would leave ${have - BRIDGE_W0G} W0G, below the live strategy's ${STRATEGY_W0G_FLOOR} commitment`);
  const fee = await quoteCcipFee(baseClient, { agent: me, w0gAmount: BRIDGE_W0G });
  console.log(`CCIP_FEE_WEI=${fee}`);
  const plan = buildFundingPlan({ agent: me, agentOwner: me, usdcAmountIn: 1n, w0gAmountOut: BRIDGE_W0G, slippageBps: 100, ccipFeeWei: fee });
  await confirm(baseClient, "APPROVE_W0G_CCIP", await baseWallet.writeContract({ address: W0G, abi: erc20Abi, functionName: "approve", args: [BASE_CCIP_ROUTER, BRIDGE_W0G], ...(await baseClient.estimateFeesPerGas()) }));
  for (let i = 0; (await baseClient.readContract({ address: W0G, abi: erc20Abi, functionName: "allowance", args: [me, BASE_CCIP_ROUTER] })) < BRIDGE_W0G; i++) { if (i > 15) throw new Error("CCIP allowance not visible"); await Bun.sleep(2_000); }
  const before = await zgW0g();
  const r = await confirm(baseClient, "CCIP_SEND", await baseWallet.sendTransaction({ to: plan.ccipSendTx.to, data: plan.ccipSendTx.data, value: plan.ccipSendTx.value, ...(await baseClient.estimateFeesPerGas()) }));
  const sent = r.logs.find(l => l.topics[0] && l.address.toLowerCase() !== W0G.toLowerCase());
  console.log(`CCIP_SEND_BLOCK=${r.blockNumber} first_router_log_topic=${sent?.topics[0] ?? "none"} explorer=https://ccip.chain.link/tx/${r.transactionHash}`);
  await waitUntil("ZG_W0G", zgW0g, before + BRIDGE_W0G, 45 * 60_000);
} else if (phase === "deposit") {
  const w = await zgW0g();
  if (w > 0n) await confirm(zgClient, "W0G_WITHDRAW", await zgWallet.writeContract({ address: W0G_ZERO_G, abi: fundingAbi.token, functionName: "withdraw", args: [w] }));
  const native = await zgNative();
  if (native <= GAS_RESERVE_0G) throw new Error(`native 0G ${native} at or below gas reserve ${GAS_RESERVE_0G}`);
  const amount = native - GAS_RESERVE_0G;
  const c0 = await credit();
  const r = await confirm(zgClient, "DEPOSIT_FOR", await zgWallet.writeContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "depositFor", args: [me], value: amount }));
  const ev = parseEventLogs({ abi: fundingAbi.payment, logs: r.logs, eventName: "Deposited" })[0];
  const c1 = await credit();
  console.log(`DEPOSITED amount=${formatUnits(amount, 18)} event_user=${ev?.args.user} credit_before=${formatUnits(c0, 18)} credit_after=${formatUnits(c1, 18)} delta_ok=${c1 - c0 === amount ? 1 : 0}`);
} else throw new Error("usage: live-fund.ts gas|ccip|deposit");

console.log(`AFTER base_eth=${formatUnits(await baseClient.getBalance({ address: me }), 18)} base_usdc=${formatUnits(await baseUsdc(), 6)} base_w0g=${formatUnits(await baseW0g(), 18)} zg_native=${formatUnits(await zgNative(), 18)} zg_w0g=${formatUnits(await zgW0g(), 18)} credit=${formatUnits(await credit(), 18)}`);
