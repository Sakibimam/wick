// wick-quotes: other agents pay 0.01 USDC over x402 for Wick's signed price. The USDC lands on the maker, where the funding leg sweeps it to 0G Compute.
import { formatUnits, getAddress, isAddress, type Address, type Hex } from "viem";
import { authorizationUsed, confirm, readQuote, settle, W0G, type ChainEnv, type LiveQuote } from "./chain";
import { decodePayment, encodeHeader, requirements, USDC, verifyPayment, type Authorization, type PaymentPayload, type PaymentRequirements } from "./x402";

export type Kv = { get(key: string, type: "json"): Promise<unknown>; put(key: string, value: string): Promise<void> };
export type Env = ChainEnv & { QUOTES_KV: Kv; PRICE_ATOMIC?: string };

export type Deps = {
  now(): number;
  authorizationUsed(a: Authorization): Promise<boolean>;
  readQuote(tokenIn: Address, amountIn: bigint): Promise<LiveQuote | null>;
  settle(p: PaymentPayload, req: PaymentRequirements): Promise<Hex>;
  confirm(tx: Hex, a: Authorization): Promise<{ block: bigint }>;
};

export type Stats = { paidQuotes: number; revenueAtomic: string; payers: Address[]; lastSettlementTx: Hex | null };
export type PaidRecord = { payer: Address; amount: string; settlementTx: Hex; block: string; time: string; tokenIn: Address; amountIn: string; inferenceId: Hex };

const TOKENS: Record<string, Address> = { USDC, W0G };
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "X-PAYMENT, Content-Type", "access-control-expose-headers": "X-PAYMENT-RESPONSE" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { "cache-control": "no-store", ...cors, ...headers } });
const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0]! : String(e));

export const liveDeps = (env: Env): Deps => ({
  now: () => Math.floor(Date.now() / 1000),
  authorizationUsed: (a) => authorizationUsed(env, a),
  readQuote: (t, amt) => readQuote(env, t, amt, Math.floor(Date.now() / 1000)),
  settle: (p, r) => settle(env, p, r),
  confirm: (tx, a) => confirm(env, tx, a),
});

async function readStats(kv: Kv): Promise<Stats> {
  return ((await kv.get("stats", "json")) as Stats | null) ?? { paidQuotes: 0, revenueAtomic: "0", payers: [], lastSettlementTx: null };
}

export async function handle(req: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  if (url.pathname === "/v1/stats") {
    const s = await readStats(env.QUOTES_KV);
    return json({ paidQuotes: s.paidQuotes, revenueUsdc: formatUnits(BigInt(s.revenueAtomic), 6), distinctPayers: s.payers.length, lastSettlementTx: s.lastSettlementTx });
  }
  if (url.pathname !== "/v1/quote") return json({ error: "not found", routes: ["/v1/quote?tokenIn=USDC|W0G&amountIn=<atomic>", "/v1/stats"] }, 404);

  const tokenIn = TOKENS[(url.searchParams.get("tokenIn") ?? "").toUpperCase()];
  const raw = url.searchParams.get("amountIn") ?? "";
  if (!tokenIn || !/^\d{1,40}$/.test(raw) || BigInt(raw) === 0n) return json({ error: "tokenIn must be USDC or W0G and amountIn a positive integer in the token's atomic units" }, 400);
  const amountIn = BigInt(raw);

  const payTo = getAddress(env.MAKER);
  const reqs = requirements(`${url.origin}${url.pathname}${url.search}`, payTo, BigInt(env.PRICE_ATOMIC || "10000"));
  const paymentRequired = (error: string, status = 402) => json({ x402Version: 1, error, accepts: [reqs] }, status);

  const header = req.headers.get("X-PAYMENT");
  if (!header) return paymentRequired("X-PAYMENT header is required");
  const payment = decodePayment(header);
  if (!payment) return paymentRequired("invalid_payload");
  const verdict = await verifyPayment(payment, reqs, deps.now());
  if (!verdict.ok) return paymentRequired(verdict.reason);
  const auth = payment.payload.authorization;
  try {
    if (await deps.authorizationUsed(auth)) return paymentRequired("invalid_exact_evm_payload_authorization_nonce_used");
  } catch (e) {
    return json({ error: `nonce read failed: ${msg(e)}` }, 502);
  }

  // Read the price before taking money: no live quote means nothing is sold and nothing is settled.
  let quote: LiveQuote | null;
  try {
    quote = await deps.readQuote(tokenIn, amountIn);
  } catch (e) {
    return json({ error: `quote read failed, payment not settled: ${msg(e)}` }, 502);
  }
  if (!quote) return json({ error: "no live signed quote on the board right now, payment not settled" }, 503);

  let tx: Hex;
  let block: bigint;
  try {
    tx = await deps.settle(payment, reqs);
  } catch (e) {
    return paymentRequired(`settlement_failed: ${msg(e)}`);
  }
  try {
    ({ block } = await deps.confirm(tx, auth));
  } catch (e) {
    // ponytail: a receipt that lands after the timeout is not recorded; the tx hash lets the payer prove it.
    return json({ error: `settlement not confirmed: ${msg(e)}`, settlementTx: tx }, 502);
  }

  const record: PaidRecord = { payer: verdict.payer, amount: auth.value, settlementTx: tx, block: block.toString(), time: new Date(deps.now() * 1000).toISOString(), tokenIn, amountIn: amountIn.toString(), inferenceId: quote.inferenceId };
  // ponytail: read-modify-write on one KV key; concurrent payers can undercount stats (never the chain). A Durable Object fixes it if volume grows.
  const s = await readStats(env.QUOTES_KV);
  const payers = s.payers.includes(verdict.payer) ? s.payers : [...s.payers, verdict.payer];
  await env.QUOTES_KV.put(`paid:${tx}`, JSON.stringify(record));
  await env.QUOTES_KV.put("stats", JSON.stringify({ paidQuotes: s.paidQuotes + 1, revenueAtomic: (BigInt(s.revenueAtomic) + BigInt(auth.value)).toString(), payers, lastSettlementTx: tx } satisfies Stats));

  const settlement = { success: true, transaction: tx, network: reqs.network, payer: verdict.payer };
  return json({ quote, payment: { ...settlement, amount: auth.value, asset: USDC, payTo, block: block.toString() } }, 200, { "X-PAYMENT-RESPONSE": encodeHeader(settlement) });
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    if (!isAddress(env.MAKER ?? "") || !isAddress(env.BOARD_ADDRESS ?? "")) return Promise.resolve(json({ error: "MAKER and BOARD_ADDRESS must be set" }, 500));
    return handle(req, env, liveDeps(env));
  },
};
