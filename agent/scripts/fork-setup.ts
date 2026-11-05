import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createPublicClient, encodeAbiParameters, http, keccak256, parseAbi, parseAbiParameters, toHex, type Address, type Hex, type PublicClient } from "viem";
import { base } from "viem/chains";
import { readMarket, USDC, W0G } from "../src/price.js";
import { boardAbi, post as postQuote } from "../src/poster.js";
import { signQuote, unlockedSigner, type Quote } from "../src/signer.js";
import { type ShippedOrder } from "../src/taker.js";
import { DEFAULT_BUDGET_CONFIG } from "../src/budget.js";
import { directionalRates, type Persisted } from "../src/runtime.js";

// Anvil's default unlocked accounts, used only through RPC (anvil holds the keys).
export const ACCOUNTS = ["0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266", "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", "0x90F79bf6EB2c4f870365E785982E1f101E93b906"] as Address[];
export const PRICE_ONLY_REASON = "price-only quote, brain skipped: no ZG_API_KEY";

export const rpc = async (url: string, method: string, params: unknown[] = []) => { const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }); const j = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result; };
const run = async (cmd: string, args: string[], env: Record<string, string> = {}) => { const p = Bun.spawn([cmd, ...args], { cwd: new URL("../../contracts", import.meta.url).pathname, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" }); const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (code) throw new Error(`${cmd} ${args.join(" ")} failed (${code})\n${err}\n${out}`); return out + err; };
const big32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export async function waitForRpc(url: string, tries = 50) {
  let last: unknown;
  for (let i = 0; i < tries; i++) { try { return await rpc(url, "eth_chainId"); } catch (e) { last = e; await Bun.sleep(200); } }
  throw new Error(`RPC ${url} did not answer: ${last instanceof Error ? last.message : String(last)}`);
}

export async function fundToken(url: string, client: PublicClient<any, any>, token: Address, owner: Address, amount: bigint) {
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

export type ForkDeployment = { board: Address; extruction: Address; order: ShippedOrder; deployer: Address; maker: Address; agent: Address; taker: Address; deployBlock: bigint };

/** Deploys the board and extruction, funds the maker, ships the Aqua strategy and registers the agent signer. */
export async function deployAndShip(url: string, client: PublicClient<any, any>, inventory = { w0g: 50_000n * 10n ** 18n, usdc: 50_000n * 10n ** 6n }): Promise<ForkDeployment> {
  const [deployer, maker, agent, taker] = ACCOUNTS as [Address, Address, Address, Address];
  const deployBlock = await client.getBlockNumber();
  const deployOut = await run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", url, "--unlocked", "--sender", deployer, "--broadcast"], { FORK_UNLOCKED: "true" });
  const boardMatch = deployOut.match(/AgentQuoteBoard\s+(0x[\da-fA-F]{40})/), extMatch = deployOut.match(/AgentQuoteExtruction\s+(0x[\da-fA-F]{40})/);
  if (!boardMatch || !extMatch) throw new Error(`deployment addresses missing\n${deployOut}`);
  const board = boardMatch[1] as Address, extruction = extMatch[1] as Address;
  await fundToken(url, client, W0G, maker, inventory.w0g); await fundToken(url, client, USDC, maker, inventory.usdc);
  const shipOut = await run("forge", ["script", "script/ShipStrategy.s.sol", "--rpc-url", url, "--unlocked", "--sender", maker, "--broadcast"], { FORK_UNLOCKED: "true", BOARD: board, EXTRUCTION: extruction, MAKER_ADDRESS: maker, W0G_AMOUNT: String(inventory.w0g), USDC_AMOUNT: String(inventory.usdc), FEE_BPS: "30" });
  const order = decodeOrder(shipOut);
  await rpc(url, "anvil_impersonateAccount", [maker]);
  const makerWallet = unlockedSigner(url, maker).wallet;
  const setHash = await makerWallet.writeContract({ address: board, abi: parseAbi(["function setAgent(address)"]), functionName: "setAgent", args: [agent], account: maker, chain: null });
  const setReceipt = await client.waitForTransactionReceipt({ hash: setHash, retryCount: 10, retryDelay: 1_000 });
  if (setReceipt.status !== "success") throw new Error(`setAgent reverted: ${setHash}`);
  return { board, extruction, order, deployer, maker, agent, taker, deployBlock };
}

/** Signs a quote with the registered agent account over RPC and posts it to the board. */
export async function signAndPost(url: string, client: PublicClient<any, any>, board: Address, agent: Address, quote: Quote) {
  const agentWallet = unlockedSigner(url, agent).wallet;
  const sig = await signQuote(agentWallet, 8453, board, quote);
  return postQuote(client, agentWallet, board, quote, sig);
}

/** Dev flow for the web app: deploy, ship, post both signed prices, fund a taker, write runtime state and a shell env file. */
async function main() {
  const url = process.env.RPC_URL || "http://127.0.0.1:8545";
  const statePath = process.env.STATE_PATH || "./state/fork.json";
  const ttl = Number(process.env.QUOTE_TTL_SECONDS || "600");
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("QUOTE_TTL_SECONDS must be a positive integer");
  const chainId = await waitForRpc(url);
  if (Number(chainId) !== 8453) throw new Error(`expected a Base fork (8453), got chain ${Number(chainId)}`);
  const clientVersion = String(await rpc(url, "web3_clientVersion"));
  if (!/anvil/i.test(clientVersion)) throw new Error(`refusing to deploy: ${url} is ${clientVersion}, not a local anvil fork`);
  const client = createPublicClient({ chain: base, transport: http(url) });
  const d = await deployAndShip(url, client);
  const market = await readMarket(client);
  const priceE18 = BigInt(Math.round(market.mid * 1e18));
  const rates = directionalRates(priceE18, DEFAULT_BUDGET_CONFIG.baseSpreadBps);
  const lastNonce = await client.readContract({ address: d.board, abi: parseAbi(["function lastNonce(address) view returns (uint64)"]), functionName: "lastNonce", args: [d.maker] });
  const head = await client.getBlock({ blockTag: "latest" });
  const expiry = head.timestamp + BigInt(ttl);
  const quotes: Persisted["quotes"] = [];
  let nonce = lastNonce;
  for (const [tokenIn, tokenOut, rateE18] of [[USDC, W0G, rates.usdcToW0g], [W0G, USDC, rates.w0gToUsdc]] as const) {
    nonce++;
    const q: Quote = { maker: d.maker, tokenIn, tokenOut, rateE18, expiry, nonce, inferenceId: keccak256(toHex(PRICE_ONLY_REASON + tokenIn + tokenOut)) };
    const sent = await signAndPost(url, client, d.board, d.agent, q);
    const onBoard = await client.readContract({ address: d.board, abi: boardAbi, functionName: "getQuote", args: [d.maker, tokenIn, tokenOut] });
    if (onBoard.rateE18 !== rateE18 || onBoard.nonce !== nonce) throw new Error(`board does not hold the posted ${tokenIn} quote`);
    quotes.push({ tokenIn, tokenOut, rateE18: rateE18.toString(), expiry: expiry.toString(), inferenceId: q.inferenceId, requestId: "price-only", postedTx: sent.hash, postedBlock: sent.receipt.blockNumber.toString() });
  }
  await fundToken(url, client, USDC, d.taker, 1_000n * 10n ** 6n);
  await fundToken(url, client, W0G, d.taker, 1_000n * 10n ** 18n);
  const state: Persisted = { agent: d.agent, maker: d.maker, chainId: 8453, pair: { w0g: W0G, usdc: USDC }, mid: market.mid, quotes, budget: { tier: "PAUSED", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: process.env.SPEND_CAP_PER_DAY_WEI || "0", reason: "not_started" }, fees: { accruedUsdc: "0", accruedW0g: "0" }, funding: [], inferences: [], order: d.order, recentMids: [market.mid], lastMid: market.mid, quoteTimes: { mid: Number(head.timestamp) * 1000 }, lastNonce: nonce.toString(), lastComputeBalanceWei: "", spentTodayWei: "0", day: "", lastFillBlock: "" };
  await mkdir(dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { mode: 0o600 });
  const orderJson = JSON.stringify({ maker: d.order.maker, traits: `0x${d.order.traits.toString(16).padStart(64, "0")}`, data: d.order.data });
  const env = [`BOARD_ADDRESS=${d.board}`, `MAKER_ADDRESS=${d.maker}`, `AGENT_ADDRESS=${d.agent}`, `TAKER_ADDRESS=${d.taker}`, `DEPLOY_BLOCK=${d.deployBlock}`, `ORDER_JSON='${orderJson}'`];
  await writeFile(join(dirname(statePath), "fork.env"), env.map(x => `export ${x}`).join("\n") + "\n");
  process.stdout.write(`FORK_BOARD=${d.board}\nFORK_POSTED_TXS=${quotes.map(q => q.postedTx).join(",")}\nFORK_QUOTE_EXPIRY=${expiry}\nFORK_TAKER=${d.taker}\nFORK_STATE=${statePath}\n`);
}

if (import.meta.main) main().catch(e => { process.stderr.write(`fork-setup failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exitCode = 1; });
