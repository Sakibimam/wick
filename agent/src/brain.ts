import { parseUnits } from "viem";

export type BrainState = { mid: number; recentMids: number[]; inventory: { w0g: number; usdc: number }; budgetTier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED" };
export type BrainErrorCode = "budget_critical" | "budget_paused" | "missing_api_key" | "request_failed" | "http_error" | "invalid_json" | "invalid_shape" | "spread_out_of_range" | "rate_out_of_range" | "request_id_missing" | "ttl_out_of_range" | "max_amount_out_of_range" | "reason_invalid" | "tee_unverified" | "skew_against_inventory";
export type BilledRun = { requestId: string; model: string; billing: { currency: string | null; totalCost: string | null }; teeVerified: boolean | null; provider: string | null; providerIdentity?: string | null };
export class BrainError extends Error { run?: BilledRun; extraRuns: BilledRun[] = []; constructor(public readonly code: BrainErrorCode, message: string = code) { super(message); this.name = "BrainError"; } }
export const PRIMARY_MODEL = "0gm-1.0-35b-a3b-sia";
export const TEE_BACKUP_MODEL = "0gm-1.0-35b-a3b";
export const CHEAP_MODEL = "qwen3.7-flash";
export const MODEL_BY_TIER = { NORMAL: PRIMARY_MODEL, LOW: CHEAP_MODEL } as const;
// Models pad answers with whitespace or wrap them in ```json fences; take the outermost object, then validate strictly.
export function extractJsonObject(content: string): string { const t = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""); const a = t.indexOf("{"), b = t.lastIndexOf("}"); if (a < 0 || b <= a) throw new Error("no object"); return t.slice(a, b + 1); }
export type RouterResult = { value: any; requestId: string; model: string; tokens: number | null; costMicroUsd: number | null; billing: { currency: string | null; totalCost: string | null }; teeVerified: boolean | null; provider: string | null; providerIdentity: string | null; attempts: number };
type RouterOptions = { fetchImpl?: typeof fetch; apiKey?: string; baseUrl?: string; timeoutMs?: number; verifyTee?: boolean; retries?: number; backoffMs?: readonly number[]; sleep?: (ms: number) => Promise<void> };
/** Waits before each retry of a 5xx or dropped call: an upstream blip on the TeeML provider usually clears within seconds. */
export const ROUTER_BACKOFF_MS = [1_500, 4_000] as const;
/** Retries for the TeeML model before the standard-mode fallback: three attempts in all, so a verified answer survives two blips. */
export const TEE_RETRIES = 2;
/** One chat call to the 0G router: strict JSON out, the router request id required, billing and the TEE verdict read from x_0g_trace.
 *  A network failure or 5xx is retried once (no charge is taken for either); a 4xx or a malformed answer is not. */
