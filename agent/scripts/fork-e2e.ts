import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiParameters, toHex, type Address, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { readMarket, USDC, W0G } from "../src/price.js";
import { boardAbi, post as postQuote } from "../src/poster.js";
import { quoteDomain, signQuote, unlockedSigner, type Quote } from "../src/signer.js";
import { swap as takerSwap, takerTraitsExactIn, type ShippedOrder, AQUA_ROUTER } from "../src/taker.js";

const rpcUrl = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
const accounts = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906"] as Address[];
const rpc = async (url: string, method: string, params: unknown[] = []) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const run = async (cmd: string, args: string[], env: Record<string, string> = {}) => { const p = Bun.spawn([cmd, ...args], { cwd: new URL("../../contracts", import.meta.url).pathname, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) throw new Error(`${cmd} ${args.join(" ")} failed (${code})\n${err}\n${out}`); return out + err; };
const big32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
async function fundToken(url: string, client: PublicClient<any, any>, token: Address, owner: Address, amount: bigint) {
  const abi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
  for (let slot = 0n; slot < 32n; slot++) {
    const key = keccak256(encodeAbiParameters(parseAbiParameters("address,uint256"), [owner, slot]));
    const old = await rpc(url, "eth_getStorageAt", [token, key, "latest"]);
    await rpc(url, "anvil_setStorageAt", [token, key, big32(amount)]);
    const balance = await client.readContract({ address: token, abi, functionName: "balanceOf", args: [owner] });
    if (balance === amount) return;
    await rpc(url, "anvil_setStorageAt", [token, key, old]);
  }
  throw new Error(`could not locate ${token} balance mapping slot`);
}
function decodeOrder(output: string): ShippedOrder {
  const line = output.split("\n").find(x => x.trim().startsWith('{"strategyHash"'));
  if (!line) throw new Error("ShipStrategy did not print its order JSON");
  const obj = JSON.parse(line.trim()); return { maker: obj.order.maker, traits: BigInt(obj.order.traits), data: obj.order.data };
}
async function main() {
  const port = 18545 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
  const anvil = Bun.spawn(["anvil", "--fork-url", rpcUrl, "--port", String(port)], { stdout: "ignore", stderr: "pipe" });
  const rpcPortUrl = url;
  const rpcAt = async (method: string, params: unknown[] = []) => { const r = await fetch(rpcPortUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
  const local = createPublicClient({ chain: base, transport: http(url) });
  try {
    for (let i = 0; i < 50; i++) { try { await rpcAt("eth_chainId"); break; } catch { await Bun.sleep(200); } }
    const [deployer, maker, agent, taker] = accounts;
    const deployOut = await run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", url, "--unlocked", "--sender", deployer, "--broadcast"]);
    const boardMatch = deployOut.match(/AgentQuoteBoard\s+(0x[\da-fA-F]{40})/), extMatch = deployOut.match(/AgentQuoteExtruction\s+(0x[\da-fA-F]{40})/);
    if (!boardMatch || !extMatch) throw new Error(`deployment addresses missing\n${deployOut}`);
    const board = boardMatch[1] as Address, extruction = extMatch[1] as Address;
    await fundToken(url, local, W0G, maker, 50_000n * 10n ** 18n); await fundToken(url, local, USDC, maker, 50_000n * 10n ** 6n);
    const shipOut = await run("forge", ["script", "script/ShipStrategy.s.sol", "--rpc-url", url, "--unlocked", "--sender", maker, "--broadcast"], { BOARD: board, EXTRUCTION: extruction, MAKER_ADDRESS: maker, W0G_AMOUNT: String(50_000n * 10n ** 18n), USDC_AMOUNT: String(50_000n * 10n ** 6n), FEE_BPS: "30" });
    const order = decodeOrder(shipOut);
    await rpcAt("anvil_impersonateAccount", [maker]);
    const makerWallet = unlockedSigner(url, maker).wallet;
    await makerWallet.writeContract({ address: board, abi: parseAbi(["function setAgent(address)"]), functionName: "setAgent", args: [agent], account: maker, chain: null });
    const market = await readMarket(local), priceE18 = BigInt(Math.round(market.mid * 1e18));
    const amountIn = 5n * 10n ** 6n;
    const rateE18 = 10n ** 48n / priceE18;
    const quote: Quote = { maker, tokenIn: USDC, tokenOut: W0G, rateE18, expiry: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: 1n, inferenceId: keccak256(toHex("price-only quote, brain skipped: no ZG_API_KEY")) };
    const digestLocal = (await import("viem")).hashTypedData({ domain: quoteDomain(8453, board), types: (await import("../src/signer.js")).quoteTypes, primaryType: "Quote", message: quote });
    const digestChain = await local.readContract({ address: board, abi: boardAbi, functionName: "quoteDigest", args: [quote] });
    if (digestLocal.toLowerCase() !== digestChain.toLowerCase()) throw new Error("TypeScript EIP-712 digest differs from board.quoteDigest");
    const changedQuote = { ...quote, nonce: quote.nonce + 1n };
    const changedLocal = (await import("viem")).hashTypedData({ domain: quoteDomain(8453, board), types: (await import("../src/signer.js")).quoteTypes, primaryType: "Quote", message: changedQuote });
    const changedChain = await local.readContract({ address: board, abi: boardAbi, functionName: "quoteDigest", args: [changedQuote] });
    if (changedLocal.toLowerCase() !== changedChain.toLowerCase() || changedLocal.toLowerCase() === digestChain.toLowerCase()) throw new Error("digest mutation check did not distinguish the changed nonce");
    const agentWallet = unlockedSigner(url, agent).wallet, sig = await signQuote(agentWallet, 8453, board, quote);
    const { hash: postHash } = await postQuote(local, agentWallet, board, quote, sig);
    const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);
    await fundToken(url, local, USDC, taker, 10_000n * 10n ** 6n);
    const beforeTaker = await local.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [taker] });
    const beforeMaker = await local.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [maker] });
    const takerWallet = unlockedSigner(url, taker).wallet;
    await rpcAt("anvil_impersonateAccount", [taker]);
    const fill = await takerSwap(local, takerWallet, order, { tokenIn: USDC, tokenOut: W0G, amountIn });
    const afterTaker = await local.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [taker] });
    const afterMaker = await local.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [maker] });
    const expected = amountIn * rateE18 / 10n ** 18n * 9970n / 10000n;
    if (afterTaker - beforeTaker !== expected) throw new Error(`taker delta mismatch: expected ${expected}, got ${afterTaker - beforeTaker}`);
    if (beforeMaker - afterMaker !== expected) throw new Error(`maker delta mismatch: expected ${expected}, got ${beforeMaker - afterMaker}`);
    const statePath = join(tmpdir(), `upkeep-e2e-${process.pid}.json`);
    const status = { agent, maker, chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: market.mid, quotes: [{ tokenIn: USDC, tokenOut: W0G, rateE18: rateE18.toString(), expiry: quote.expiry.toString(), inferenceId: quote.inferenceId, requestId: "price-only", postedTx: postHash }], budget: { tier: "NORMAL", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: "0", reason: "price-only" }, fees: { accruedUsdc: "0", accruedW0g: "0" }, funding: [], inferences: [], order: { ...order, traits: `0x${order.traits.toString(16).padStart(64, "0")}` } };
    await writeFile(statePath, JSON.stringify(status));
    const statusProc = Bun.spawn(["bun", "run", "src/status.ts"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, STATE_PATH: statePath, PORT: "18787", BASE_RPC_URL: url }, stdout: "ignore", stderr: "pipe" });
    try {
      let response: Response | undefined; for (let i = 0; i < 30; i++) { try { response = await fetch("http://127.0.0.1:18787/api/status"); if (response.ok) break; } catch {} await Bun.sleep(200); }
      if (!response?.ok) throw new Error("status endpoint did not start");
      const body = await response.json(); const keys = ["agent", "maker", "chainId", "pair", "mid", "quotes", "budget", "fees", "funding", "inferences", "order"];
      if (!keys.every(k => Object.hasOwn(body, k))) throw new Error("status schema keys missing");
      const quoted = await fetch(`http://127.0.0.1:18787/api/quote?amountIn=${amountIn}&tokenIn=${USDC}`);
      const quoteBody = await quoted.json(); if (!quoted.ok || BigInt(quoteBody.amountIn) !== amountIn || BigInt(quoteBody.amountOut) !== expected) throw new Error("status quote endpoint disagrees with the shipped quote");
      await rpcAt("evm_increaseTime", [601]); await rpcAt("evm_mine");
      let stale = "";
      try { await local.call({ account: taker, to: AQUA_ROUTER, data: (await import("viem")).encodeFunctionData({ abi: parseAbi(["function swap((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) returns(uint256,uint256,bytes32)" ]), functionName: "swap", args: [order, USDC, W0G, amountIn, takerTraitsExactIn] }) }); } catch (e) { stale = String(e); }
      if (!stale.includes("StaleQuote") && !stale.includes("0xb915daf5")) throw new Error(`expected StaleQuote, got ${stale}`);
      process.stdout.write(`E2E_POSTED_TX=${postHash}\nE2E_FILL_TX=${fill.hash}\nE2E_TAKER_DELTA_OK=1\nE2E_MAKER_DELTA_OK=1\nE2E_STALE_REVERT=StaleQuote\nE2E_STATUS_OK=1\n`);
    } finally { statusProc.kill(); await rm(statePath, { force: true }); }
  } finally { anvil.kill(); await anvil.exited; }
}
main().catch(e => { process.stderr.write(`fork-e2e failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
