// Rehearses the v2 cutover and one live cron tick on an anvil fork of Base mainnet, with the real maker wallet:
// LaunchV2 docks the real v1 strategy and ships v2, then cronTick infers (router served locally), signs and posts a pair,
// a taker fills it through the real AquaSwapVMRouter, a TEE-unverified answer is refused, and the quote expires.
import { createPublicClient, custom, encodeAbiParameters, encodeFunctionData, http, parseAbi, parseAbiParameters, toHex, hashTypedData, keccak256, type Address, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { USDC, W0G } from "../src/price.js";
import { boardV2Abi } from "../src/poster.js";
import { pairTypedData, unlockedSigner, type Pair } from "../src/signer.js";
import { quote as routerQuote, swap as takerSwap, takerTraitsExactIn, AQUA_ROUTER, type ShippedOrder } from "../src/taker.js";
import { cronTick, emptyCronState, type CronState } from "../src/worker-tick.js";
import { ACCOUNTS, fundToken, rpc, waitForRpc } from "./fork-setup.js";

const rpcUrl = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
const MAKER = (process.env.MAKER_ADDRESS || "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953") as Address;
const V1_HASH = (process.env.V1_STRATEGY_HASH || "0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e") as Hex;
// Anvil's first default account, derived from its published test mnemonic: never a real wallet.
const ANVIL0_PK = toHex(mnemonicToAccount("test test test test test test test test test test test junk").getHdKey().privateKey!);
const AGENT = ACCOUNTS[0]!;
const TAKER = ACCOUNTS[1]!;

async function launch(url: string) {
  const p = Bun.spawn(["forge", "script", "script/LaunchV2.s.sol", "--rpc-url", url, "--unlocked", "--sender", MAKER, "--broadcast", "--slow"], { cwd: new URL("../../contracts", import.meta.url).pathname, env: { ...process.env, FORK_UNLOCKED: "true", MAKER_ADDRESS: MAKER, AGENT, V1_STRATEGY_HASH: V1_HASH, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`LaunchV2 failed\n${out}\n${err}`);
  const line = out.split("\n").find(x => x.includes("LIVE_ORDER_V2="));
  if (!line) throw new Error(`LaunchV2 printed no order\n${out}`);
  return JSON.parse(line.slice(line.indexOf("=") + 1));
}

function routerMock(teeVerified: boolean | null) {
  let n = 0;
  return Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { verify_tee?: boolean; model: string };
    n++;
    const decision = { spreadBps: 40, skewBps: 25, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "calm tape, inventory W0G-heavy: lean prices down 25 bps to shed W0G" };
    return Response.json({ choices: [{ message: { content: JSON.stringify(decision) } }], usage: { total_tokens: 210 }, x_0g_trace: { request_id: `e2e-${teeVerified}-${n}`, provider: "0xf4FB8d2bD856e672b5f9848b0eD235A20079B250", ...(body.verify_tee && teeVerified !== null ? { tee_verified: teeVerified } : {}), billing: { currency: "0g", total_cost: "272018666666666" } } });
  } });
}

// The Payment Layer lives on 0G chain; the fork covers Base only, so the vault read answers from a fixed balance.
const zeroG = createPublicClient({ transport: custom({ request: async ({ method }) => {
  if (method === "eth_chainId") return "0x4115";
  if (method === "eth_call") return encodeAbiParameters(parseAbiParameters("uint256"), [2_343_959_530_558_679_712n]);
  if (method === "eth_getBalance") return "0x2386f26fc10000";
  if (method === "eth_blockNumber") return "0x1";
  throw new Error(`0G stand-in has no ${method}`);
} }) });

