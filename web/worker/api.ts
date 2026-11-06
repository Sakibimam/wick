// The JSON routes the pages read, served by the Worker before OpenNext sees the request.
import { BaseError, ContractFunctionRevertedError, getAddress, parseAbi, type Address } from "viem";
import { boardV2Abi } from "../../agent/src/poster";
import { AGENT, AQUA } from "../lib/evidence";
import { AQUA_ROUTER, USDC, W0G } from "../lib/config";
import { baseClient, liveOrder, readAllFills, routerQuote, type Kv } from "./chain";
import { buildStatus, runRecord } from "./status";
import { BOARD_V2, BOARD_V2_DEPLOY_BLOCK, FEE_BPS_V2, STRATEGY_HASH_V2 } from "./v2";
import { STRATEGY_HASH } from "../lib/evidence";

// Read-only public chain data: any origin may read it (the local dev server included).
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
const first = (e: unknown) => (e instanceof BaseError ? e.shortMessage : e instanceof Error ? e.message.split("\n")[0]! : String(e));
const aquaAbi = parseAbi(["function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)"]);
const BPS = 10_000n;

export async function handleApi(req: Request, kv: Kv | null): Promise<Response | null> {
  const url = new URL(req.url);
  if (!url.pathname.startsWith("/api/")) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  if (url.pathname === "/api/status") {
    try { return json(await buildStatus(kv)); } catch (e) { return json({ error: `chain read failed: ${first(e)}` }, 502); }
  }
  if (url.pathname === "/api/fills") {
    try {
      const { fills, cursor } = await readAllFills(kv);
      const hashes = [STRATEGY_HASH, STRATEGY_HASH_V2].map((h) => h.toLowerCase());
      const ours = fills.filter((f) => hashes.includes(f.orderHash.toLowerCase())).sort((a, b) => Number(BigInt(b.block) - BigInt(a.block)));
      return json({ fills: ours, fromBlock: BOARD_V2_DEPLOY_BLOCK.toString(), toBlock: cursor, orderHash: STRATEGY_HASH_V2, orderHashes: hashes });
    } catch (e) { return json({ error: `log read failed: ${first(e)}` }, 502); }
  }
  const run = url.pathname.match(/^\/api\/run\/([A-Za-z0-9-]{1,80})$/);
  if (run) {
    const rec = await runRecord(kv, run[1]!).catch(() => null);
    return rec ? json(rec) : json({ error: "no inference with that request id" }, 404);
  }
  if (url.pathname === "/api/quote") return quote(url);
  return json({ error: "not found" }, 404);
}

/** Largest exact input whose output fits the strategy's balance of tokenOut, inverting the extruction's maker-favoring rounding. */
export function depthCap(depthOut: bigint, rateE18: bigint, feeBps: number, quoteMaxIn: bigint): bigint {
  if (rateE18 === 0n) return 0n;
  const grossOutCap = (depthOut * BPS) / (BPS - BigInt(feeBps));
  const byDepth = (grossOutCap * 10n ** 18n) / rateE18;
  return byDepth < quoteMaxIn ? byDepth : quoteMaxIn;
}

/** router.quote() for the live strategy, the same view call a taker's swap runs first. An input above the strategy's depth or the
 *  quote's maxAmountIn comes back depth-limited: the largest fillable input, quoted, never a number the swap would revert on. */
async function quote(url: URL): Promise<Response> {
  const raw = url.searchParams.get("amountIn");
  const tokenIn = url.searchParams.get("tokenIn");
  if (!raw || !/^\d{1,40}$/.test(raw) || BigInt(raw) <= 0n || !tokenIn || !/^0x[0-9a-fA-F]{40}$/.test(tokenIn) || ![W0G, USDC].includes(getAddress(tokenIn)))
    return json({ error: "amountIn and a supported tokenIn are required" }, 400);
  const tin = getAddress(tokenIn), tokenOut: Address = tin === W0G ? USDC : W0G;
  const client = baseClient();
  try {
    const [posted, balances] = await Promise.all([
      client.readContract({ address: BOARD_V2, abi: boardV2Abi, functionName: "getQuote", args: [AGENT, tin, tokenOut] }),
      client.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [AGENT, AQUA_ROUTER, STRATEGY_HASH_V2, W0G, USDC] }),
    ]);
    const depthOut = tokenOut === W0G ? balances[0] : balances[1];
    const maxAmountIn = depthCap(depthOut, posted.rateE18, FEE_BPS_V2, posted.maxAmountIn);
    const asked = BigInt(raw);
    const depthLimited = asked > maxAmountIn;
    if (depthLimited && maxAmountIn === 0n) return json({ error: "strategy has no depth in this direction", maxAmountIn: "0", maxAmountOut: "0", depthLimited: true }, 409);
    const q = await routerQuote(client as never, liveOrder, { tokenIn: tin, tokenOut, amountIn: depthLimited ? maxAmountIn : asked });
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
