// Rehearses the fee HARVEST on an anvil fork of Base mainnet against the real Aqua, AquaSwapVMRouter, v2 board and the
// deployed Uniswap v4 hook: a maker runs the live v2 program, takers pay real fees into its virtual balance, then cronTick
// (the Worker's code path) docks, re-ships at commitment minus fees and points the hook at the new order, one tx per tick.
import { createPublicClient, createWalletClient, custom, encodeAbiParameters, http, parseAbi, parseAbiItem, parseAbiParameters, toHex, type Address, type Hex } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { USDC, W0G } from "../src/price.js";
import { AQUA, AQUA_SWAPVM_ROUTER, harvestAbi, HARVEST_GAS_UNITS, strategyHashOf, type LiveOrder, type OrderJson } from "../src/funding-machine.js";
import { quote as routerQuote, swap as takerSwap } from "../src/taker.js";
import { unlockedSigner } from "../src/signer.js";
import { cronTick, emptyCronState, DEFAULT_FUNDING_ENV, type CronState, type FillLite } from "../src/worker-tick.js";
import { ACCOUNTS, fundToken, rpc, waitForRpc } from "./fork-setup.js";

const rpcUrl = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
const REAL_MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const HOOK: Address = "0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888";
// Anvil's first default account, derived from its published test mnemonic: never a real wallet.
const ANVIL0_PK = toHex(mnemonicToAccount("test test test test test test test test test test test junk").getHdKey().privateKey!);
const MAKER = ACCOUNTS[0]!, TAKER = ACCOUNTS[1]!;
const E18 = 10n ** 18n;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const aquaAbi = parseAbi(["function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)"]);
const swapped = parseAbiItem("event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)");
const zeroG = createPublicClient({ transport: custom({ request: async ({ method }) => {
  if (method === "eth_chainId") return "0x4115";
  if (method === "eth_call") return encodeAbiParameters(parseAbiParameters("uint256"), [2_343_959_530_558_679_712n]);
  if (method === "eth_getBalance") return "0x2386f26fc10000";
  if (method === "eth_blockNumber") return "0x1";
  throw new Error(`0G stand-in has no ${method}`);
} }) });
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(msg); };

