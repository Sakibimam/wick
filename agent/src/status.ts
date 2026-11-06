import type { Address, Hex } from "viem";
import { AQUA_ROUTER, type ShippedOrder } from "./taker.js";
export type RuntimeState = { agent: Address; maker: Address; chainId: number; pair: { w0g: Address; usdc: Address }; mid: number | null; quotes: any[]; budget: any; fees: { accruedUsdc: string; accruedW0g: string }; funding: any[]; inferences: any[]; order: ShippedOrder; fundingThresholdUsdc?: string; economics?: Record<string, number | null>; seedVsEarned?: { seed0g: number; earned0g: number }; distinctTakers?: number; strategyBacking?: Record<string, { claimed: string; held: string; backed: boolean }>; lastTicks?: { at: string; outcome: string; error?: string }[] };
export function statusSchema(state: RuntimeState) {
  return { agent: state.agent, maker: state.maker, chainId: state.chainId, pair: state.pair, mid: state.mid, quotes: state.quotes.map(q => ({ tokenIn: q.tokenIn, tokenOut: q.tokenOut, rateE18: q.rateE18, expiry: q.expiry, inferenceId: q.inferenceId, requestId: q.requestId, postedTx: q.postedTx, maxAmountIn: q.maxAmountIn ?? null })), budget: state.budget, fees: state.fees, funding: state.funding.map(x => ({ step: x.step, txHash: x.txHash, chainId: x.chainId, time: x.time })), inferences: state.inferences.map(x => ({ requestId: x.requestId, model: x.model, costWei: x.costWei, time: x.time, reason: x.reason ?? null, skewBps: x.skewBps ?? null, maxAmountIn: x.maxAmountIn ?? null, ttlSeconds: x.ttlSeconds ?? null, teeVerified: x.teeVerified ?? null })), order: { ...state.order, traits: `0x${state.order.traits.toString(16).padStart(64, "0")}` }, fundingThresholdUsdc: state.fundingThresholdUsdc ?? null, economics: state.economics ?? null, seedVsEarned: state.seedVsEarned ?? null, distinctTakers: state.distinctTakers ?? null, strategyBacking: state.strategyBacking ?? null, lastTicks: state.lastTicks ?? [] };
}
export function createStatusServer(getState: () => RuntimeState | Promise<RuntimeState>, getQuote: (amountIn: bigint, tokenIn: Address) => Promise<unknown>, port = Number(process.env.PORT || 8787)) {
  const allowed = process.env.WEB_ORIGIN || "";
  return Bun.serve({ port, async fetch(req) {
    const origin = req.headers.get("origin");
    const cors: Record<string, string> = origin && origin === allowed ? { "access-control-allow-origin": allowed, "access-control-allow-methods": "GET,OPTIONS", "access-control-allow-headers": "content-type", vary: "Origin" } : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405, headers: cors });
    if (url.pathname === "/api/status") return Response.json(statusSchema(await getState()), { headers: cors });
    if (url.pathname === "/api/quote") {
      const raw = url.searchParams.get("amountIn"), tokenIn = url.searchParams.get("tokenIn") as Address | null;
      const pair = (await getState()).pair;
      if (!raw || !/^\d+$/.test(raw) || BigInt(raw) <= 0n || !tokenIn || !/^0x[0-9a-fA-F]{40}$/.test(tokenIn) || ![pair.w0g, pair.usdc].some(x => x.toLowerCase() === tokenIn.toLowerCase())) return Response.json({ error: "amountIn and a supported tokenIn are required" }, { status: 400, headers: cors });
      let routed: unknown;
      try { routed = await getQuote(BigInt(raw), tokenIn); }
      catch (e) { const msg = e instanceof Error ? (("shortMessage" in e && typeof e.shortMessage === "string") ? e.shortMessage : e.message) : String(e); const full = e instanceof Error ? e.message : String(e); return Response.json({ error: `router quote reverted: ${full.includes("0xb915daf5") || full.includes("StaleQuote") ? "StaleQuote, the signed price expired" : msg.split("\n")[0]}` }, { status: 409, headers: cors }); }
      return new Response(JSON.stringify(routed, (_, value) => typeof value === "bigint" ? value.toString() : value), { headers: { "content-type": "application/json", ...cors } });
    }
    return Response.json({ error: "not found" }, { status: 404, headers: cors });
  } });
}
export { AQUA_ROUTER };
if (import.meta.main) {
  const { readFile } = await import("node:fs/promises");
  const { createPublicClient, http } = await import("viem");
  const { base } = await import("viem/chains");
  const { quote } = await import("./taker.js");
  const statePath = process.env.STATE_PATH || "./state/upkeep.json";
  const load = async () => { const s = JSON.parse(await readFile(statePath, "utf8")) as RuntimeState; s.order.traits = BigInt(s.order.traits as unknown as string); return s; };
  const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com") });
  const server = createStatusServer(load, async (amountIn, tokenIn) => {
    const s = await load(); const tokenOut = tokenIn.toLowerCase() === s.pair.w0g.toLowerCase() ? s.pair.usdc : s.pair.w0g;
    return quote(client, { ...s.order, traits: BigInt(s.order.traits as unknown as string) }, { tokenIn, tokenOut, amountIn });
  });
  process.stdout.write(`status listening on ${server.url}\n`);
}
