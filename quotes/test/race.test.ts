import { expect, test } from "bun:test";
import { getAddress, toHex, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { handle } from "../src/index";
import { authorizationTypes, encodeHeader, USDC, USDC_DOMAIN } from "../src/x402";

const MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const NOW = 1_793_949_000;
const URL_Q = "https://wick-quotes.test/v1/quote?tokenIn=USDC&amountIn=1000000";
const payer = privateKeyToAccount(generatePrivateKey());
const m = new Map<string, string>();
const kv = { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => void m.set(k, v) };
const used = new Set<string>();
const claimed = new Set<string>();
const TX = toHex(7, { size: 32 });
const deps = {
  now: () => NOW,
  authorizationUsed: async (a: any) => used.has(`${getAddress(a.from)}:${a.nonce}`),
  claim: async (key: string) => { if (claimed.has(key)) return false; claimed.add(key); return true; },
  readQuote: async () => ({ inferenceId: "0x" + "11".repeat(32) }) as any,
  settle: async () => TX,
  confirm: async (_tx: any, a: any) => { await new Promise((r) => setTimeout(r, 50)); used.add(`${getAddress(a.from)}:${a.nonce}`); return { block: 42n }; },
  health: async () => ({}) as any,
};

test("one authorization, five concurrent requests, one settlement tx serves one quote", async () => {
  const a = { from: payer.address, to: MAKER, value: "10000", validAfter: String(NOW - 60), validBefore: String(NOW + 120), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))) };
  const signature = await payer.signTypedData({ domain: USDC_DOMAIN, types: authorizationTypes, primaryType: "TransferWithAuthorization", message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce } });
  const header = encodeHeader({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: a } });
  const env = { QUOTES_KV: kv, MAKER, BOARD_ADDRESS: "0x0d87944FFFf253dBbbD07750AceE7898333218A5", PRICE_ATOMIC: "10000" } as any;
  const rs = await Promise.all(Array.from({ length: 5 }, () => handle(new Request(URL_Q, { headers: { "X-PAYMENT": header } }), env, deps as any)));
  expect(rs.filter((r) => r.status === 200).length).toBe(1);
});
