import { parseUnits } from "viem";

export type BrainState = { mid: number; recentMids: number[]; inventory: { w0g: number; usdc: number }; budgetTier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED" };
export type BrainErrorCode = "budget_critical" | "budget_paused" | "missing_api_key" | "request_failed" | "http_error" | "invalid_json" | "invalid_shape" | "spread_out_of_range" | "rate_out_of_range" | "request_id_missing";
export class BrainError extends Error { constructor(public readonly code: BrainErrorCode, message: string = code) { super(message); this.name = "BrainError"; } }
export const PRIMARY_MODEL = "0gm-1.0-35b-a3b";
export const CHEAP_MODEL = "qwen3.7-flash";
export const MODEL_BY_TIER = { NORMAL: PRIMARY_MODEL, LOW: CHEAP_MODEL } as const;
export async function askBrain(state: BrainState, options: { fetchImpl?: typeof fetch; apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
  if (state.budgetTier === "CRITICAL") throw new BrainError("budget_critical");
  if (state.budgetTier === "PAUSED") throw new BrainError("budget_paused");
  const apiKey = options.apiKey ?? process.env.ZG_API_KEY;
  if (!apiKey) throw new BrainError("missing_api_key");
  const model = MODEL_BY_TIER[state.budgetTier];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    let response: Response;
    try { response = await (options.fetchImpl ?? fetch)(`${(options.baseUrl ?? process.env.ZG_API_BASE ?? "https://router-api.0g.ai/v1").replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model, temperature: 0, max_tokens: 160, stream: false, messages: [{ role: "system", content: 'rateE18 is USDC per W0G scaled by 1e18 and must be within 3% of the supplied mid. spreadBps must be an integer from 5 to 500 inclusive. reason must be non-empty. Return only the JSON object {"rateE18": <integer>, "spreadBps": <integer>, "reason": "<short string>"}, no markdown.' }, { role: "user", content: JSON.stringify(state) }] }), signal: controller.signal }); }
    catch { throw new BrainError("request_failed"); }
    if (!response.ok) throw new BrainError("http_error", `router returned HTTP ${response.status}`);
    let body: any;
    try { body = await response.json(); } catch { throw new BrainError("invalid_json"); }
    const requestId = response.headers.get("X-Request-ID") || body?.x_0g_trace?.request_id;
    if (typeof requestId !== "string" || !requestId) throw new BrainError("request_id_missing");
    const content = body?.choices?.[0]?.message?.content;
    let value: any;
    try { if (typeof content !== "string" || content.trim().startsWith("``")) throw new Error(); value = JSON.parse(content); } catch { throw new BrainError("invalid_json"); }
    if (!value || Array.isArray(value) || typeof value !== "object" || Object.keys(value).sort().join(",") !== "rateE18,reason,spreadBps") throw new BrainError("invalid_shape");
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
    return { rateE18, spreadBps: value.spreadBps, reason: value.reason, requestId, model };
  } finally { clearTimeout(timeout); }
}
