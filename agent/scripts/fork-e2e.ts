import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPublicClient, http, keccak256, parseAbi, toHex } from "viem";
import { base } from "viem/chains";
import { readMarket, USDC, W0G } from "../src/price.js";
import { boardAbi } from "../src/poster.js";
import { quoteDomain, unlockedSigner, type Quote } from "../src/signer.js";
import { swap as takerSwap, takerTraitsExactIn, AQUA_ROUTER } from "../src/taker.js";
import { deployAndShip, fundToken, PRICE_ONLY_REASON, rpc, signAndPost, waitForRpc } from "./fork-setup.js";

const rpcUrl = process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com";
async function main() {
  const port = 18545 + Math.floor(Math.random() * 1000), url = `http://127.0.0.1:${port}`;
  const anvil = Bun.spawn(["anvil", "--fork-url", rpcUrl, "--port", String(port)], { stdout: "ignore", stderr: "pipe" });
  const rpcAt = (method: string, params: unknown[] = []) => rpc(url, method, params);
  const local = createPublicClient({ chain: base, transport: http(url) });
  try {
    await waitForRpc(url);
    const { board, order, maker, agent, taker } = await deployAndShip(url, local);
    const market = await readMarket(local), priceE18 = BigInt(Math.round(market.mid * 1e18));
    const amountIn = 5n * 10n ** 6n;
    const rateE18 = 10n ** 48n / priceE18;
    const quote: Quote = { maker, tokenIn: USDC, tokenOut: W0G, rateE18, expiry: BigInt(Math.floor(Date.now() / 1000) + 600), nonce: 1n, inferenceId: keccak256(toHex(PRICE_ONLY_REASON)) };
    const digestLocal = (await import("viem")).hashTypedData({ domain: quoteDomain(8453, board), types: (await import("../src/signer.js")).quoteTypes, primaryType: "Quote", message: quote });
    const digestChain = await local.readContract({ address: board, abi: boardAbi, functionName: "quoteDigest", args: [quote] });
    if (digestLocal.toLowerCase() !== digestChain.toLowerCase()) throw new Error("TypeScript EIP-712 digest differs from board.quoteDigest");
    const changedQuote = { ...quote, nonce: quote.nonce + 1n };
    const changedLocal = (await import("viem")).hashTypedData({ domain: quoteDomain(8453, board), types: (await import("../src/signer.js")).quoteTypes, primaryType: "Quote", message: changedQuote });
    const changedChain = await local.readContract({ address: board, abi: boardAbi, functionName: "quoteDigest", args: [changedQuote] });
    if (changedLocal.toLowerCase() !== changedChain.toLowerCase() || changedLocal.toLowerCase() === digestChain.toLowerCase()) throw new Error("digest mutation check did not distinguish the changed nonce");
    const { hash: postHash } = await signAndPost(url, local, board, agent, quote);
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
