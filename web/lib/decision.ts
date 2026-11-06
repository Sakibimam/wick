import type { Inference } from "./schema";

/** The agent's guard codes (BrainError in agent/src/brain.ts) that reject a model answer it did receive, in plain words. */
const GUARD: Record<string, { short: string; why: string }> = {
  skew_against_inventory: { short: "skew against inventory", why: "The model leaned the price toward buying more of the token the strategy already holds too much of. The guard dropped the answer and the last signed price stayed up." },
  skew_out_of_range: { short: "skew out of bounds", why: "The model asked to move the centre further than the agent allows. The guard dropped the answer." },
  spread_out_of_range: { short: "spread out of bounds", why: "The model's spread fell outside the range the agent accepts. The guard dropped the answer." },
  ttl_out_of_range: { short: "lifetime out of bounds", why: "The model asked for a quote lifetime outside the window the board accepts. The guard dropped the answer." },
  max_amount_out_of_range: { short: "size over the cap", why: "The model asked to fill more per swap than the agent's cap. The guard dropped the answer." },
  rate_out_of_range: { short: "price too far from the pool", why: "The model's price sat too far from the pool mid. The guard dropped the answer." },
  reason_invalid: { short: "no usable reason", why: "Every signed price must carry a one-sentence reason; this answer's was missing or too long, so the guard dropped it." },
  invalid_shape: { short: "malformed answer", why: "The answer was missing a field the agent needs, so the guard dropped it." },
  invalid_json: { short: "unreadable answer", why: "The answer was not valid JSON, so the guard dropped it." },
  tee_unverified: { short: "TEE not verified", why: "This model's answer is signed only with a TEE verdict, and the router returned none, so the guard dropped it." },
};

/** Codes that mean the router never delivered an answer: a transport problem the next tick retries, not a decision. */
const TRANSPORT = new Set(["http_error", "request_failed", "missing_api_key", "request_id_missing", "error"]);

export type Outcome =
  | { kind: "posted"; label: string }
  | { kind: "refused"; code: string; label: string; why: string }
  | { kind: "failed"; code: string; label: string };

type RunFields = Pick<Inference, "outcome" | "reason" | "postedSpreadBps" | "spreadBps" | "skewBps" | "bidHalfSpreadBps" | "askHalfSpreadBps" | "postedBidHalfSpreadBps" | "postedAskHalfSpreadBps">;

/** The per-side half-spreads that went on chain: the posted pair after tier floors when reported, else the model's. */
export function sidesOf(r: RunFields): { bid: number; ask: number } | null {
  if (r.postedBidHalfSpreadBps != null && r.postedAskHalfSpreadBps != null) return { bid: r.postedBidHalfSpreadBps, ask: r.postedAskHalfSpreadBps };
  if (r.bidHalfSpreadBps != null && r.askHalfSpreadBps != null) return { bid: r.bidHalfSpreadBps, ask: r.askHalfSpreadBps };
  return null;
}

/** One run's outcome as a chip label: what it posted, or which guard refused it. */
export function outcomeOf(r: RunFields): Outcome {
  const o = (r.outcome ?? "posted").trim();
  if (o === "post_failed") return { kind: "failed", code: o, label: "Post failed on Base" };
  if (o.startsWith("refused")) {
    // "refused <code>", or "refused model answer, ..." with the guard's code leading the recorded reason.
    const code = /^refused model answer/.test(o) ? (/^([a-z_]+)(?::|$)/.exec(r.reason ?? "")?.[1] ?? "error") : (o.split(/\s+/)[1] ?? "error");
    const g = GUARD[code];
    if (g) {
      const after = /reposted/.test(o) ? " The last decision that passed every guard was re-posted around the new TWAP." : /repost failed/.test(o) ? " Re-posting the last good decision failed, so the book waits for the next tick." : "";
      return { kind: "refused", code, label: `Refused: ${g.short}`, why: g.why + after };
    }
    return { kind: "failed", code, label: TRANSPORT.has(code) ? "No answer: router error" : `Stopped: ${code.replace(/_/g, " ")}` };
  }
  const sides = sidesOf(r);
  if (sides) return { kind: "posted", label: `Posted: bid ${sides.bid} / ask ${sides.ask} bps` };
  const spread = r.postedSpreadBps ?? r.spreadBps;
  if (spread != null) return { kind: "posted", label: `Posted: ${spread} bps${r.skewBps ? `, lean ${r.skewBps > 0 ? "+" : ""}${r.skewBps}` : ""}` };
  return { kind: "posted", label: "Posted" };
}

/** Whether a cron tick outcome is a guard refusing an answer (a decision) rather than a transport failure. */
export function isGuardRefusal(outcome: string): boolean {
  const m = /^refused\s+(\S+)/.exec(outcome);
  return Boolean(m && (GUARD[m[1]!] || /refused model answer/.test(outcome)));
}

/** The model's reason in reader words: its variable names spelled out, shares as percentages, units spaced. */
export function humaniseReason(text: string): string {
  return text
    .replace(/\bw0g\s*value\s*share\b|\bw0gValueShare\b/gi, "W0G share of inventory")
    .replace(/(W0G share of inventory)(?:\s+of)?\s+\(?(0\.\d+)\)?/g, (_, p: string, v: string) => `${p} at ${(Number(v) * 100).toFixed(1).replace(/\.0$/, "")}%`)
    .replace(/(\d)\s*bps\b/gi, "$1 bps")
    .replace(/\brealized vol\b(?!atility)/gi, "realized volatility")
    .replace(/\bmax(?:imum)?\s*amount(?:In)?\b/gi, "size cap")
    .replace(/\bshort runway days\b/gi, "a short runway")
    .replace(/\brunway\s*days\b/gi, "runway")
    .replace(/\b([a-z]+)([A-Z][a-z]+)+\b/g, (w) => w.replace(/([A-Z])/g, " $1").toLowerCase());
}

/** The first clause of a reason, for a one-line summary; the full text sits behind an expander. */
export function gist(text: string): string {
  const cut = text.split(/[,;](?=\s)/)[0]!.trim();
  return cut.length < text.trim().length ? cut : text.trim().replace(/\.$/, "");
}