async function main() {
  const port = 19545 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
  const anvil = Bun.spawn(["anvil", "--fork-url", rpcUrl, "--port", String(port), "--auto-impersonate", "--silent", "--retries", "20", "--fork-retry-backoff", "400"], { stdout: "ignore", stderr: "pipe" });
  const local = createPublicClient({ chain: base, transport: http(url), pollingInterval: 200 });
  const servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    await waitForRpc(url);
    // Before the mainnet cutover this rehearses LaunchV2 itself; after it, v1 is already docked on the fork and the run
    // drives the deployed v2 board instead, registering the fork-only agent through the impersonated maker.
    let live: any;
    try { live = await launch(url); }
    catch (e) {
      if (!(e instanceof Error) || !e.message.includes("nothing to ship")) throw e;
      live = JSON.parse(await Bun.file(new URL("../../web/worker/live-order-v2.json", import.meta.url).pathname).text());
      const maker = unlockedSigner(url, MAKER).wallet;
      const h = await maker.writeContract({ address: live.board, abi: parseAbi(["function setAgent(address)"]), functionName: "setAgent", args: [AGENT], account: MAKER, chain: null });
      if ((await local.waitForTransactionReceipt({ hash: h })).status !== "success") throw new Error("setAgent on the live v2 board failed on the fork");
    }
    const epochNow = await local.readContract({ address: live.board, abi: boardV2Abi, functionName: "epochOf", args: [MAKER] });
    const board = live.board as Address, order: ShippedOrder = { maker: live.order.maker, traits: BigInt(live.order.traits), data: live.order.data };
    const v1Docked = await local.readContract({ address: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a", abi: parseAbi(["function rawBalances(address,address,bytes32,address) view returns (uint248,uint8)"]), functionName: "rawBalances", args: [MAKER, AQUA_ROUTER, V1_HASH, W0G] });
    if (v1Docked[1] !== 0xff) throw new Error("v1 strategy was not docked");
    await rpc(url, "evm_increaseTime", [700]); await rpc(url, "evm_mine");
    const env = (zgApiBase: string, nowMs: number) => ({ base: local, zeroG, chain: base, baseRpcUrl: url, board, aquaApp: AQUA_ROUTER, strategyHash: live.strategyHash as Hex, maker: MAKER, agent: AGENT, spendCapPerDayWei: 10n ** 18n, agentPk: ANVIL0_PK, zgApiKey: "e2e", zgApiBase, now: nowMs, fills: [] });
    const nowOf = async () => Number((await local.getBlock()).timestamp) * 1000;

    const probe: Pair = { maker: MAKER, token0: W0G, token1: USDC, rate01E18: 147_000n, rate10E18: 6_800_000_000_000_000_000_000_000_000_000n, maxIn0: 1n, maxIn1: 1n, expiry: 1n, epoch: epochNow, nonce: 1n, inferenceId: keccak256(toHex("probe")) };
    const digestLocal = hashTypedData(pairTypedData(8453, board, probe)), digestChain = await local.readContract({ address: board, abi: boardV2Abi, functionName: "pairDigest", args: [probe] });
    if (digestLocal !== digestChain) throw new Error(`TypeScript EIP-712 digest ${digestLocal} differs from board.pairDigest ${digestChain} (chainId ${await local.getChainId()})`);
    const good = routerMock(true); servers.push(good);
    const t1 = await cronTick(emptyCronState(), env(`http://127.0.0.1:${good.port}`, await nowOf()));
    if (!t1.outcome.startsWith("posted ")) throw new Error(`first tick did not post: ${t1.outcome} ${t1.state.lastTick?.error ?? ""}`);
    const posted = t1.state.posted.slice(-2);
    if (posted.length !== 2 || posted.some(p => !p.requestId || p.postedTx !== posted[0]!.postedTx)) throw new Error("postPair did not record both directions with one tx and a request id");
    const receipt = await local.getTransactionReceipt({ hash: posted[0]!.postedTx });
    if (receipt.status !== "success") throw new Error("postPair receipt not success");
    const inf = t1.state.inferences.at(-1)!;
    if (inf.reason !== "calm tape, inventory W0G-heavy: lean prices down 25 bps to shed W0G" || inf.skewBps !== 25 || inf.teeVerified !== true || inf.ttlSeconds !== 900) throw new Error(`inference record incomplete: ${JSON.stringify(inf)}`);
    const onChain = await local.readContract({ address: board, abi: boardV2Abi, functionName: "getQuote", args: [MAKER, USDC, W0G] });
    if (onChain.inferenceId !== posted[1]!.inferenceId || onChain.rateE18.toString() !== posted[1]!.rateE18) throw new Error("board quote differs from the recorded post");

    await fundToken(url, local, USDC, TAKER, 10n * 10n ** 6n);
    const amountIn = 10_000n;
    const q = await routerQuote(local, order, { tokenIn: USDC, tokenOut: W0G, amountIn });
    const bal = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    const before = await local.readContract({ address: W0G, abi: bal, functionName: "balanceOf", args: [TAKER] });
    const fill = await takerSwap(local, unlockedSigner(url, TAKER).wallet, order, { tokenIn: USDC, tokenOut: W0G, amountIn });
    const got = (await local.readContract({ address: W0G, abi: bal, functionName: "balanceOf", args: [TAKER] })) - before;
    if (got !== q.amountOut || got === 0n) throw new Error(`fill ${got} differs from quote ${q.amountOut}`);

    const bad = routerMock(false); servers.push(bad);
    const nonceBefore = await local.readContract({ address: board, abi: boardV2Abi, functionName: "lastNonce", args: [MAKER, epochNow] });
    const expiring = { ...t1.state, quotedAt: null } as CronState;
    const t2 = await cronTick(expiring, env(`http://127.0.0.1:${bad.port}`, await nowOf()));
    const nonceAfter = await local.readContract({ address: board, abi: boardV2Abi, functionName: "lastNonce", args: [MAKER, epochNow] });
    if (!t2.outcome.startsWith("refused tee_unverified") || nonceAfter !== nonceBefore) throw new Error(`TEE-unverified answer was not refused: ${t2.outcome}`);
    if (t2.state.inferences.at(-1)?.outcome !== "refused tee_unverified") throw new Error("refused run not recorded with its cost");

    // Manipulated spot: move slot0.sqrtPriceX96 up 2% (price +4%) while the tick, and so the TWAP, stay put. The agent must hold.
    const POOL = "0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e";
    const slot = await rpc(url, "eth_getStorageAt", [POOL, "0x0", "latest"]) as Hex;
    const word = BigInt(slot), mask = (1n << 160n) - 1n, sqrt = word & mask;
    await rpc(url, "anvil_setStorageAt", [POOL, "0x0", `0x${((word & ~mask) | (sqrt * 102n / 100n)).toString(16).padStart(64, "0")}`]);
    const t3 = await cronTick({ ...t2.state, quotedAt: null } as CronState, env(`http://127.0.0.1:${good.port}`, await nowOf()));
    const nonceManip = await local.readContract({ address: board, abi: boardV2Abi, functionName: "lastNonce", args: [MAKER, epochNow] });
    if (!t3.outcome.startsWith("hold spot_twap_gap") || nonceManip !== nonceBefore) throw new Error(`manipulated spot did not hold: ${t3.outcome}`);
    await rpc(url, "anvil_setStorageAt", [POOL, "0x0", slot]);

    await rpc(url, "evm_increaseTime", [901]); await rpc(url, "evm_mine");
    let stale = "";
    try { await local.call({ account: TAKER, to: AQUA_ROUTER, data: encodeFunctionData({ abi: parseAbi(["function swap((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256,uint256,bytes32)"]), functionName: "swap", args: [order, USDC, W0G, amountIn, takerTraitsExactIn] }) }); } catch (e) { stale = e instanceof Error ? e.message : String(e); }
    // QuoteExpired(uint64) selector
    const expiredSel = "0x" + (await import("viem")).toFunctionSelector("QuoteExpired(uint64)").slice(2);
    if (!stale.includes(expiredSel.slice(2)) && !stale.includes("QuoteExpired")) throw new Error(`expected QuoteExpired, got ${stale.slice(0, 300)}`);
    process.stdout.write(`E2E_V2_BOARD=${board}\nE2E_V1_DOCKED=1\nE2E_POSTPAIR_TX=${posted[0]!.postedTx}\nE2E_REQUEST_ID=${posted[0]!.requestId}\nE2E_FILL_TX=${fill.hash}\nE2E_QUOTE_EQ_FILL=1\nE2E_TEE_REFUSED=1\nE2E_SPOT_TWAP_HOLD=1\nE2E_STALE_REVERT=QuoteExpired\nE2E_V2_AMOUNTS=${live.amounts.w0g}/${live.amounts.usdc}\n`);
  } finally { for (const s of servers) s.stop(true); anvil.kill(); await anvil.exited; }
}
main().catch(e => { process.stderr.write(`fork-e2e-v2 failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
