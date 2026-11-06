// The three JSON routes the pages read, served by the Worker before OpenNext sees the request.
import { BaseError, ContractFunctionRevertedError, getAddress, type Address } from "viem";
import { baseClient, liveOrder, readLogIndex, routerQuote, type Kv } from "./chain";
import { buildStatus } from "./status";
import { BOARD_DEPLOY_BLOCK, STRATEGY_HASH } from "../lib/evidence";
import { USDC, W0G } from "../lib/config";

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const first = (e: unknown) => (e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message.split("\n")[0]! : String(e));

export async function handleApi(req: Request, kv: Kv | null): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/api/status") {
    try { return json(await buildStatus(kv)); } catch (e) { return json({ error: `chain read failed: ${first(e)}` }, 502); }
  }
  if (url.pathname === "/api/fills") {
    try {
      const idx = await readLogIndex(kv);
      const fills = idx.fills.filter((f) => f.orderHash.toLowerCase() === STRATEGY_HASH).sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)));
      return json({ fills, fromBlock: BOARD_DEPLOY_BLOCK.toString(), toBlock: idx.cursor, orderHash: STRATEGY_HASH });
    } catch (e) { return json({ error: `log read failed: ${first(e)}` }, 502); }
  }
  if (url.pathname === "/api/quote") return quote(url);
  return json({ error: "not found" }, 404);
}

/** router.quote() for the live strategy, the same view call a taker's swap runs first. StaleQuote comes back as plain copy. */
async function quote(url: URL): Promise<Response> {
  const raw = url.searchParams.get("amountIn");
  const tokenIn = url.searchParams.get("tokenIn");
  if (!raw || !/^\d{1,40}$/.test(raw) || BigInt(raw) <= 0n || !tokenIn || !/^0x[0-9a-fA-F]{40}$/.test(tokenIn) || ![W0G, USDC].includes(getAddress(tokenIn)))
    return json({ error: "amountIn and a supported tokenIn are required" }, 400);
  const tokenOut: Address = getAddress(tokenIn) === W0G ? USDC : W0G;
  try {
    const q = await routerQuote(baseClient as never, liveOrder, { tokenIn: getAddress(tokenIn), tokenOut, amountIn: BigInt(raw) });
    return json({ amountIn: q.amountIn.toString(), amountOut: q.amountOut.toString(), orderHash: q.orderHash });
  } catch (e) {
    const full = e instanceof Error ? e.message : String(e);
    const reverted = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
    const data = reverted instanceof ContractFunctionRevertedError ? (reverted.raw ?? "") : "";
    const stale = data.startsWith("0xb915daf5") || full.includes("0xb915daf5") || full.includes("StaleQuote");
    return json({ error: `router quote reverted: ${stale ? "StaleQuote, the signed price expired" : first(e)}` }, 409);
  }
}
