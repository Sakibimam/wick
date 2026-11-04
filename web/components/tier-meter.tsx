import { TIERS, TIER_ORDER, reasonText } from "@/lib/tiers";
import type { Tier } from "@/lib/schema";
import { cn } from "@/lib/utils";

const TONE_ON_GRAPHITE = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", quiet: "bg-on-graphite-muted" } as const;
const TONE_ON_PAPER = { ok: "bg-ok-ink", warn: "bg-warn-ink", danger: "bg-danger-ink", quiet: "bg-muted" } as const;

export function TierChip({ tier, tone = "paper", className }: { tier: Tier; tone?: "paper" | "graphite"; className?: string }) {
  const meta = TIERS[tier];
  const dot = (tone === "graphite" ? TONE_ON_GRAPHITE : TONE_ON_PAPER)[meta.tone];
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-control border px-2 py-0.5 text-[13px] font-medium", tone === "graphite" ? "border-graphite-rule text-on-graphite" : "border-rule-2 text-ink", className)}>
      <span className={cn("size-2 rounded-full", dot)} aria-hidden />
      {meta.label}
    </span>
  );
}

/** Four notches in order of worsening health, the current one lit. */
export function TierMeter({ tier, reason, tone = "paper" }: { tier: Tier; reason: string; tone?: "paper" | "graphite" }) {
  const meta = TIERS[tier];
  const lit = (tone === "graphite" ? TONE_ON_GRAPHITE : TONE_ON_PAPER)[meta.tone];
  const off = tone === "graphite" ? "bg-graphite-2" : "bg-rule";
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <TierChip tier={tier} tone={tone} />
        <ol className="flex flex-1 items-center gap-1.5" aria-label="Budget tiers from Normal to Paused">
          {TIER_ORDER.map((t) => (
            <li key={t} className="flex-1" aria-current={t === tier ? "step" : undefined}>
              <span className={cn("block h-1.5 rounded-sm", t === tier ? lit : off)} />
              <span className={cn("mt-1 block text-[11px] leading-4", t === tier ? (tone === "graphite" ? "text-on-graphite" : "text-ink") : tone === "graphite" ? "text-on-graphite-muted" : "text-muted")}>{TIERS[t].label}</span>
            </li>
          ))}
        </ol>
      </div>
      <p className={cn("mt-3 text-[14px]", tone === "graphite" ? "text-on-graphite" : "text-ink-2")}>{meta.consequence}</p>
      <p className={cn("mt-1 text-[13px]", tone === "graphite" ? "text-on-graphite-muted" : "text-muted")}>{reasonText(reason)}</p>
    </div>
  );
}
