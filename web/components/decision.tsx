import type { ReactNode } from "react";
import { ShieldCheck } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
import type { Outcome } from "@/lib/decision";
import { fmtUsdc, shortHash } from "@/lib/format";
import type { Inference } from "@/lib/schema";
import { cn } from "@/lib/utils";

/** A run's outcome: a price posted, or a guard refusal worn as a badge, since refusing a bad answer is the agent working. */
export function OutcomeChip({ o, className }: { o: Outcome; className?: string }) {
  return (
    <span className={cn("inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-control px-2 py-0.5 text-[13px] font-medium", o.kind === "refused" ? "tone-ok border border-[var(--tone)] text-ink" : o.kind === "posted" ? "bg-sunken text-ink" : "bg-sunken text-muted", className)}>
      {o.kind === "refused" ? <ShieldCheck className="size-3.5 text-[var(--tone)]" aria-hidden /> : <span aria-hidden className={cn("size-1.5 rounded-full", o.kind === "posted" ? "tone-ok bg-[var(--tone)]" : "bg-muted")} />}
      {o.label}
    </span>
  );
}

/** What a run decided and what it is bound to on chain, each fact only when the agent reported it. */
export function DecisionFacts({ raw, className, withModel }: { raw: Inference; className?: string; withModel?: boolean }) {
  const facts: [string, ReactNode][] = [];
  if (raw.bidHalfSpreadBps != null && raw.askHalfSpreadBps != null) facts.push(["Bid / ask from TWAP", `${raw.bidHalfSpreadBps} / ${raw.askHalfSpreadBps} bps`]);
  if (raw.postedSpreadBps != null) facts.push(["Spread posted", `${raw.postedSpreadBps} bps${raw.spreadBps != null && raw.spreadBps !== raw.postedSpreadBps ? ` (model asked ${raw.spreadBps})` : ""}`]);
  if (raw.skewBps != null) facts.push(["Lean", `${raw.skewBps > 0 ? "+" : ""}${raw.skewBps} bps`]);
  if (raw.maxAmountInUsdc != null) facts.push(["Size cap", `${fmtUsdc(raw.maxAmountInUsdc)} USDC per fill`]);
  if (raw.ttlSeconds != null) facts.push(["Lifetime", `${raw.ttlSeconds} s`]);
  if (withModel && raw.model) facts.push(["Model", raw.model]);
  facts.push(["TEE verdict", raw.teeVerified === true ? "verified" : raw.teeVerified === false ? "not verified" : "none returned, bound as null"]);
  if (raw.provider) facts.push(["Provider", shortHash(raw.provider)]);
  if (raw.inferenceId) facts.push(["inferenceId", <CopyLink key="i" value={raw.inferenceId} label="inferenceId" />]);
  return (
    <dl className={cn("grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px]", className)}>
      {facts.map(([k, v]) => <div key={k} className="flex items-center justify-between gap-3 border-b border-rule pb-1"><dt className="text-muted">{k}</dt><dd className="num text-right text-ink-2">{v}</dd></div>)}
    </dl>
  );
}