async function main() {
  const live = JSON.parse(await Bun.file(new URL("../../web/worker/live-order-v2.json", import.meta.url).pathname).text());
  const port = 20545 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
  const anvil = Bun.spawn(["anvil", "--fork-url", rpcUrl, "--port", String(port), "--auto-impersonate", "--silent", "--retries", "20", "--fork-retry-backoff", "400"], { stdout: "ignore", stderr: "pipe" });
  const local = createPublicClient({ chain: base, transport: http(url), pollingInterval: 200 });
  // Anvil answers eth_gasPrice with base fee + a 1 gwei tip; Base nodes answer base fee + ~0.001 gwei (6e6 wei read live at block
  // 53822352). The tick prices the harvest from eth_gasPrice, so its client sees what Base would say.
  const raw = http(url)({ chain: base });
  const tickClient = createPublicClient({ chain: base, pollingInterval: 200, transport: custom({ request: async (a: { method: string; params?: unknown }) => a.method === "eth_gasPrice" ? toHex(((await local.getBlock()).baseFeePerGas ?? 0n) + 1_000_000n) : raw.request(a as never) }) });
  const wallet = createWalletClient({ account: privateKeyToAccount(ANVIL0_PK as Hex), chain: base, transport: http(url) });
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const mined = async (hash: Hex, what: string) => { const r = await local.waitForTransactionReceipt({ hash }); check(r.status === "success", `${what} reverted ${hash}`); return r; };
  try {
    await waitForRpc(url);
    // As on mainnet, the wallet holds exactly what it commits: spare starts at zero and must grow by exactly the fees.
    await fundToken(url, local, W0G, MAKER, 600n * E18); await fundToken(url, local, USDC, MAKER, 150n * 10n ** 6n);
    const commit = { w0g: 600n * E18, usdc: 150n * 10n ** 6n };
    await mined(await wallet.writeContract({ address: live.board, abi: parseAbi(["function setAgent(address)"]), functionName: "setAgent", args: [MAKER] }), "setAgent");
    for (const [t, a] of [[W0G, commit.w0g], [USDC, commit.usdc]] as const) await mined(await wallet.writeContract({ address: t, abi: erc20, functionName: "approve", args: [AQUA, a] }), "approve");
    const order: OrderJson = { maker: MAKER, traits: live.order.traits, data: live.order.data };
    const hash0 = strategyHashOf(order);
    const strategyBytes = encodeAbiParameters(parseAbiParameters("(address maker,uint256 traits,bytes data)"), [{ maker: MAKER, traits: BigInt(order.traits), data: order.data }]);
    const shipBlock = (await mined(await wallet.writeContract({ address: AQUA, abi: harvestAbi, functionName: "ship", args: [AQUA_SWAPVM_ROUTER, strategyBytes, [W0G, USDC], [commit.w0g, commit.usdc]] }), "ship")).blockNumber;
    // The deployed hook belongs to the real maker; on the fork it hands ownership to the fork maker, as setOrder needs.
    await mined(await unlockedSigner(url, REAL_MAKER).wallet.writeContract({ address: HOOK, abi: parseAbi(["function transferOwnership(address)"]), functionName: "transferOwnership", args: [MAKER], account: REAL_MAKER, chain: null }), "transferOwnership");
    await mined(await wallet.writeContract({ address: HOOK, abi: harvestAbi, functionName: "setOrder", args: [{ maker: MAKER, traits: BigInt(order.traits), data: order.data }] }), "setOrder v0");
    check((await local.readContract({ address: HOOK, abi: harvestAbi, functionName: "orderHash" })).toLowerCase() === hash0.toLowerCase(), "hook does not follow the shipped order");
    await rpc(url, "evm_increaseTime", [700]); await rpc(url, "evm_mine");

    const liveOrder: LiveOrder = { order, hash: hash0, amounts: { w0g: commit.w0g.toString(), usdc: commit.usdc.toString() }, shipTx: null, shippedAt: null, past: [] };
    const good = Bun.serve({ port: 0, fetch: () => Response.json({ choices: [{ message: { content: JSON.stringify({ spreadBps: 40, skewBps: 0, maxAmountInUsdc: 60, ttlSeconds: 900, reason: "fork rehearsal: two-sided quote for the harvest" }) } }], usage: { total_tokens: 1 }, x_0g_trace: { request_id: `fork-${Date.now()}`, provider: "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250", tee_verified: true, billing: { currency: "0g", total_cost: "1" } } }) });
    const down = Bun.serve({ port: 0, fetch: () => new Response("down", { status: 500 }) });
    servers.push(good, down);
    const nowOf = async () => Number((await local.getBlock()).timestamp) * 1000;
    let fills: FillLite[] = [];
    const env = async (router: string) => ({ base: tickClient, zeroG, chain: base, baseRpcUrl: url, board: live.board as Address, aquaApp: AQUA_SWAPVM_ROUTER, strategyHash: hash0, maker: MAKER, agent: MAKER, spendCapPerDayWei: E18, agentPk: ANVIL0_PK, zgApiKey: "fork", zgApiBase: router, now: await nowOf(), fills, hook: HOOK, liveOrder, funding: { ...DEFAULT_FUNDING_ENV, feeBps: live.pair.feeBps } });
    let st: CronState = emptyCronState();
    const t0 = await cronTick(st, await env(`http://127.0.0.1:${good.port}`)); st = t0.state;
    check(t0.outcome.startsWith("posted "), `quote not posted: ${t0.outcome} ${t0.state.lastTick?.error ?? ""}`);

    // Real fees: both directions fill through AquaSwapVMRouter on the live v2 program.
    await fundToken(url, local, USDC, TAKER, 100n * 10n ** 6n); await fundToken(url, local, W0G, TAKER, 1_000n * E18);
    const tw = unlockedSigner(url, TAKER).wallet, ordB = { maker: MAKER, traits: BigInt(order.traits), data: order.data };
    await takerSwap(local, tw, ordB, { tokenIn: USDC, tokenOut: W0G, amountIn: 40n * 10n ** 6n });
    await takerSwap(local, tw, ordB, { tokenIn: W0G, tokenOut: USDC, amountIn: 200n * E18 });
    const logs = await local.getLogs({ address: AQUA_SWAPVM_ROUTER, event: swapped, fromBlock: shipBlock });
    fills = logs.filter((l) => l.args.maker!.toLowerCase() === MAKER.toLowerCase()).map((l) => ({ orderHash: l.args.orderHash!, taker: l.args.taker!, tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, amountIn: l.args.amountIn!.toString(), amountOut: l.args.amountOut!.toString(), timeMs: null }));
    check(fills.length === 2 && fills.every((f) => f.orderHash!.toLowerCase() === hash0.toLowerCase()), `expected 2 fills on the strategy, got ${fills.length}`);
    const fee = (t: Address) => fills.filter((f) => f.tokenIn.toLowerCase() === t.toLowerCase()).reduce((s, f) => s + BigInt(f.amountIn) * BigInt(live.pair.feeBps) / 10_000n, 0n);
    const fees = { w0g: fee(W0G), usdc: fee(USDC) };
    const [cw, cu] = await local.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [MAKER, AQUA_SWAPVM_ROUTER, hash0, W0G, USDC] });
    const bal = async (t: Address) => local.readContract({ address: t, abi: erc20, functionName: "balanceOf", args: [MAKER] });
    const walletBefore = { w0g: await bal(W0G), usdc: await bal(USDC) };
    const spareBefore = { w0g: walletBefore.w0g - cw, usdc: walletBefore.usdc - cu };

    const outcomes: string[] = [];
    for (let i = 0; i < 12 && !st.funding?.lastHarvest; i++) {
      const r = await cronTick(st, await env(`http://127.0.0.1:${down.port}`)); st = r.state; outcomes.push(r.outcome.split("; ").at(-1)!);
      await rpc(url, "evm_increaseTime", [300]); await rpc(url, "evm_mine");
    }
    const h = st.funding?.lastHarvest;
    check(!!h, `harvest did not complete: ${outcomes.join(" | ")} decision=${JSON.stringify(st.funding?.lastHarvestDecision)}`);
    let gas = 0n;
    for (const [step, tx] of Object.entries(h!.txs)) { const r = await local.getTransactionReceipt({ hash: tx! }); check(r.status === "success", `${step} ${tx} not success`); gas += r.gasUsed; }
    const [nw, nu] = await local.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [MAKER, AQUA_SWAPVM_ROUTER, h!.to, W0G, USDC] });
    const old = await local.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [MAKER, AQUA_SWAPVM_ROUTER, hash0, W0G] });
    const walletAfter = { w0g: await bal(W0G), usdc: await bal(USDC) };
    const spareAfter = { w0g: walletAfter.w0g - nw, usdc: walletAfter.usdc - nu };
    check(nw === cw - fees.w0g && nu === cu - fees.usdc, `new commitment ${nw}/${nu} != old ${cw}/${cu} minus fees ${fees.w0g}/${fees.usdc}`);
    check(spareBefore.w0g === 0n && spareBefore.usdc === 0n, `spare before harvest ${spareBefore.w0g}/${spareBefore.usdc}, expected 0`);
    check(spareAfter.w0g - spareBefore.w0g === fees.w0g && spareAfter.usdc - spareBefore.usdc === fees.usdc, "wallet spare did not grow by exactly the fees");
    check(old[1] === 0xff, "old strategy not docked");
    check((await local.readContract({ address: HOOK, abi: harvestAbi, functionName: "orderHash" })).toLowerCase() === h!.to.toLowerCase(), "hook order not updated");
    check(st.funding!.live!.hash.toLowerCase() === h!.to.toLowerCase() && st.funding!.live!.past.map((x) => x.toLowerCase()).includes(hash0.toLowerCase()), "KV live order not moved to the new hash");
    check(gas <= HARVEST_GAS_UNITS, `harvest used ${gas} gas, above HARVEST_GAS_UNITS ${HARVEST_GAS_UNITS}`);
    // The salted program fills on the deployed router: same price, same fee. Harvest ticks outlived the 900 s quote, so the
    // cron posts a fresh one first, through the same tick, with the harvest finished.
    const repost = await cronTick(st, await env(`http://127.0.0.1:${good.port}`)); st = repost.state;
    check(repost.outcome.startsWith("posted "), `requote after harvest failed: ${repost.outcome} ${repost.state.lastTick?.error ?? ""}`);
    const newOrd = { maker: MAKER, traits: BigInt(h!.order.traits), data: h!.order.data };
    const q = await routerQuote(local, newOrd, { tokenIn: USDC, tokenOut: W0G, amountIn: 10n ** 6n });
    const qOld = await routerQuote(local, ordB, { tokenIn: USDC, tokenOut: W0G, amountIn: 10n ** 6n }).then(() => "quoted", (e) => String(e).includes("0x") || String(e).length > 0 ? "reverted" : "?");
    check(q.amountOut > 0n && q.orderHash.toLowerCase() === h!.to.toLowerCase(), "router does not quote the re-shipped order");
    const after = await takerSwap(local, tw, newOrd, { tokenIn: USDC, tokenOut: W0G, amountIn: 100_000n });
    // Negative: the new hash has earned one 0.1 USDC fill, 0.0003 USDC of fee, under k x gas: the next tick must not harvest again.
    const newLogs = await local.getLogs({ address: AQUA_SWAPVM_ROUTER, event: swapped, fromBlock: shipBlock });
    fills = newLogs.filter((l) => l.args.maker!.toLowerCase() === MAKER.toLowerCase()).map((l) => ({ orderHash: l.args.orderHash!, taker: l.args.taker!, tokenIn: l.args.tokenIn!, tokenOut: l.args.tokenOut!, amountIn: l.args.amountIn!.toString(), amountOut: l.args.amountOut!.toString(), timeMs: null }));
    check(fills.filter((f) => f.orderHash!.toLowerCase() === h!.to.toLowerCase()).length === 1, "the fill on the re-shipped order is not attributed to its hash");
    const nxt = await cronTick(st, await env(`http://127.0.0.1:${down.port}`));
    const hd = nxt.state.funding!.lastHarvestDecision!;
    check(!nxt.state.funding!.run?.harvest && hd.fire === false && hd.reason === "below_threshold" && hd.fees.usdc === "300", `harvested again: ${JSON.stringify(hd)}`);
    const fd = nxt.state.funding!.lastDecision!;
    process.stdout.write([
      `HARVEST_OUTCOMES=${outcomes.join(" | ")}`,
      `HARVEST_TXS=${JSON.stringify(h!.txs)}`,
      `HARVEST_GAS_USED=${gas} (cap ${HARVEST_GAS_UNITS})`,
      `HARVEST_FROM=${hash0} docked=${old[1] === 0xff}`,
      `HARVEST_TO=${h!.to}`,
      `FEES=${fees.w0g} W0G / ${fees.usdc} USDC units`,
      `COMMITMENT ${cw}/${cu} -> ${nw}/${nu}`,
      `SPARE ${spareBefore.w0g}/${spareBefore.usdc} -> ${spareAfter.w0g}/${spareAfter.usdc}`,
      `HOOK_ORDER_HASH=${h!.to}`,
      `OLD_ORDER_QUOTE=${qOld} NEW_ORDER_QUOTE_OUT=${q.amountOut} NEW_ORDER_FILL=${after.hash}`,
      `NEXT_TICK_HARVEST=${hd.reason} FUNDING_SPENDABLE=${fd.spendableUsdc} USDC units / ${fd.spendableW0g} W0G (${fd.reason})`,
    ].join("\n") + "\n");
  } finally { for (const s of servers) s.stop(true); anvil.kill(); await anvil.exited; }
}
main().catch((e) => { process.stderr.write(`fork-harvest failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
