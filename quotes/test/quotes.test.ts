import { beforeEach, describe, expect, test } from "bun:test";
import { getAddress, toHex, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { handle, type Deps, type Env, type Kv } from "../src/index";
import type { LiveQuote } from "../src/chain";
import { authorizationTypes, encodeHeader, USDC, USDC_DOMAIN, type Authorization } from "../src/x402";

const MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const NOW = 1_793_949_000;
const URL_Q = "https://wick-quotes.test/v1/quote?tokenIn=USDC&amountIn=1000000";
const payer = privateKeyToAccount(generatePrivateKey());

const memKv = () => {
  const m = new Map<string, string>();
  return { m, kv: { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => void m.set(k, v) } as Kv };
};

const fakeQuote: LiveQuote = {
  board: "0x309933CE439Da6A059593d73B8c82E8C8447C3F8", maker: MAKER, tokenIn: USDC, tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861",
  rateE18: "6785728668511460271604626195821", expiry: String(NOW + 900), nonce: "8", inferenceId: "0xdd361a64c797711d40620a8d6fb32410539766f1cfc40613b039646bfe956bfa",
  requestId: "65073141-8324-44a8-b819-c0f421c55ff8", postedTx: null, amountIn: "1000000", routerAmountOut: "6765371482505926889", strategyDepthOut: "2000000000000000000",
  amountOut: "2000000000000000000", orderHash: "0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e", readAtBlock: "1",
};

// The chain stand-in: USDC's authorizationState flips only when a settlement lands, as on Base.
let used: Set<string>;
let settles: number;
let confirmFails: boolean;
const deps: Deps = {
  now: () => NOW,
  authorizationUsed: async (a) => used.has(`${getAddress(a.from)}:${a.nonce}`),
  readQuote: async () => fakeQuote,
  settle: async (p) => { settles++; return toHex(settles, { size: 32 }); },
  confirm: async (_tx, a) => { if (confirmFails) throw new Error("settlement_reverted"); used.add(`${getAddress(a.from)}:${a.nonce}`); return { block: 42n }; },
};

let env: Env;
let store: Map<string, string>;
beforeEach(() => {
  used = new Set(); settles = 0; confirmFails = false;
  const k = memKv(); store = k.m;
  env = { QUOTES_KV: k.kv, MAKER, BOARD_ADDRESS: fakeQuote.board, PRICE_ATOMIC: "10000" };
});

async function sign(over: Partial<Authorization> = {}, signer = payer) {
  const a: Authorization = { from: payer.address, to: MAKER, value: "10000", validAfter: String(NOW - 60), validBefore: String(NOW + 120), nonce: toHex(crypto.getRandomValues(new Uint8Array(32))), ...over };
  const signature = await signer.signTypedData({
    domain: USDC_DOMAIN, types: authorizationTypes, primaryType: "TransferWithAuthorization",
    message: { from: a.from, to: a.to, value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
  });
  return { a, signature, header: encodeHeader({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization: a } }) };
}
const call = (header?: string, url = URL_Q) => handle(new Request(url, { headers: header ? { "X-PAYMENT": header } : {} }), env, deps);
const stats = async () => (await (await call(undefined, "https://wick-quotes.test/v1/stats")).json()) as Record<string, unknown>;

describe("402 Payment Required", () => {
  test("matches the x402 v1 PaymentRequirementsResponse shape", async () => {
    const res = await call();
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(Object.keys(body).sort()).toEqual(["accepts", "error", "x402Version"]);
    expect(body.x402Version).toBe(1);
    expect(body.accepts).toHaveLength(1);
    const r = body.accepts[0];
    for (const k of ["scheme", "network", "maxAmountRequired", "asset", "payTo", "resource", "description", "maxTimeoutSeconds"]) expect(r[k]).toBeDefined();
    expect(r).toMatchObject({ scheme: "exact", network: "base", maxAmountRequired: "10000", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: MAKER, resource: URL_Q, mimeType: "application/json", extra: { name: "USD Coin", version: "2" } });
    expect(typeof r.maxTimeoutSeconds).toBe("number");
    // PayAI answers invalid_payment_requirements to any optional field sent as null (seen live with outputSchema: null).
    expect(Object.values(r).includes(null)).toBe(false);
  });

  test("bad query is a 400, not a payment request", async () => {
    expect((await call(undefined, "https://wick-quotes.test/v1/quote?tokenIn=DAI&amountIn=1")).status).toBe(400);
    expect((await call(undefined, "https://wick-quotes.test/v1/quote?tokenIn=USDC&amountIn=0")).status).toBe(400);
  });
});

describe("paid request", () => {
  test("a valid payment settles and returns the quote with the settlement tx", async () => {
    const { header } = await sign();
    const res = await call(header);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.quote.inferenceId).toBe(fakeQuote.inferenceId);
    expect(body.quote.requestId).toBe(fakeQuote.requestId);
    expect(body.payment).toMatchObject({ success: true, payer: payer.address, amount: "10000", network: "base", block: "42" });
    const xpr = JSON.parse(atob(res.headers.get("X-PAYMENT-RESPONSE")!));
    expect(xpr).toEqual({ success: true, transaction: body.payment.transaction, network: "base", payer: payer.address });
    expect(settles).toBe(1);
  });

  const rejects: Array<[string, () => Promise<string>, string]> = [
    ["forged signature (signed by another key)", async () => (await sign({}, privateKeyToAccount(generatePrivateKey()))).header, "invalid_exact_evm_payload_signature"],
    ["signature over different fields", async () => { const s = await sign(); return encodeHeader({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: s.signature, authorization: { ...s.a, value: "20000" } } }); }, "invalid_exact_evm_payload_authorization_value"],
    ["tampered signature bytes", async () => { const s = await sign(); const sig = (s.signature.slice(0, 10) + (s.signature[10] === "a" ? "b" : "a") + s.signature.slice(11)) as Hex; return encodeHeader({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: sig, authorization: s.a } }); }, "invalid_exact_evm_payload_signature"],
    ["wrong amount", async () => (await sign({ value: "9999" })).header, "invalid_exact_evm_payload_authorization_value"],
    ["wrong payTo", async () => (await sign({ to: payer.address })).header, "invalid_exact_evm_payload_recipient_mismatch"],
    ["expired validBefore", async () => (await sign({ validBefore: String(NOW - 1) })).header, "invalid_exact_evm_payload_authorization_valid_before"],
    ["not yet valid", async () => (await sign({ validAfter: String(NOW + 60) })).header, "invalid_exact_evm_payload_authorization_valid_after"],
    ["wrong network", async () => { const s = await sign(); return encodeHeader({ x402Version: 1, scheme: "exact", network: "base-sepolia", payload: { signature: s.signature, authorization: s.a } }); }, "unsupported_scheme_or_network"],
    ["garbage header", async () => "not-base64-json", "invalid_payload"],
  ];
  for (const [name, make, reason] of rejects) {
    test(`rejects ${name}`, async () => {
      const res = await call(await make());
      expect(res.status).toBe(402);
      expect(((await res.json()) as any).error).toBe(reason);
      expect(settles).toBe(0);
    });
  }

  test("rejects a replayed nonce after it settled", async () => {
    const { header } = await sign();
    expect((await call(header)).status).toBe(200);
    const res = await call(header);
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toBe("invalid_exact_evm_payload_authorization_nonce_used");
    expect(settles).toBe(1);
  });

  test("no live quote: 503 and nothing settled", async () => {
    const { header } = await sign();
    const res = await handle(new Request(URL_Q, { headers: { "X-PAYMENT": header } }), env, { ...deps, readQuote: async () => null });
    expect(res.status).toBe(503);
    expect(settles).toBe(0);
  });
});

describe("stats", () => {
  test("increment only on settled payments", async () => {
    expect(await stats()).toEqual({ paidQuotes: 0, revenueUsdc: "0", distinctPayers: 0, lastSettlementTx: null });
    await call(); // 402, no payment
    await call((await sign({ value: "1" })).header); // rejected
    confirmFails = true;
    const reverted = await call((await sign()).header);
    expect(reverted.status).toBe(502);
    expect(settles).toBe(1);
    expect(await stats()).toEqual({ paidQuotes: 0, revenueUsdc: "0", distinctPayers: 0, lastSettlementTx: null });
    confirmFails = false;
    const ok = (await (await call((await sign()).header)).json()) as any;
    const ok2 = (await (await call((await sign()).header)).json()) as any;
    expect(await stats()).toEqual({ paidQuotes: 2, revenueUsdc: "0.02", distinctPayers: 1, lastSettlementTx: ok2.payment.transaction });
    const rec = JSON.parse(store.get(`paid:${ok.payment.transaction}`)!);
    expect(rec).toMatchObject({ payer: payer.address, amount: "10000", settlementTx: ok.payment.transaction, block: "42" });
    expect(typeof rec.time).toBe("string");
  });
});
