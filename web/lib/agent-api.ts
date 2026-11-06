import { z } from "zod";
import { AGENT_URL } from "./config";
import { errorBodySchema, routerQuoteSchema, statusSchema, type AgentStatus, type RouterQuote } from "./schema";

export type AgentErrorKind = "unreachable" | "http" | "shape";

export class AgentError extends Error {
  constructor(readonly kind: AgentErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "AgentError";
  }
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}${path}`, { cache: "no-store", signal });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new AgentError("unreachable", `No answer from ${AGENT_URL || "the status route"}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AgentError("shape", `${AGENT_URL}${path} did not return JSON (HTTP ${res.status})`, res.status);
  }
  if (!res.ok) {
    const parsed = errorBodySchema.safeParse(body);
    throw new AgentError("http", parsed.success ? parsed.data.error : `HTTP ${res.status}`, res.status);
  }
  return body;
}

function parseOrThrow<T>(schema: z.ZodType<T>, body: unknown, what: string): T {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  throw new AgentError("shape", `${what} has an unexpected shape at ${first ? first.path.join(".") || "root" : "root"}`);
}

export async function fetchStatus(signal?: AbortSignal): Promise<AgentStatus> {
  return parseOrThrow(statusSchema, await getJson("/api/status", signal), "Agent status");
}

export async function fetchRouterQuote(amountIn: bigint, tokenIn: string, signal?: AbortSignal): Promise<RouterQuote> {
  const qs = new URLSearchParams({ amountIn: amountIn.toString(), tokenIn });
  return parseOrThrow(routerQuoteSchema, await getJson(`/api/quote?${qs}`, signal), "Router quote");
}
