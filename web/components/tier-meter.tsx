import { TIERS, TIER_ORDER, reasonText } from "@/lib/tiers";
import type { Tier } from "@/lib/schema";
import { cn } from "@/lib/utils";

export function TierChip({ tier, className }: { tier: Tier; className?: string }) {
  const meta = TIERS[tier];
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-control bg-sunken px-2 py-0.5 text-[13px] font-medium text-ink", `tone-${meta.tone}`, className)}>
      <span className="size-2 rounded-full bg-[var(--tone)]" aria-hidden />
      {meta.label}
    </span>
  );
}

/** Four notches in order of worsening health, the current one lit in its own colour. */
export function TierMeter({ tier, reason }: { tier: Tier; reason: string }) {
  const meta = TIERS[tier];
  return (
    <div className={`tone-${meta.tone}`}>
      <ol className="flex items-end gap-1.5" aria-label="Budget tiers from Normal to Paused">
        {TIER_ORDER.map((t) => (
          <li key={t} className="flex-1" aria-current={t === tier ? "step" : undefined}>
            <span className={cn("block text-[13px] leading-5", t === tier ? "font-semibold text-ink" : "text-muted")}>{TIERS[t].label}</span>
            <span className={cn("mt-1 block h-1.5 rounded-[2px]", t === tier ? "bg-[var(--tone)]" : "bg-sunken")} />
          </li>
        ))}
      </ol>
      <p className="mt-3 text-[14px] text-ink-2">{meta.consequence}</p>
      <p className="mt-1 text-[13px] text-muted">{reasonText(reason)}</p>
    </div>
  );
}
