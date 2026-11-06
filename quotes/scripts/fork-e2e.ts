// End to end on an anvil fork of Base: the Worker handler served over real HTTP, the reference client paying it,
// USDC.transferWithAuthorization settled by a relayer, and the receipt read back from the fork.
import { createPublicClient, createTestClient, http, parseAbi, toHex, walletActions, type Address, type Hex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { handle, liveDeps, type Env } from "../src/index";
import { USDC } from "../src/x402";

const FORK_URL = process.env.FORK_URL || "https://base-rpc.publicnode.com";
const PORT = 8547;
const RPC = `http://127.0.0.1:${PORT}`;
const MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const WHALE: Address = "0x3304E22DDaa22bCdC5fCa2269b418046aE7b566A"; // an EOA holding USDC on Base
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"]);
const assert = (cond: unknown, what: string) => { if (!cond) throw new Error(`FAIL: ${what}`); console.log(`ok   ${what}`); };

const anvil = Bun.spawn(["anvil", "--fork-url", FORK_URL, "--port", String(PORT), "--silent"], { env: { ...process.env, FOUNDRY_DISABLE_NIGHTLY_WARNING: "1" } });
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
  await test.impersonateAccount({ address: WHALE });
  await test.setBalance({ address: WHALE, value: 10n ** 18n });
  const fund = await test.writeContract({ account: WHALE, address: USDC, abi: erc20, functionName: "transfer", args: [payer, 1_000_000n] });
  assert((await pub.waitForTransactionReceipt({ hash: fund })).status === "success", "impersonated USDC holder funded the payer with 1 USDC");

  const kv = new Map<string, string>();
  const env: Env = {
    QUOTES_KV: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)!) : null), put: async (k, v) => void kv.set(k, v) },
    BASE_RPC_URL: RPC,
    BOARD_ADDRESS: "0x309933CE439Da6A059593d73B8c82E8C8447C3F8",
    MAKER,
    PRICE_ATOMIC: "10000",
    SETTLE_MODE: "relayer",
    RELAYER_PK: toHex(relayer.getHdKey().privateKey!),
    STATUS_URL: "https://wick.earn-shield-alerts.workers.dev/api/status",
  };
  server = Bun.serve({ port: 0, fetch: (req) => handle(req, env, liveDeps(env)) });
  const QUOTES_URL = `http://127.0.0.1:${server.port}`;

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
