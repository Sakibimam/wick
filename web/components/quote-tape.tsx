"use client";

import { useRef } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TierChip } from "@/components/tier-meter";
import { usePostedAt } from "@/hooks/use-posted-at";
import { clock, freshness, offMidPct, secondsLeft, spreadPct, URGENT_SECONDS, type Direction, type Priced } from "@/lib/quotes";
import { formatPrice } from "@/lib/format";
import { relativeTime } from "@/lib/format";
import { AgentError } from "@/lib/agent-api";
import { reasonText, TIERS } from "@/lib/tiers";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

type Props = {
  status: AgentStatus | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  updatedAt: number;
  priced: Record<Direction, Priced | null>;
  direction: Direction;
  onSelect: (d: Direction) => void;
  now: number;
  nowReady: boolean;
};

const SIDE = {
  "sell-w0g": { verb: "If you sell 1 W0G", gets: "you receive" },
  "buy-w0g": { verb: "If you buy 1 W0G", gets: "you pay" },
} as const;

const TONE = { fresh: { bar: "bg-ok", text: "text-ok", word: "Fresh" }, closing: { bar: "bg-warn", text: "text-warn", word: "Closing" }, expired: { bar: "bg-danger", text: "text-danger", word: "Expired" } } as const;

export function QuoteTape(props: Props) {
  const { status, loading, error, onRetry } = props;
  return (
    <section aria-label="Agent price tape" className="on-graphite border-y border-graphite-rule bg-graphite text-on-graphite">
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 md:py-8">
        {loading ? <TapeSkeleton /> : error ? <TapeError error={error} onRetry={onRetry} /> : status ? <TapeLive {...props} status={status} /> : null}
      </div>
    </section>
  );
}

function TapeSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading the agent's prices" className="grid grid-cols-1 gap-8 md:grid-cols-2">
      {[0, 1].map((i) => (
        <div key={i} className="space-y-3">
          <div className="skeleton h-4 w-40" />
          <div className="skeleton h-14 w-64" />
          <div className="skeleton h-1 w-full" />
          <div className="skeleton h-7 w-28" />
        </div>
      ))}
    </div>
  );
}

function TapeError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const unreachable = error instanceof AgentError && error.kind === "unreachable";
  return (
    <div role="alert" className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div>
        <p className="font-display text-[20px] font-medium text-on-graphite">{unreachable ? "The agent is not answering." : "The agent answered with something this page cannot read."}</p>
        <p className="mt-1 max-w-[60ch] text-[14px] text-on-graphite-muted">
          {unreachable
            ? "Without its status there is no price to trade against. Check that the agent is running and that its WEB_ORIGIN setting allows this site, then retry."
            : error.message}
        </p>
        <p className="num mt-2 text-[12px] text-on-graphite-muted">{error.message}</p>
      </div>
      <Button variant="inverse" onClick={onRetry} className="shrink-0"><RefreshCw className="size-4" aria-hidden />Try again</Button>
    </div>
  );
}

function TapeLive({ status, priced, direction, onSelect, now, nowReady, updatedAt }: Props & { status: AgentStatus }) {
  const sell = priced["sell-w0g"];
  const buy = priced["buy-w0g"];
  const spread = spreadPct(sell, buy);
  const nothing = !sell && !buy;
  return (
    <>
      {nothing ? <EmptyAgent status={status} /> : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2 md:gap-x-0">
          <Side d="sell-w0g" p={sell} status={status} active={direction === "sell-w0g"} onSelect={onSelect} now={now} nowReady={nowReady} className="md:pr-8" />
          <Side d="buy-w0g" p={buy} status={status} active={direction === "buy-w0g"} onSelect={onSelect} now={now} nowReady={nowReady} className="md:border-l md:border-graphite-rule md:pl-8" />
        </div>
      )}
      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-4 border-t border-graphite-rule pt-4 md:grid-cols-4">
        <Cell label="Pool mid" value={status.mid === null ? "not read yet" : `${formatPrice(status.mid)} USDC per W0G`} />
        <Cell label="Gap between the two prices" value={spread === null ? "needs both prices" : `${spread.toFixed(2)}%`} />
        <div>
          <dt className="label">Budget tier</dt>
          <dd className="mt-1"><TierChip tier={status.budget.tier} tone="graphite" /></dd>
        </div>
        <Cell label="Agent status read" value={updatedAt ? relativeTime(updatedAt, nowReady ? now * 1000 : updatedAt) : "just now"} />
      </dl>
    </>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="label">{label}</dt>
      <dd className="num mt-1 break-words text-[14px] text-on-graphite">{value}</dd>
    </div>
  );
}

