// The JSON routes the pages read, served by the Worker before OpenNext sees the request.
import { BaseError, ContractFunctionRevertedError, getAddress, parseAbi, type Address } from "viem";
import { boardV2Abi } from "../../agent/src/poster";
import { depthCap } from "../../agent/src/policy";
import { AGENT, AQUA } from "../lib/evidence";
import { AQUA_ROUTER, USDC, W0G } from "../lib/config";
import { baseClient, fillsOfOrders, readAllFills, routerQuote, type Kv } from "./chain";
import type { CronState } from "../../agent/src/worker-tick";
import type { LiveOrder } from "../../agent/src/funding-machine";
import { buildStatus, runRecord } from "./status";
import { BOARD_V2, BOARD_V2_DEPLOY_BLOCK, FEE_BPS_V2, liveOrderOf, orderHashesOf, SHIPPED_LIVE_ORDER } from "./v2";

const readLive = async (kv: Kv | null) => liveOrderOf(kv ? ((await kv.get("cron-state", "json")) as CronState | null) : null);

// Read-only public chain data: any origin may read it (the local dev server included).
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
const first = (e: unknown) => (e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message.split("\n")[0]! : String(e));
const aquaAbi = parseAbi(["function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)"]);
let statusMemo: { at: number; body: unknown } | null = null;
let statusKvWrittenAt = 0;

export function __resetStatusCache() {
  statusMemo = null;
  statusKvWrittenAt = 0;
}

export async function cachedStatus(kv: Kv | null, build: () => Promise<unknown>, now: () => number = Date.now): Promise<{ body: unknown; status: number }> {
  const current = now();
  if (statusMemo && current - statusMemo.at < 15_000) return { body: statusMemo.body, status: 200 };
  try {
    const body = await build();
    const at = now();
    statusMemo = { at, body };
    if (kv && (!statusKvWrittenAt || at - statusKvWrittenAt >= 600_000)) {
      try {
        await kv.put("status-snapshot", JSON.stringify({ at, body }));
        statusKvWrittenAt = at;
      } catch { /* Snapshot persistence is best effort. */ }
    }
    return { body, status: 200 };
  } catch (e) {
    let snapshot: { at: number; body: unknown } | null = statusMemo;
    if (kv) {
      try {
        const stored = await kv.get("status-snapshot", "json") as { at: number; body: unknown } | null;
        if (stored && (!snapshot || stored.at > snapshot.at)) snapshot = stored;
      } catch { /* A failed snapshot read does not hide a memoized status. */ }
    }
    if (snapshot) return { body: { ...(snapshot.body as object), stale: { since: new Date(snapshot.at).toISOString(), error: first(e) } }, status: 200 };
    return { body: { error: `chain read failed: ${first(e)}` }, status: 502 };
  }
}

export async function handleApi(req: Request, kv: Kv | null): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/api/status") {
    const { body, status } = await cachedStatus(kv, () => buildStatus(kv));
    return json(body, status);
  }
  if (url.pathname === "/api/fills") {
    try {
      const [{ fills, cursor }, live] = await Promise.all([readAllFills(kv), readLive(kv)]);
      // Every hash the maker has run, so the history survives each harvest re-ship.
      const hashes = orderHashesOf(live);
      const ours = fillsOfOrders(fills, live).sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)));
      return json({ fills: ours, fromBlock: BOARD_V2_DEPLOY_BLOCK.toString(), toBlock: cursor, orderHash: live.hash, orderHashes: hashes });
    } catch (e) { return json({ error: `log read failed: ${first(e)}` }, 502); }
  }
  const run = url.pathname.match(/^\/api\/run\/([A-Za-z0-9-]{1,80})$/);
  if (run) {
    const rec = await runRecord(kv, run[1]!).catch(() => null);
    return rec ? json(rec) : json({ error: "no inference with that request id" }, 404);
  }
  if (url.pathname === "/api/quote") return quote(url, await readLive(kv).catch(() => SHIPPED_LIVE_ORDER));
  return json({ error: "not found" }, 404);
}

/** Largest exact input whose output fits the strategy's balance of tokenOut, inverting the extruction's maker-favoring rounding. */
export { depthCap };

/** router.quote() for the live strategy, the same view call a taker's swap runs first. An input above the strategy's depth or the
 *  quote's maxAmountIn comes back depth-limited: the largest fillable input, quoted, never a number the swap would revert on. */
async function quote(url: URL, live: LiveOrder): Promise<Response> {
  const raw = url.searchParams.get("amountIn");
  const tokenIn = url.searchParams.get("tokenIn");
  if (!raw || !/^\d{1,40}$/.test(raw) || BigInt(raw) <= 0n || !tokenIn || !/^0x[0-9a-fA-F]{40}$/.test(tokenIn) || ![W0G, USDC].includes(getAddress(tokenIn)))
    return json({ error: "amountIn and a supported tokenIn are required" }, 400);
  const tin = getAddress(tokenIn), tokenOut: Address = tin === W0G ? USDC : W0G;
  const client = baseClient();
  try {
    const [posted, balances] = await Promise.all([
      client.readContract({ address: BOARD_V2, abi: boardV2Abi, functionName: "getQuote", args: [AGENT, tin, tokenOut] }),
      client.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [AGENT, AQUA_ROUTER, live.hash, W0G, USDC] }),
    ]);
    const depthOut = tokenOut === W0G ? balances[0] : balances[1];
    const maxAmountIn = depthCap(depthOut, posted.rateE18, FEE_BPS_V2, posted.maxAmountIn);
    const asked = BigInt(raw);
    const depthLimited = asked > maxAmountIn;
    if (depthLimited && maxAmountIn === 0n) return json({ error: "strategy has no depth in this direction", maxAmountIn: "0", maxAmountOut: "0", depthLimited: true }, 409);
    const q = await routerQuote(client as never, { maker: live.order.maker, traits: BigInt(live.order.traits), data: live.order.data }, { tokenIn: tin, tokenOut, amountIn: depthLimited ? maxAmountIn : asked });
    return json({ amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(), orderHash: q.orderHash, requestedAmountIn: asked.toString(), maxAmountIn: maxAmountIn.toString(), maxAmountOut: depthOut.toString(), depthLimited });
  } catch (e) {
    const full = e instanceof Error ? e.message : String(e);
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const data = reverted instanceof ContractFunctionRevertedError ? (reverted.raw ?? "") : "";
    const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
    const stale = /StaleQuote|QuoteExpired|0xb915daf5/.test(full + data + (name ?? ""));
    return json({ error: `router quote reverted: ${stale ? "StaleQuote, the signed price expired; the agent posts a fresh one within 5 minutes" : name ?? first(e)}` }, 409);
  }
}