export async function routerJson(model: string, system: string, user: unknown, options: RouterOptions = {}): Promise<RouterResult> {
  const apiKey = options.apiKey ?? process.env.ZG_API_KEY;
  if (!apiKey) throw new BrainError("missing_api_key");
  const timeoutMs = options.timeoutMs ?? (options.verifyTee ? 45_000 : 20_000);
  const url = `${(options.baseUrl ?? (process.env.ZG_API_BASE || "https://router-api.0g.ai/v1")).replace(/\/$/, "")}/chat/completions`;
  const body = JSON.stringify({ model, temperature: 0, max_tokens: 256, chat_template_kwargs: { enable_thinking: false }, stream: false, ...(options.verifyTee ? { verify_tee: true } : {}), messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(user) }] });
  let response: Response | undefined, attempts = 0;
  const backoff = options.backoffMs ?? ROUTER_BACKOFF_MS, sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (const maxAttempts = 1 + (options.retries ?? 1); attempts < maxAttempts;) {
    if (attempts > 0) await sleep(backoff[Math.min(attempts - 1, backoff.length - 1)] ?? 0);
    attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try { response = await (options.fetchImpl ?? fetch)(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body, signal: controller.signal }); }
    catch (e) { if (attempts < maxAttempts) continue; throw new BrainError("request_failed", `request_failed: ${controller.signal.aborted ? `no answer within ${timeoutMs} ms` : e instanceof Error ? `${e.name} ${e.message}` : String(e)}`); }
    finally { clearTimeout(timeout); }
    if (response.status >= 500 && attempts < maxAttempts) continue;
    break;
  }
  if (!response!.ok) {
    // A provider failure carries its own x_0g_trace: name the provider and request in the error, so the record says who failed.
    const t = await response!.json().then((j: any) => j?.x_0g_trace, () => null);
    const who = [typeof t?.provider === "string" && `provider ${t.provider}`, typeof t?.provider_identity === "string" && `identity ${t.provider_identity}`, typeof t?.request_id === "string" && `request ${t.request_id}`].filter(Boolean).join(", ");
    throw new BrainError("http_error", `router returned HTTP ${response!.status} after ${attempts} attempt${attempts > 1 ? "s" : ""}${who ? ` (${who})` : ""}`);
  }
  let json: any;
  try { json = await response!.json(); } catch { throw new BrainError("invalid_json"); }
  const trace = json?.x_0g_trace;
  const requestId = trace?.request_id || response!.headers.get("X-Request-ID")?.split(",").pop()?.trim();
  if (typeof requestId !== "string" || !requestId) throw new BrainError("request_id_missing");
  const content = json?.choices?.[0]?.message?.content;
  let value: any;
  try { if (typeof content !== "string") throw new Error(); value = JSON.parse(extractJsonObject(content)); } catch { throw new BrainError("invalid_json"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new BrainError("invalid_shape");
  const tokens = Number.isSafeInteger(json?.usage?.total_tokens) && json.usage.total_tokens >= 0 ? json.usage.total_tokens as number : null;
  const billing = trace?.billing;
  const costMicroUsd = /^\d+$/.test(String(billing?.total_cost_usd_micro ?? "")) ? Number(billing.total_cost_usd_micro) : null;
  // currency "0g" means total_cost is wei charged from the Payment Layer vault; "usd" means micro-USD.
  return { value, requestId, model, tokens, costMicroUsd, billing: { currency: typeof billing?.currency === "string" ? billing.currency : null, totalCost: /^\d+$/.test(String(billing?.total_cost ?? "")) ? String(billing.total_cost) : null }, teeVerified: typeof trace?.tee_verified === "boolean" ? trace.tee_verified : null, provider: typeof trace?.provider === "string" ? trace.provider : null, providerIdentity: typeof trace?.provider_identity === "string" ? trace.provider_identity : null, attempts };
}

export async function askBrain(state: BrainState, options: { fetchImpl?: typeof fetch; apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
  if (state.budgetTier === "CRITICAL") throw new BrainError("budget_critical");
  if (state.budgetTier === "PAUSED") throw new BrainError("budget_paused");
  const model = MODEL_BY_TIER[state.budgetTier];
  const r = await routerJson(model, 'rateE18 is USDC per W0G scaled by 1e18 and must be within 3% of the supplied mid. spreadBps must be an integer from 5 to 500 inclusive. reason must be non-empty. Return only the JSON object {"rateE18": <integer>, "spreadBps": <integer>, "reason": "<short string>"}, no markdown.', state, { ...options, retries: 0 });
  const value = r.value;
  if (!Object.hasOwn(value, "rateE18") || !Object.hasOwn(value, "spreadBps") || !Object.hasOwn(value, "reason")) throw new BrainError("invalid_shape");
  if (typeof value.rateE18 !== "number" || !Number.isFinite(value.rateE18) || typeof value.spreadBps !== "number" || !Number.isFinite(value.spreadBps) || typeof value.reason !== "string" || !value.reason.trim()) throw new BrainError("invalid_shape");
  if (!Number.isInteger(value.spreadBps) || value.spreadBps < 5 || value.spreadBps > 500) throw new BrainError("spread_out_of_range");
  if (!Number.isInteger(value.rateE18)) throw new BrainError("rate_out_of_range");
  let midE18: bigint;
  try {
    if (!Number.isFinite(state.mid) || state.mid <= 0) throw new Error();
    midE18 = parseUnits(state.mid.toFixed(18), 18);
    if (midE18 <= 0n) throw new Error();
  } catch { throw new BrainError("rate_out_of_range"); }
  const rateE18 = BigInt(value.rateE18);
  if (rateE18 <= 0n) throw new BrainError("rate_out_of_range");
  const diff = rateE18 > midE18 ? rateE18 - midE18 : midE18 - rateE18;
  if (diff * 10_000n > midE18 * 300n) throw new BrainError("rate_out_of_range");
  return { rateE18, spreadBps: value.spreadBps, reason: value.reason, requestId: r.requestId, model, tokens: r.tokens, costMicroUsd: r.costMicroUsd, billing: r.billing };
}

/** Bounds the decision must land inside; the extruction's on-chain band (800 bps) sits outside the widest half-spread. */
export const DECISION_BOUNDS = { halfSpreadBps: [5, 500], ttlSeconds: [840, 900] } as const;
/** Models served from a TeeML provider; their answers are signed only when the router verified the provider's TEE signature. */
export const TEE_MODELS = new Set<string>([PRIMARY_MODEL, TEE_BACKUP_MODEL]);
export type DecisionState = {
  twapMid: number; spotMid: number; recentMids: number[]; realizedVolBps: number;
  inventory: { w0g: number; usdc: number; w0gValueShare: number };
  recentFills: { side: "taker_bought_w0g" | "taker_sold_w0g"; amountUsdc: number; minutesAgo: number }[];
  gas: { baseEth: number; gasPerRequoteUsd: number };
  runway: { vault0g: number; runsLeft: number | null; days: number | null };
  budgetTier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED"; tierSpreadBps: number;
  maxAmountInUsdcCap: number;
  /** Which side to tighten, in words: the model is never asked to apply a sign convention. */
  inventoryGoal: string;
};
export type Decision = { bidHalfSpreadBps: number; askHalfSpreadBps: number; maxAmountInUsdc: number; ttlSeconds: number; reason: string };
const DECISION_PROMPT = `You run the quotes of a W0G/USDC market maker. Decide this round from the state JSON. Both prices sit around twapMid (USDC per W0G).
- bidHalfSpreadBps: integer ${DECISION_BOUNDS.halfSpreadBps[0]}..${DECISION_BOUNDS.halfSpreadBps[1]}. How far below twapMid you pay when a taker sells you W0G.
- askHalfSpreadBps: integer ${DECISION_BOUNDS.halfSpreadBps[0]}..${DECISION_BOUNDS.halfSpreadBps[1]}. How far above twapMid you charge when a taker buys W0G from you.
  Widen both with realizedVolBps and thin inventory. tierSpreadBps is a floor applied to each side anyway. inventoryGoal says which side to make tighter.
- maxAmountInUsdc: number in (0, maxAmountInUsdcCap]. Shrink it when runway.days or runway.runsLeft is short or recent fills are one-sided.
- ttlSeconds: integer ${DECISION_BOUNDS.ttlSeconds[0]}..${DECISION_BOUNDS.ttlSeconds[1]}. Shorter when volatile, longer when calm (each requote costs gas.gasPerRequoteUsd).
- reason: one sentence naming the inputs that drove the choice.
Return only {"bidHalfSpreadBps":<int>,"askHalfSpreadBps":<int>,"maxAmountInUsdc":<number>,"ttlSeconds":<int>,"reason":"<string>"}, no markdown.`;
/** Inventory share past which the lean is fixed: leaning the wrong way would add to the side the maker already holds too much of. */
export const SKEW_SIGN_SHARE = { above: 0.6, below: 0.4 } as const;
/** The inventory direction as an instruction, so the model compares two numbers instead of choosing a sign. */
export function inventoryGoal(w0gValueShare: number): string {
  const pct = `${(w0gValueShare * 100).toFixed(1)}% W0G by value`;
  if (w0gValueShare > SKEW_SIGN_SHARE.above) return `you hold ${pct}: make W0G cheaper to buy from you, so set askHalfSpreadBps below bidHalfSpreadBps`;
  if (w0gValueShare < SKEW_SIGN_SHARE.below) return `you hold ${pct}: make W0G dearer to buy from you and pay up to buy it back, so set bidHalfSpreadBps below askHalfSpreadBps`;
  return `inventory is balanced at ${pct}: keep the two half-spreads about equal`;
}
export function validateDecision(v: any, cap: number, w0gValueShare?: number): Decision {
  for (const k of ["bidHalfSpreadBps", "askHalfSpreadBps", "maxAmountInUsdc", "ttlSeconds", "reason"]) if (!Object.hasOwn(v, k)) throw new BrainError("invalid_shape", `invalid_shape: missing ${k}`);
  for (const k of ["bidHalfSpreadBps", "askHalfSpreadBps", "maxAmountInUsdc", "ttlSeconds"]) if (typeof v[k] !== "number" || !Number.isFinite(v[k])) throw new BrainError("invalid_shape", `invalid_shape: ${k} is not a number`);
  const inRange = (x: number, [a, b]: readonly [number, number]) => Number.isInteger(x) && x >= a && x <= b;
  if (!inRange(v.bidHalfSpreadBps, DECISION_BOUNDS.halfSpreadBps) || !inRange(v.askHalfSpreadBps, DECISION_BOUNDS.halfSpreadBps)) throw new BrainError("spread_out_of_range");
  if (!inRange(v.ttlSeconds, DECISION_BOUNDS.ttlSeconds)) throw new BrainError("ttl_out_of_range");
  if (!(cap > 0) || !(v.maxAmountInUsdc > 0) || v.maxAmountInUsdc > cap) throw new BrainError("max_amount_out_of_range");
  if (typeof v.reason !== "string" || !v.reason.trim() || v.reason.length > 280) throw new BrainError("reason_invalid");
  if (w0gValueShare !== undefined && ((w0gValueShare > SKEW_SIGN_SHARE.above && v.askHalfSpreadBps > v.bidHalfSpreadBps) || (w0gValueShare < SKEW_SIGN_SHARE.below && v.bidHalfSpreadBps > v.askHalfSpreadBps))) throw new BrainError("skew_against_inventory", `skew_against_inventory: bid ${v.bidHalfSpreadBps} ask ${v.askHalfSpreadBps} bps with W0G share ${w0gValueShare}`);
  return { bidHalfSpreadBps: v.bidHalfSpreadBps, askHalfSpreadBps: v.askHalfSpreadBps, maxAmountInUsdc: v.maxAmountInUsdc, ttlSeconds: v.ttlSeconds, reason: v.reason.trim() };
}
/** A TeeML model's answer is signable only with the router's verified TEE verdict; standard-mode models carry none. */
export function teeGate(model: string, teeVerified: boolean | null): boolean { return !TEE_MODELS.has(model) || teeVerified === true; }
/** The v2 decision: one 0G inference returns spread, skew, size and lifetime with a reason; a TeeML answer must carry tee_verified true. */
export async function askDecision(state: DecisionState, options: RouterOptions = {}) {
  if (state.budgetTier === "CRITICAL") throw new BrainError("budget_critical");
  if (state.budgetTier === "PAUSED") throw new BrainError("budget_paused");
  let model: string = MODEL_BY_TIER[state.budgetTier], fallbackFrom: string | null = null, r: RouterResult, extraRuns: BilledRun[] = [];
  const providerDown = (e: unknown) => e instanceof BrainError && (e.code === "request_failed" || (e.code === "http_error" && /HTTP 5\d\d/.test(e.message)));
  const asRun = (x: RouterResult): BilledRun => ({ requestId: x.requestId, model: x.model, billing: x.billing, teeVerified: x.teeVerified, provider: x.provider, providerIdentity: x.providerIdentity });
  const chainError = (e: unknown): never => { if (e instanceof BrainError) e.extraRuns = extraRuns; throw e; };
  try { r = await routerJson(model, DECISION_PROMPT, state, { retries: TEE_MODELS.has(model) ? TEE_RETRIES : 1, ...options, verifyTee: true }); }
  catch (e) {
    if (!providerDown(e) || model !== PRIMARY_MODEL) throw e;
    fallbackFrom = `${model}: ${e instanceof Error ? e.message : String(e)}`;
    model = TEE_BACKUP_MODEL;
    try { r = await routerJson(model, DECISION_PROMPT, state, { ...options, verifyTee: true, retries: 0 }); }
    catch (backupError) {
      if (!providerDown(backupError)) chainError(backupError);
      fallbackFrom += `; ${model}: ${backupError instanceof Error ? backupError.message : String(backupError)}`;
      model = CHEAP_MODEL;
      try { r = await routerJson(model, DECISION_PROMPT, state, { ...options, verifyTee: true, retries: 0 }); } catch (cheapError) { chainError(cheapError); }
    }
  }
  if (model === PRIMARY_MODEL && r.teeVerified !== true) {
    extraRuns.push(asRun(r));
    fallbackFrom = `${model}: tee_verified ${r.teeVerified}`;
    model = TEE_BACKUP_MODEL;
    try { r = await routerJson(model, DECISION_PROMPT, state, { ...options, verifyTee: true, retries: 0 }); }
    catch (e) {
      if (!providerDown(e)) chainError(e);
      fallbackFrom += `; ${model}: ${e instanceof Error ? e.message : String(e)}`;
      model = CHEAP_MODEL;
      try { r = await routerJson(model, DECISION_PROMPT, state, { ...options, verifyTee: true, retries: 0 }); } catch (cheapError) { chainError(cheapError); }
    }
  }
  const run = asRun(r);
  // The router has billed this answer: any refusal below carries the run so the caller still records its cost.
  const refuse = (e: BrainError) => { e.run = run; e.extraRuns = extraRuns; return e; };
  let decision: Decision;
  try { decision = validateDecision(r.value, state.maxAmountInUsdcCap, state.inventory.w0gValueShare); } catch (e) { throw e instanceof BrainError ? refuse(e) : e; }
  if (!teeGate(model, r.teeVerified)) throw refuse(new BrainError("tee_unverified", `tee_unverified: ${model} answered with tee_verified=${r.teeVerified} from ${r.provider ?? "unknown provider"} (request ${r.requestId})`));
  return { ...decision, requestId: r.requestId, model, fallbackFrom, extraRuns, tokens: r.tokens, costMicroUsd: r.costMicroUsd, billing: r.billing, teeVerified: r.teeVerified, provider: r.provider, providerIdentity: r.providerIdentity, attempts: r.attempts };
}