function EmptyAgent({ status }: { status: AgentStatus }) {
  const steps = [
    "Takers' fees are swapped to 0G on Uniswap.",
    "The 0G crosses to the 0G chain over the CCIP bridge.",
    "It is deposited into the 0G Payment Layer, the account that pays for AI runs.",
    "The agent asks its AI for a price and signs it. This tape fills in then.",
  ];
  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[1.1fr_1fr] md:items-start">
      <div>
        <h2 className="font-display text-[28px] font-medium leading-tight text-on-graphite">The agent has not signed a price yet.</h2>
        <p className="mt-2 max-w-[52ch] text-[14px] text-on-graphite-muted">{reasonText(status.budget.reason)} Until it signs, the pool refuses every swap, so there is nothing to trade against.</p>
      </div>
      <ol className="space-y-2 text-[14px] text-on-graphite">
        {steps.map((s, i) => (
          <li key={s} className="flex gap-3"><span className="num mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border border-graphite-rule text-[11px]">{i + 1}</span>{s}</li>
        ))}
      </ol>
    </div>
  );
}

function Side({ d, p, status, active, onSelect, now, nowReady, className }: { d: Direction; p: Priced | null; status: AgentStatus; active: boolean; onSelect: (d: Direction) => void; now: number; nowReady: boolean; className?: string }) {
  const postedAt = usePostedAt(p?.quote.postedTx);
  const seenMax = useRef<{ key: string; max: number }>({ key: "", max: 0 });
  const meta = SIDE[d];
  if (!p) {
    return (
      <div className={cn("rounded-control px-0 md:px-0", className)}>
        <p className="label">{meta.verb}, {meta.gets}</p>
        <p className="mt-3 font-display text-[28px] font-medium text-on-graphite-muted">No signed price for this direction</p>
      </div>
    );
  }
  const state = nowReady ? freshness(p.expiry, now) : "fresh";
  const left = nowReady ? secondsLeft(p.expiry, now) : 0;
  const key = p.quote.inferenceId;
  if (seenMax.current.key !== key) seenMax.current = { key, max: 0 };
  seenMax.current.max = Math.max(seenMax.current.max, left);
  const total = postedAt && p.expiry > postedAt ? p.expiry - postedAt : seenMax.current.max;
  const frac = state === "expired" || total <= 0 ? 0 : Math.min(1, left / total);
  const tone = TONE[state];
  const off = offMidPct(p.priceUsdcPerW0g, status.mid);
  const urgent = state !== "expired" && left <= URGENT_SECONDS;
  return (
    <button
      type="button"
      onClick={() => onSelect(d)}
      aria-pressed={active}
      className={cn("block w-full rounded-control border-t-2 pt-4 text-left transition-colors duration-150 md:border-t-0 md:pt-0", active ? "border-on-graphite" : "border-transparent hover:border-graphite-rule", className)}
    >
      <span className="label block">{meta.verb}, {meta.gets}</span>
      <span className="mt-2 flex flex-wrap items-baseline gap-x-3">
        <span className={cn("readout text-[40px] leading-none md:text-[56px]", state === "expired" && "text-on-graphite-muted line-through decoration-danger decoration-2")}>{formatPrice(p.priceUsdcPerW0g)}</span>
        <span className="num text-[16px] text-on-graphite-muted md:text-[20px]">USDC</span>
      </span>
      <span className="mt-4 flex items-center gap-4">
        <span className="block h-1 flex-1 overflow-hidden rounded-sm bg-graphite-2" role="progressbar" aria-label="Time left on this price" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(frac * 100)}>
          <span className={cn("fuse-fill block h-full w-full rounded-sm", tone.bar)} style={{ transform: `scaleX(${frac})` }} />
        </span>
        <span className={cn("num text-[28px] leading-none", tone.text, urgent && "motion-safe:animate-pulse")}>{state === "expired" ? "Expired" : clock(left)}</span>
      </span>
      <span className="mt-2 block text-[13px] text-on-graphite-muted">
        {state === "expired"
          ? status.budget.tier === "PAUSED" || status.budget.tier === "CRITICAL"
            ? `The pool refuses fills at this price. The agent is ${TIERS[status.budget.tier].label.toLowerCase()} and signs no new price until its AI account is funded.`
            : "The pool refuses fills at this price. Waiting for the agent to sign a new one."
          : state === "closing"
            ? "Closing soon. A swap that lands after this fails and costs only gas."
            : "Fresh. The pool fills at this price until the clock runs out."}
      </span>
      {off !== null && Math.abs(off) > 5 ? (
        <span className="num mt-2 block text-[12px] text-warn">{off > 0 ? "+" : ""}{off.toFixed(1)}% away from the pool mid. Compare before you swap.</span>
      ) : null}
    </button>
  );
}
