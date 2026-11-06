// End to end on an anvil fork of Base: the Worker handler served over real HTTP, the reference client paying it,
// USDC.transferWithAuthorization settled by a relayer, and the receipt read back from the fork.
import { createPublicClient, createTestClient, getAddress, http, parseAbi, parseAbiItem, toHex, walletActions, type Address, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { handle, liveDeps, type Env } from "../src/index";
import { USDC } from "../src/x402";
import type { Health, LiveQuote } from "../src/chain";
import order from "../../web/worker/live-order-v2.json";

const FORK_URL = process.env.FORK_URL || "https://base-rpc.publicnode.com";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const WHALE: Address = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A"; // an EOA holding USDC on Base
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const assert = (cond: unknown, what: string) => { if (!cond) throw new Error(`FAIL: ${what}`); console.log(`ok   ${what}`); };

// Fork just after the board v2's latest QuotePosted (postPair emits one per direction), so a fresh v2 quote is live at the fork block.
const posted = parseAbiItem("event QuotePosted(address indexed maker,address indexed tokenIn,address indexed tokenOut,uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)");
const live = createPublicClient({ chain: base, transport: http(FORK_URL) });
const head = await live.getBlockNumber();
// Base mines a block every 200 ms: a 900 s TTL spans 4,500 blocks. Walk back 2,000 blocks at a time, at most 10,000 (about 33 minutes).
let post: Awaited<ReturnType<typeof live.getLogs<typeof posted>>>[number] | undefined;
for (let to = head; !post && to > head - 10_000n; to -= 2_000n) {
  post = (await live.getLogs({ address: getAddress(order.board), event: posted, args: { maker: MAKER }, fromBlock: to - 1_999n, toBlock: to })).at(-1);
}
if (!post) throw new Error(`no QuotePosted on board v2 ${order.board} in the last 10,000 blocks before ${head}`);
const forkAt = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : post.blockNumber + 1n;
console.log(`board v2 ${order.board}: latest postPair tx ${post.transactionHash} in block ${post.blockNumber}, expiry ${post.args.expiry}, inferenceId ${post.args.inferenceId}`);
const anvil = Bun.spawn(["anvil", "--fork-url", FORK_URL, "--fork-block-number", String(forkAt), "--port", String(PORT), "--silent"], { env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const pub = createPublicClient({ chain: base, transport: http(RPC) });
  for (let i = 0; ; i++) { try { await pub.getBlockNumber(); break; } catch { if (i > 60) throw new Error("anvil did not start"); await Bun.sleep(500); } }
  const forkBlock = await pub.getBlockNumber();
  console.log(`fork of Base at block ${forkBlock}`);

  // Payer: a fresh key that exists only in this process. Relayer: anvil's first dev account (public test mnemonic, funded by anvil).
  const payerPk = generatePrivateKey();
  const payer = privateKeyToAccount(payerPk).address;
  const relayer = mnemonicToAccount("test test test test test test test test test test test junk");
  const test = createTestClient({ chain: base, mode: "anvil", transport: http(RPC) }).extend(walletActions);
  // The fork block is minutes old; mine from wall-clock time so the payer's EIP-3009 window (validAfter = now - 60) is open.
  await test.setNextBlockTimestamp({ timestamp: BigInt(Math.floor(Date.now() / 1000)) });
  await test.impersonateAccount({ address: WHALE });
  await test.setBalance({ address: WHALE, value: 10n ** 18n });
  const fund = await test.writeContract({ account: WHALE, address: USDC, abi: erc20, functionName: "transfer", args: [payer, 1_000_000n] });
  assert((await pub.waitForTransactionReceipt({ hash: fund })).status === "success", "impersonated USDC holder funded the payer with 1 USDC");

  const kv = new Map<string, string>();
  const env: Env = {
    QUOTES_KV: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null), put: async (k, v) => void kv.set(k, v) },
    BASE_RPC_URL: RPC,
    BOARD_ADDRESS: order.board,
    MAKER,
    PRICE_ATOMIC: "10000",
    SETTLE_MODE: "relayer",
    RELAYER_PK: toHex(relayer.getHdKey().privateKey!),
    STATUS_URL: "https://wick.earn-shield-alerts.workers.dev/api/status",
  };
  server = Bun.serve({ port: 0, fetch: (req) => handle(req, env, liveDeps(env)) });
  const QUOTES_URL = `http://127.0.0.1:${server.port}`;

  const health = (await (await fetch(`${QUOTES_URL}/v1/health`)).json()) as Health;
  console.log(`     | health ${JSON.stringify(health)}`);
  assert(health.board === getAddress(order.board) && health.orderHash === order.strategyHash && health.quoteFresh, "health reads board v2, the v2 order hash, and a fresh quote");

  const unpaid = await fetch(`${QUOTES_URL}/v1/quote?tokenIn=USDC&amountIn=1000000`);
  assert(unpaid.status === 402, `unpaid call answers 402 (${unpaid.status})`);

  const [payerBefore, makerBefore] = await Promise.all([payer, MAKER].map((a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] })));
  const headerFile = `/tmp/wick-quotes-xpayment-${process.pid}`;
  // Async spawn: the server answering the client lives on this process's event loop.
  const client = Bun.spawn(["bun", "run", `${import.meta.dir}/../client/pay-and-quote.ts`], {
    env: { ...process.env, PAYER_PK: payerPk, QUOTES_URL, TOKEN_IN: "USDC", AMOUNT_IN: "1000000", X_PAYMENT_OUT: headerFile },
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(client.stdout).text(), new Response(client.stderr).text(), client.exited]);
  console.log(out.replace(/^/gm, "     | "));
  assert(code === 0, `client exited 0 ${err.trim()}`);

  const tx = out.match(/settlement tx (0x[0-9a-f]{64})/)?.[1] as Hex | undefined;
  assert(tx, "client printed a settlement tx");
  const quote = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as LiveQuote;
  assert(quote.board === getAddress(order.board) && quote.inferenceId === post.args.inferenceId && quote.expiry === String(post.args.expiry), `paid quote is the v2 post (nonce ${quote.nonce}, epoch ${quote.epoch})`);
  assert(quote.requestId, `paid quote names its 0G Compute requestId ${quote.requestId}`);
  assert(BigInt(quote.amountIn) <= BigInt(quote.maxAmountIn) && quote.depthLimited === BigInt(quote.amountIn) < 1_000_000n, `fill capped at maxAmountIn ${quote.maxAmountIn}: amountIn ${quote.amountIn}, amountOut ${quote.amountOut}`);
  const receipt = await pub.getTransactionReceipt({ hash: tx! });
  assert(receipt.status === "success", `fork receipt status 1 for ${tx} in block ${receipt.blockNumber}`);
  const [payerAfter, makerAfter] = await Promise.all([payer, MAKER].map((a) => pub.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [a] })));
  assert(payerBefore! - payerAfter! === 10_000n, `payer paid exactly 0.01 USDC (${payerBefore} -> ${payerAfter})`);
  assert(makerAfter! - makerBefore! === 10_000n, `maker received exactly 0.01 USDC (${makerBefore} -> ${makerAfter})`);

  const stats = (await (await fetch(`${QUOTES_URL}/v1/stats`)).json()) as { paidQuotes: number; revenueUsdc: string; distinctPayers: number; lastSettlementTx: string };
  console.log(`     | stats ${JSON.stringify(stats)}`);
  assert(stats.paidQuotes === 1 && stats.revenueUsdc === "0.01" && stats.distinctPayers === 1 && stats.lastSettlementTx === tx, "stats record the one settled payment");

  const replay = await fetch(`${QUOTES_URL}/v1/quote?tokenIn=USDC&amountIn=1000000`, { headers: { "X-PAYMENT": await Bun.file(headerFile).text() } });
  const replayBody = (await replay.json()) as { error: string };
  assert(replay.status === 402 && replayBody.error === "invalid_exact_evm_payload_authorization_nonce_used", `replayed X-PAYMENT refused: ${replayBody.error}`);
  const after = (await (await fetch(`${QUOTES_URL}/v1/stats`)).json()) as { paidQuotes: number };
  assert(after.paidQuotes === 1, "replay did not add a paid quote");
  await Bun.file(headerFile).delete();
  console.log("PASS fork end to end");
} finally {
  server?.stop(true);
  anvil.kill();
}
