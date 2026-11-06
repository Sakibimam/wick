"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { CopyLink } from "@/components/copy-link";
import { Countdown } from "@/components/countdown";
import { CountBadge, MarkTips } from "@/components/mark-tips";
import { SourceNote } from "@/components/source-note";
import { Amount, ProtocolIcon, TokenIcon, Tk, WickMark } from "@/components/token-mark";
import { AgentError } from "@/lib/agent-api";
import { cluster } from "@/lib/cluster";
import { BASE_CHAIN_ID, EXPLORERS, QUOTES_API, V4_HOOK, ZERO_G_CHAIN_ID, type Protocol } from "@/lib/config";
import { useQuoteStats } from "@/hooks/use-quote-stats";
import { decisionCostUsd, decisionsFor, economicsOf, fillsToCover, fmtDecisions, presetUsdcUnits, runCost, runsOf, takersOf, type Economics, type Run } from "@/lib/economics";
import { clock, countdown, duration, fmt0g, fmtPct, fmtPrice, fmtUsd, fmtUsdc, relativeTime, significant, toNumber, utcStamp } from "@/lib/format";
import { toMillis, txUrl } from "@/lib/funding";
import type { Fill } from "@/lib/ledger";
import { FUEL_LINES, fuseLeft, gaugePosition, hopEvidence, HOPS, machineSentence, MODELS, nextTickIn, priceLeg, TIER_TONE, tierForBalance, tierWord, type HopKey, type Tone } from "@/lib/machine";
import { CLOSING_SECONDS, latestByDirection, URGENT_SECONDS, type Priced } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

type NodeKey = "pool" | "fees" | HopKey | "vault" | "brain" | "price";
const ORDER: NodeKey[] = ["pool", "fees", "swap", "bridge", "withdraw", "deposit", "vault", "brain", "price"];
type Pt = { x: number; y: number };
/** lit: money has moved along this leg. armed: the leg is live and waiting on its threshold. */
type EdgeState = "lit" | "armed" | "dim" | "open" | "fuse";
type Seg = { from: NodeKey; to: NodeKey; points: Pt[]; state: EdgeState };
/** Which chain each station lives on. Lit track and nodes take their chain's hue; green is kept for liveness. */
const CHAIN: Record<NodeKey, "base" | "zg"> = { pool: "base", fees: "base", swap: "base", bridge: "base", withdraw: "zg", deposit: "zg", vault: "zg", brain: "zg", price: "base" };
const CHAIN_CLASS = { base: "chain-base", zg: "chain-zg" } as const;

const HEARTBEAT_WINDOW_MS = 48 * 3600_000;
const TONE_CLASS: Record<Tone, string> = { ok: "tone-ok", warn: "tone-warn", danger: "tone-danger", quiet: "tone-quiet" };

export type MachineProps = {
  status: AgentStatus | undefined;
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
  fills: Fill[] | null;
  fillsError: boolean;
  now: number;
  nowReady: boolean;
};

/** The hero: the agent's money loop drawn as a circuit across the Base and 0G lanes, every station fed by live reads. */
export function Machine(props: MachineProps) {
  const { status, loading, error, onRetry, fills, fillsError, now, nowReady } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const { pts, measure } = useNodePoints(rootRef);
  const reduce = useReducedMotion() ?? false;
  const nowMs = now * 1000;

  const view = useMemo(() => (status ? buildView(status, fills, now) : null), [status, fills, now]);
  const econ = useMemo(() => (status ? economicsOf(status) : null), [status]);
  useEffect(() => { measure(); }, [measure, view?.key]);

  const tone: Tone = status ? TIER_TONE[status.budget.tier] : "quiet";
  const segs = useMemo(() => (pts && view ? segments(pts, view) : []), [pts, view]);

  return (
    <section aria-labelledby="machine-title" className={cn("relative isolate overflow-hidden", TONE_CLASS[tone])}>
      <div className="mx-auto max-w-[1312px] px-4 sm:px-6 lg:px-12">
        <div
          ref={rootRef}
          className="relative flex flex-col gap-9 pb-12 pt-8 lg:grid lg:min-h-[min(calc(100dvh-100px),880px)] lg:grid-cols-4 lg:grid-rows-[auto_minmax(0,1fr)_auto_auto] lg:gap-x-8 lg:gap-y-0 lg:pb-10 lg:pt-6 lg:[grid-template-areas:'pool_fees_swap_bridge'_'price_infield_infield_infield'_'price_._._withdraw'_'brain_vault_vault_deposit']"
        >
          {segs.length > 0 ? <Circuit segs={segs} reduce={reduce} view={view!} now={now} ttl={status?.quoteTtlSeconds ?? 3600} /> : null}

          <CompactLoop status={status} view={view} now={now} nowReady={nowReady} />
          <Infield status={status} econ={econ} fills={fills} loading={loading} error={error} onRetry={onRetry} view={view} now={now} nowReady={nowReady} />

          {view && status && econ ? (
            <>
              <PoolStation status={status} fills={fills} fillsError={fillsError} nowMs={nowMs} />
              <FeesStation status={status} econ={econ} />
              {HOPS.map((h) => <HopStation key={h.key} hop={h} evidence={view.hops[h.key]} status={status} nowMs={nowMs} />)}
              <VaultStation status={status} econ={econ} />
              <BrainStation status={status} nowMs={nowMs} />
              <PriceStation status={status} view={view} now={now} nowReady={nowReady} />
            </>
          ) : loading ? (
            ORDER.map((k) => <StationSkeleton key={k} k={k} />)
          ) : null}
        </div>
      </div>
    </section>
  );
}

type View = ReturnType<typeof buildView>;

function buildView(status: AgentStatus, fills: Fill[] | null, now: number) {
  const leg = priceLeg(status, now);
  const hops = hopEvidence(status.funding);
  const beats = status.inferences.length;
  const fillCount = fills?.length ?? 0;
  const feesAccrued = status.fees.accruedUsdc !== "0" || status.fees.accruedW0g !== "0";
  const aiBehindPrice = status.quotes.some((q) => q.requestId && q.requestId !== "price-only");
  const lit: Record<NodeKey, boolean> = {
    pool: fillCount > 0,
    fees: feesAccrued || fillCount > 0,
    // The agent prices every quote off this pool's mid, so the station is live whenever the mid reads.
    swap: Boolean(hops.swap) || status.mid !== null,
    bridge: Boolean(hops.bridge),
    withdraw: Boolean(hops.withdraw),
    deposit: Boolean(hops.deposit),
    vault: BigInt(status.budget.computeBalanceWei) > 0n,
    brain: beats > 0,
    price: !leg.open,
  };
  const edgeOf = (k: NodeKey): EdgeState => {
    switch (k) {
      case "pool": return fillCount > 0 ? "lit" : "dim";
      case "fees": return hops.swap ? "lit" : feesAccrued ? "armed" : "dim";
      case "swap": return lit.bridge ? "lit" : "dim";
      case "bridge": return lit.withdraw ? "lit" : "dim";
      case "withdraw": return lit.deposit ? "lit" : "dim";
      case "deposit": return lit.vault ? "lit" : "dim";
      case "vault": return lit.brain ? "lit" : "dim";
      case "brain": return aiBehindPrice ? "lit" : "dim";
      case "price": return leg.open ? "open" : "fuse";
    }
  };
  const edge = Object.fromEntries(ORDER.map((k) => [k, edgeOf(k)])) as Record<NodeKey, EdgeState>;
  const lastRun = [...status.inferences].sort((a, b) => (toMillis(b.time) ?? 0) - (toMillis(a.time) ?? 0))[0]?.requestId ?? null;
  const key = `${fillCount}|${beats}|${status.funding.length}|${leg.open}|${status.budget.tier}`;
  return { leg, hops, lit, edge, key, fillCount, aiBehindPrice, lastRun };
}

function segments(pts: Partial<Record<NodeKey, Pt>>, view: View): Seg[] {
  const out: Seg[] = [];
  ORDER.forEach((from, i) => {
    const to = ORDER[(i + 1) % ORDER.length]!;
    const a = pts[from];
    const b = pts[to];
    if (!a || !b) return;
    const closing = from === "price";
    const points = closing && Math.abs(a.x - b.x) > 2 ? [a, { x: Math.min(a.x, b.x) - 14, y: a.y }, { x: Math.min(a.x, b.x) - 14, y: b.y }, b] : [a, b];
    out.push({ from, to, points, state: view.edge[from] });
  });
  return out;
}

function useNodePoints(ref: React.RefObject<HTMLDivElement | null>) {
  const [pts, setPts] = useState<Partial<Record<NodeKey, Pt>> | null>(null);
  const measure = useCallback(() => {
    const root = ref.current;
    if (!root) return;
    const r = root.getBoundingClientRect();
    const next: Partial<Record<NodeKey, Pt>> = {};
    root.querySelectorAll<HTMLElement>("[data-node]").forEach((el) => {
      const b = el.getBoundingClientRect();
      if (b.width === 0) return;
      next[el.dataset.node as NodeKey] = { x: Math.round(b.left + b.width / 2 - r.left), y: Math.round(b.top + b.height / 2 - r.top) };
    });
    setPts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [ref]);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    for (const child of Array.from(root.children)) ro.observe(child);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [ref, measure]);
  return { pts, measure };
}

const pathOf = (p: Pt[]) => p.map((q, i) => `${i ? "L" : "M"}${q.x} ${q.y}`).join(" ");

function Circuit({ segs, reduce, view, now, ttl }: { segs: Seg[]; reduce: boolean; view: View; now: number; ttl: number }) {
  const fuse = view.leg.soonest;
  const fusePath = segs.find((s) => s.state === "fuse");
  const left = fuse ? fuseLeft(fuse.expiry, now, ttl) : 0;
  const route = (from: NodeKey, to: NodeKey) => {
    const start = segs.findIndex((s) => s.from === from);
    const out: Pt[] = [];
    for (let i = start; i >= 0 && i < segs.length; i++) {
      out.push(...(out.length ? segs[i]!.points.slice(1) : segs[i]!.points));
      if (segs[i]!.to === to) break;
    }
    return out;
  };
  const stroke = (s: Seg) => cn((s.state === "lit" || s.state === "armed") && cn("stroke-[var(--chain)]", CHAIN_CLASS[CHAIN[s.to]]), s.state === "dim" && "stroke-rule-2", s.state === "open" && "stroke-danger", s.state === "fuse" && "stroke-rule");
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {segs.map((s) => {
        const common = { d: pathOf(s.points), fill: "none", strokeWidth: s.state === "lit" || s.state === "fuse" ? 2.5 : 2, strokeDasharray: s.state === "open" ? "6 7" : s.state === "armed" ? "3 7" : undefined, strokeLinecap: s.state === "armed" ? ("round" as const) : undefined, className: stroke(s) };
        return <path key={s.from} {...common} />;
      })}
      {segs.filter((s) => s.state !== "fuse").map((s) => <Chevron key={`c-${s.from}`} seg={s} className={stroke(s)} />)}
      {fusePath ? (
        <path
          d={pathOf(fusePath.points)}
          fill="none"
          strokeWidth={2.5}
          pathLength={1}
          strokeDasharray={`${left} 1`}
          className={cn(left * ttl <= URGENT_SECONDS ? "stroke-danger" : left * ttl <= CLOSING_SECONDS ? "stroke-warn" : "stroke-ok")}
        />
      ) : null}
      {!reduce && view.fillCount > 0 ? <Pulses route={route("pool", "fees")} count={Math.min(view.fillCount, 5)} delay={1.2} /> : null}
      {!reduce && view.lit.deposit ? <Pulses route={route("swap", "vault")} count={1} delay={1.6} dwell /> : null}
      {!reduce && view.lit.brain && view.aiBehindPrice && !view.leg.open ? <Pulses key={view.lastRun ?? "none"} route={route("brain", "pool")} count={1} delay={2.6} /> : null}
    </svg>
  );
}

/** A small arrowhead at the middle of the longest leg of a segment, pointing the way money travels. */
function Chevron({ seg, className }: { seg: Seg; className: string }) {
  let best = 0, at = 0;
  for (let i = 1; i < seg.points.length; i++) { const l = Math.hypot(seg.points[i]!.x - seg.points[i - 1]!.x, seg.points[i]!.y - seg.points[i - 1]!.y); if (l > best) { best = l; at = i; } }
  if (best < 60) return null;
  const a = seg.points[at - 1]!, b = seg.points[at]!;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const deg = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
  return <path d="M-5 -6 L3 0 L-5 6" fill="none" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" className={className} transform={`translate(${mx} ${my}) rotate(${deg})`} />;
}

/** Real events replayed once: one dot per fill entering at the pool, the recorded funding run riding the hops. */
function Pulses({ route, count, delay, dwell }: { route: Pt[]; count: number; delay: number; dwell?: boolean }) {
  if (route.length < 2) return null;
  const lengths = route.slice(1).map((p, i) => Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const xs = route.map((p) => p.x);
  const ys = route.map((p) => p.y);
  let acc = 0;
  const times = [0, ...lengths.map((l) => (acc += l) / total)];
  const dur = Math.max(1.2, total / (dwell ? 160 : 260));
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <motion.circle
          key={i}
          r={4.5}
          className="fill-ink"
          initial={{ cx: xs[0], cy: ys[0], opacity: 0 }}
          animate={{ cx: xs, cy: ys, opacity: [0, ...Array(xs.length - 2).fill(1), 0] }}
          transition={{ delay: delay + i * 0.35, duration: dur, times, ease: "linear" }}
        />
      ))}
    </>
  );
}

function Infield({ status, econ, fills, loading, error, onRetry, view, now, nowReady }: { status: AgentStatus | undefined; econ: Economics | null; fills: Fill[] | null; loading: boolean; error: Error | null; onRetry: () => void; view: View | null; now: number; nowReady: boolean }) {
  const tone = status ? TIER_TONE[status.budget.tier] : "quiet";
  return (
    <div className="relative z-10 flex flex-col justify-center lg:py-5 lg:pl-10 lg:pr-12 lg:[grid-area:infield]">
      <div className="grid grid-cols-1 gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,300px)] xl:gap-12">
        <div>
          <h1 id="machine-title" className="max-w-[18ch] text-[40px] sm:text-[48px]">Wick pays for its own brain</h1>
          <p className="mt-3 max-w-[50ch] text-[17px] leading-[1.5] text-ink-2">
            A market maker on Base. Every swap pays a fee, the fee crosses to the <Tk>0G</Tk> chain, and it buys the AI run that signs the next price.
          </p>
          <div className="mt-6">
            {status && econ ? <LeadFigure status={status} econ={econ} fills={fills} /> : loading ? (
              <div aria-hidden className="space-y-3"><div className="skeleton h-[88px] w-[5ch] text-[96px]" /><div className="skeleton h-5 w-72 max-w-full" /></div>
            ) : null}
          </div>
          <div className={cn("mt-5", view?.leg.open && status ? "hidden" : "min-h-[24px]")} aria-live="polite">
            {error && !status ? (
              <div role="alert" className="flex flex-wrap items-center gap-3">
                <p className="text-[16px] text-danger-ink">{error instanceof AgentError && error.kind === "unreachable" ? "The agent's status route is not answering, so the machine cannot be read right now." : `The status could not be read: ${error.message}`}</p>
                <Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw className="size-4" aria-hidden />Read again</Button>
              </div>
            ) : status && view && nowReady && !view.leg.open ? (
              <p className="flex max-w-[60ch] items-start gap-3 text-[16px] leading-[1.5] text-ink">
                <span aria-hidden className={cn("mt-[7px] size-2.5 shrink-0 rounded-full bg-[var(--tone)]", view.leg.open ? "tone-danger" : TONE_CLASS[tone], tone !== "quiet" && !view.leg.open && "motion-safe:animate-pulse")} />
                <span><span className="font-semibold">{view.leg.open ? "Price expired" : tierWord(status.budget.tier)}.</span> {machineSentence(status, view.leg, now).replace(/^[^.]+\.\s*/, "")}</span>
              </p>
            ) : !status ? <span aria-hidden className="skeleton block h-5 w-[42ch] max-w-full" /> : null}
          </div>
          <div className="mt-6 flex flex-wrap gap-3">
            {view?.leg.open ? (
              <>
                <Button asChild className="w-full sm:w-auto"><Link href="/ledger">Read the ledger</Link></Button>
                <Button asChild variant="secondary" className="w-full sm:w-auto"><a href="#swap">What one swap pays for <ArrowDown className="size-4" aria-hidden /></a></Button>
              </>
            ) : (
              <>
                <Button asChild className="w-full sm:w-auto"><a href="#swap">Swap the signed price <ArrowDown className="size-4" aria-hidden /></a></Button>
                <Button asChild variant="secondary" className="w-full sm:w-auto"><Link href="/ledger">Read the ledger</Link></Button>
              </>
            )}
          </div>
        </div>
        <PriceClock status={status} view={view} now={now} nowReady={nowReady} loading={loading} />
      </div>
    </div>
  );
}

/** The one number that proves the loop, then the fuel that keeps it running. */
function LeadFigure({ status, econ, fills }: { status: AgentStatus; econ: Economics; fills: Fill[] | null }) {
  const fuel = toNumber(status.budget.computeBalanceWei, "0G");
  const takers = fills ? takersOf(status, fills) : null;
  // Coverage only proves the loop once outside wallets pay the fees; until then the figure is what one swap buys.
  const presetUsdc = toNumber(presetUsdcUnits(status, latestByDirection(status.quotes)["buy-w0g"]), "USDC");
  const swapFee = status.strategy ? (presetUsdc * status.strategy.feeBps) / 10_000 : null;
  const perSwap = swapFee !== null ? decisionsFor(swapFee, status) : null;
  const perUsdc = status.strategy ? decisionsFor(status.strategy.feeBps / 10_000, status) : null;
  const decisionUsd = decisionCostUsd(status);
  const lead = econ.coverage !== null && takers && takers.outside > 0
    ? { value: fmtPct(econ.coverage * 100), label: <>of the agent&apos;s AI bill is covered by the fees it has earned</>, detail: <>{fmtUsd(econ.feesEarnedUsdc)} earned against {fmtUsd(econ.aiSpentUsd)} spent on {status.inferences.length} AI runs</> }
    : perUsdc !== null && perSwap !== null
      ? { value: fmtDecisions(perUsdc), label: <>AI decisions paid for by every 1 USDC traded</>, detail: <>one {fmtUsdc(presetUsdc)} USDC swap pays for {fmtDecisions(perSwap)}; one AI decision costs {fmtUsd(decisionUsd!)}</> }
      : { value: fmt0g(fuel), label: <><Tk>0G</Tk> of fuel for AI runs</>, detail: null };
  return (
    <div>
      <p className="flex items-end gap-4">
        <span className="num font-display text-[72px] font-semibold leading-[0.85] text-ink sm:text-[96px]">{lead.value}</span>
      </p>
      <p className="mt-3 max-w-[44ch] text-[17px] text-ink">{lead.label}</p>
      {lead.detail ? <p className="num mt-1 text-[14px] text-muted">{lead.detail}</p> : null}
      <dl className="mt-5 grid grid-cols-3 gap-x-4 gap-y-3 border-t border-rule pt-4 sm:flex sm:flex-wrap sm:gap-x-8">
        <div>
          <dt className="label">AI fuel</dt>
          <dd className="mt-0.5 text-[20px] text-ink"><Amount value={fmt0g(fuel)} symbol="0G" size={16} /></dd>
        </div>
        {econ.runwayDays !== null ? (
          <div>
            <dt className="label">Runway</dt>
            <dd className="num mt-0.5 text-[20px] text-ink">{significant(econ.runwayDays, 2)} days</dd>
            <dd className="text-[12px] text-muted">{econ.reported.has("runwayDays") ? "at today's pace" : "at the daily cap"}</dd>
          </div>
        ) : null}
        {econ.runsPaidByFees !== null && econ.coverage !== null && takers && takers.outside > 0 ? (
          <div>
            <dt className="label">AI runs the fees pay for</dt>
            <dd className="num mt-0.5 text-[20px] text-ink">{significant(econ.runsPaidByFees, 2)}</dd>
          </div>
        ) : null}
        <div>
          <dt className="label">AI decisions so far</dt>
          <dd className="num mt-0.5 text-[20px] text-ink">{status.inferences.length}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Both signed prices as the hero's live clock: ask in red, bid in green, each over the time it has left. */
function PriceClock({ status, view, now, nowReady, loading }: { status: AgentStatus | undefined; view: View | null; now: number; nowReady: boolean; loading: boolean }) {
  if (!status || !view) {
    return loading ? <div aria-hidden className="space-y-4 rounded-card bg-panel p-5"><div className="skeleton h-4 w-28" /><div className="skeleton h-10 w-40" /><div className="skeleton h-10 w-40" /></div> : null;
  }
  const ttl = status.quoteTtlSeconds ?? 3600;
  const rows: { key: string; label: string; who: string; p: Priced | null; cls: string }[] = [
    { key: "ask", label: "Ask", who: "you buy W0G", p: view.leg.buy, cls: "ask" },
    { key: "bid", label: "Bid", who: "you sell W0G", p: view.leg.sell, cls: "bid" },
  ];
  const open = view.leg.open;
  const newest = [view.leg.buy, view.leg.sell].filter((p): p is Priced => p !== null).sort((x, y) => y.expiry - x.expiry)[0];
  return (
    <section aria-label="Signed prices" className="hidden self-center rounded-card bg-panel p-5 lg:block">
      <p className="flex items-center justify-between gap-3 text-[13px] text-muted">
        <span className="inline-flex items-center gap-1.5"><TokenIcon symbol="W0G" size={16} /><Tk>W0G</Tk> in USDC, signed by AI</span>
        <SourceNote>getQuote on the AgentQuoteBoard and the QuotePosted events, read through the Worker status route.</SourceNote>
      </p>
      {open && newest ? (
        <p className="num mt-3 rounded-control bg-sunken px-3 py-2 text-[13px] text-ink-2">{nowReady ? `Requoting. These are the last prices it signed; the next tick runs in ${clock(nextTickIn(now))}.` : "Reading the chain clock"}</p>
      ) : null}
      <div className="mt-4 space-y-5">
        {rows.map((r) => (
          <div key={r.key} className={open ? undefined : r.cls}>
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-[13px] text-ink-2"><span className={cn("font-semibold", open ? "text-ink-2" : "text-[var(--tone)]")}>{r.label}</span> <Tk>{r.who}</Tk></span>
              {r.p ? <span className={cn("num font-display text-[40px] font-semibold leading-none", open ? "text-muted" : "text-[var(--tone)]")}>{fmtPrice(r.p.priceUsdcPerW0g)}</span> : <span className="text-[13px] text-muted">no signed price</span>}
            </p>
            {r.p && !open ? <Countdown expiry={r.p.expiry} now={now} ttl={ttl} ready={nowReady} className="mt-2 w-full" /> : null}
          </div>
        ))}
      </div>
      {status.mid !== null ? (
        <p className="num mt-5 flex items-center gap-1.5 border-t border-rule pt-3 text-[13px] text-muted">
          <ProtocolIcon protocol="uniswap" size={14} />Uniswap mid {fmtPrice(status.mid)}
        </p>
      ) : null}
    </section>
  );
}

const SHORT: Record<NodeKey, string> = { pool: "Pool", fees: "Fees", swap: "Uniswap", bridge: "CCIP", withdraw: "Unwrap", deposit: "Deposit", vault: "Fuel", brain: "Brain", price: "Price" };

/** Under 1024px the circuit becomes a ring above the title: the same nine stations and edge states, the fuse as the closing arc. */
function CompactLoop({ status, view, now, nowReady }: { status: AgentStatus | undefined; view: View | null; now: number; nowReady: boolean }) {
  const W = 360, H = 316, cx = 180, cy = 158, R = 108;
  const n = ORDER.length;
  const at = (i: number, r = R) => { const a = ((-90 + (i * 360) / n) * Math.PI) / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), c: Math.cos(a) }; };
  const arc = (i: number) => { const a = at(i), b = at(i + 1); return `M${a.x.toFixed(1)} ${a.y.toFixed(1)} A${R} ${R} 0 0 1 ${b.x.toFixed(1)} ${b.y.toFixed(1)}`; };
  const ttl = status?.quoteTtlSeconds ?? 3600;
  const soon = view?.leg.soonest ?? null;
  const left = soon ? fuseLeft(soon.expiry, now, ttl) : 0;
  const secs = soon ? Math.floor(soon.expiry - now) : 0;
  const fuseCls = secs <= URGENT_SECONDS ? "stroke-danger" : secs <= CLOSING_SECONDS ? "stroke-warn" : "stroke-ok";
  return (
    <figure className="-mx-2 lg:hidden" aria-label="The money loop">
      <svg viewBox={`0 0 ${W} ${H}`} className="mx-auto h-auto w-full max-w-[300px] sm:max-w-[420px]" role="img" aria-label={view ? `Money loop, ${ORDER.filter((k) => view.edge[k] === "lit").length} of 8 legs proven on chain, price ${view.leg.open ? "expired" : "fresh"}` : "Reading the money loop"}>
        <circle cx={cx} cy={cy} r={R} fill="none" className="stroke-rule" strokeWidth={2} />
        {view ? ORDER.map((k, i) => {
          const st = view.edge[k];
          if (st === "fuse") return <g key={k}><path d={arc(i)} fill="none" className="stroke-rule" strokeWidth={3} /><path d={arc(i)} fill="none" pathLength={1} strokeDasharray={`${left} 1`} className={fuseCls} strokeWidth={3} /></g>;
          return <path key={k} d={arc(i)} fill="none" strokeWidth={st === "lit" ? 3 : 2} strokeLinecap={st === "armed" ? "round" : undefined} strokeDasharray={st === "open" ? "5 6" : st === "armed" ? "2 6" : undefined} className={cn((st === "lit" || st === "armed") && cn("stroke-[var(--chain)]", CHAIN_CLASS[CHAIN[ORDER[(i + 1) % n]!]]), st === "dim" && "stroke-rule-2", st === "open" && "stroke-danger")} />;
        }) : null}
        {ORDER.map((k, i) => {
          const p = at(i), l = at(i, R + 20);
          const lit = view?.lit[k] ?? false;
          return (
            <g key={k}>
              <circle cx={p.x} cy={p.y} r={6} strokeWidth={2} className={lit ? cn("fill-[var(--chain)] stroke-[var(--chain)]", CHAIN_CLASS[CHAIN[k]]) : "fill-paper stroke-rule-2"} />
              <text x={l.x} y={l.y + 4} textAnchor={l.c > 0.25 ? "start" : l.c < -0.25 ? "end" : "middle"} className="fill-muted font-display text-[13px] font-semibold uppercase tracking-[0.04em]">{SHORT[k]}</text>
            </g>
          );
        })}
        {status && view ? (
          <g textAnchor="middle">
            <text x={cx} y={cy - 14} className="fill-ink font-display text-[26px] font-semibold uppercase tracking-[0.02em]">{view.leg.open ? "Requoting" : tierWord(status.budget.tier)}</text>
            <text x={cx} y={cy + 12} className="num fill-ink-2 text-[15px]">{!nowReady ? "" : view.leg.open ? `next tick in ${clock(nextTickIn(now))}` : `price ${countdown(secs)}`}</text>
            <text x={cx} y={cy + 34} className="num fill-muted text-[13px]">{fmt0g(toNumber(status.budget.computeBalanceWei, "0G"))} 0G fuel</text>
          </g>
        ) : null}
      </svg>
      {status && view && (view.leg.buy || view.leg.sell) ? (
        <figcaption className="mt-2 flex items-center justify-center gap-5 text-[13px] text-ink-2">
          {view.leg.buy ? <span className={view.leg.open ? undefined : "ask"}><span className={cn("font-semibold", !view.leg.open && "text-[var(--tone)]")}>Ask</span> <span className="num text-[16px] text-ink">{fmtPrice(view.leg.buy.priceUsdcPerW0g)}</span></span> : null}
          {view.leg.sell ? <span className={view.leg.open ? undefined : "bid"}><span className={cn("font-semibold", !view.leg.open && "text-[var(--tone)]")}>Bid</span> <span className="num text-[16px] text-ink">{fmtPrice(view.leg.sell.priceUsdcPerW0g)}</span></span> : null}
          <a href="#swap" className="text-ink underline decoration-rule-2 underline-offset-4">Trade</a>
        </figcaption>
      ) : null}
    </figure>
  );
}

type NodeSpot = "top-l" | "top-r" | "side-l" | "side-r" | "bot-l" | "bot-r";
const SPOT: Record<NodeSpot, { wrap: string; node: string }> = {
  "top-l": { wrap: "lg:pl-0 lg:pb-8 lg:pr-2", node: "lg:left-[-7px] lg:top-auto lg:bottom-[-7px]" },
  "top-r": { wrap: "lg:pl-2 lg:pb-8 lg:text-right", node: "lg:left-auto lg:right-[-7px] lg:top-auto lg:bottom-[-7px]" },
  "side-l": { wrap: "lg:pl-8 lg:pr-2 lg:pt-8 lg:pb-2 lg:self-start", node: "lg:left-[-7px] lg:top-auto lg:bottom-[-7px]" },
  "side-r": { wrap: "lg:pr-8 lg:pl-2 lg:pb-8 lg:text-right lg:self-end", node: "lg:left-auto lg:right-[-7px] lg:top-[3px]" },
  "bot-l": { wrap: "lg:pl-0 lg:pt-8 lg:pr-2", node: "lg:left-[-7px] lg:top-[-7px]" },
  "bot-r": { wrap: "lg:pl-2 lg:pt-8 lg:text-right", node: "lg:left-auto lg:right-[-7px] lg:top-[-7px]" },
};
const AREA: Record<NodeKey, string> = {
  pool: "lg:[grid-area:pool]", fees: "lg:[grid-area:fees]", swap: "lg:[grid-area:swap]", bridge: "lg:[grid-area:bridge]",
  withdraw: "lg:[grid-area:withdraw]", deposit: "lg:[grid-area:deposit]", vault: "lg:[grid-area:vault]", brain: "lg:[grid-area:brain]", price: "lg:[grid-area:price]",
};
const SPOTS: Record<NodeKey, NodeSpot> = { pool: "top-l", fees: "top-l", swap: "top-l", bridge: "top-r", withdraw: "side-r", deposit: "bot-r", vault: "bot-l", brain: "bot-l", price: "side-l" };
const MARK: Partial<Record<NodeKey, Protocol>> = { pool: "aqua", swap: "uniswap", bridge: "ccip" };
const isRight = (k: NodeKey) => SPOTS[k].endsWith("-r");

function Station({ k, name, lit, children, className }: { k: NodeKey; name: string; lit: boolean; children: ReactNode; className?: string }) {
  const spot = SPOT[SPOTS[k]];
  const chainId = CHAIN[k] === "base" ? BASE_CHAIN_ID : ZERO_G_CHAIN_ID;
  const mark = MARK[k];
  return (
    <article aria-label={name} className={cn("relative min-w-0 pl-10", spot.wrap, AREA[k], className)}>
      <span data-node={k} aria-hidden className={cn("absolute left-[5px] top-[3px] size-3.5 rounded-full border-2", lit ? cn("border-[var(--chain)] bg-[var(--chain)]", CHAIN_CLASS[CHAIN[k]]) : "border-rule-2 bg-paper", spot.node)} />
      <h2 className={cn("station flex items-center gap-2", isRight(k) && "lg:justify-end")}>
        {mark ? <ProtocolIcon protocol={mark} size={16} /> : k === "fees" ? <TokenIcon symbol="USDC" size={16} /> : k === "price" ? <WickMark className="size-4" /> : <TokenIcon symbol="0G" size={16} />}
        <Tk>{name}</Tk>
        <span className="inline-flex items-center gap-1 text-[13px] font-medium normal-case tracking-normal text-muted lg:hidden">on <Tk>{chainId === BASE_CHAIN_ID ? "Base" : "0G"}</Tk></span>
      </h2>
      <div className="mt-2">{children}</div>
    </article>
  );
}

function Value({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("num text-[22px] font-medium leading-7 text-ink", className)}>{children}</p>;
}
function Note({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("mt-1 text-[16px] leading-[1.4] text-muted", className)}>{children}</p>;
}

function PoolStation({ status, fills, fillsError, nowMs }: { status: AgentStatus; fills: Fill[] | null; fillsError: boolean; nowMs: number }) {
  const latest = fills?.[0] ?? null;
  const fee = status.strategy ? (status.strategy.feeBps / 100).toFixed(2) : null;
  const takers = fills ? takersOf(status, fills) : null;
  return (
    <Station k="pool" name="Aqua pool" lit={(fills?.length ?? 0) > 0}>
      <Value>{fee ? `${fee}% fee per fill` : "Fills at the signed price"}</Value>
      <Note>Swaps fill only at the price the AI signed.</Note>
      <div className="mt-2 text-[13px] text-ink-2">
        {fillsError ? <span className="text-warn-ink">Fills unreadable right now</span> : fills === null ? <span aria-hidden className="skeleton inline-block h-4 w-44 align-middle" /> : fills.length === 0 ? <span>No fill yet</span> : (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <span className="num">{fills.length} {fills.length === 1 ? "fill" : "fills"}{takers && takers.outside === 0 ? ", a seed fill (agent)" : ""}, {latest?.timeMs ? relativeTime(latest.timeMs, nowMs) : `block ${latest?.blockNumber}`}</span>
            {latest ? <CopyLink value={latest.txHash} href={txUrl(BASE_CHAIN_ID, latest.txHash)} label="latest fill" /> : null}
          </span>
        )}
      </div>
    </Station>
  );
}

/** Fees earned set against AI spent, and how close they are to the threshold that starts the next funding run. */
function FeesStation({ status, econ }: { status: AgentStatus; econ: Economics }) {
  const toCover = fillsToCover(econ, status, toNumber(presetUsdcUnits(status, latestByDirection(status.quotes)["buy-w0g"]), "USDC"));
  const cover = econ.coverage;
  const threshold = econ.fundingThresholdUsdc;
  const toThreshold = threshold ? Math.min(1, econ.feesEarnedUsdc / threshold) : null;
  return (
    <Station k="fees" name="Fees" lit={econ.feesEarnedUsdc > 0}>
      <Value><Amount value={fmtUsdc(econ.feesEarnedUsdc)} symbol="USDC" /></Value>
      <div className="mt-3 max-w-[240px] space-y-3">
        {cover !== null ? (
          <p className="num text-[13px] text-ink-2">Fees vs AI spent <span className={cover >= 1 ? "text-ok-ink" : "text-warn-ink"}>{fmtPct(cover * 100)}</span> ({fmtUsd(econ.feesEarnedUsdc)} / {fmtUsd(econ.aiSpentUsd)}){toCover ? `, ${toCover} more ${toCover === 1 ? "fill covers" : "fills cover"} it` : ""}</p>
        ) : null}
        {toThreshold !== null && threshold ? <p className="num text-[13px] text-muted">The next funding run starts at {fmtUsdc(threshold)} USDC of fees.</p> : null}
      </div>
    </Station>
  );
}

function HopStation({ hop, evidence, status, nowMs }: { hop: (typeof HOPS)[number]; evidence: AgentStatus["funding"][number] | null; status: AgentStatus; nowMs: number }) {
  const at = evidence ? toMillis(evidence.time) : null;
  const right = isRight(hop.key);
  return (
    <Station k={hop.key} name={hop.name} lit={Boolean(evidence) || (hop.key === "swap" && status.mid !== null)}>
      {hop.key === "swap" && status.mid !== null && !evidence ? <Value className="mb-1">{fmtPrice(status.mid)} <span className="text-[13px] text-muted">USDC mid</span></Value> : null}
      <Note className="mt-0 text-balance text-ink-2"><Tk>{hop.what}</Tk></Note>
      <div className={cn("mt-2 flex flex-wrap items-center gap-x-2 text-[13px]", right && "lg:justify-end")}>
        {evidence ? (
          <>
            <CopyLink value={evidence.txHash} href={txUrl(evidence.chainId, evidence.txHash)} label={`${hop.name} transaction`} extra={hop.key === "bridge" ? { href: `https://ccip.chain.link/tx/${evidence.txHash}`, label: "CCIP explorer" } : null} />
            <time className="num text-muted" dateTime={new Date(at ?? 0).toISOString()} title={at ? utcStamp(at) : undefined}>{at ? relativeTime(at, nowMs) : ""}</time>
          </>
        ) : hop.key === "swap" && status.mid !== null ? (
          <span className="text-muted">Swaps fees to <Tk>W0G</Tk> once they reach {status.fundingThresholdUsdc ? `${fmtUsdc(Number(status.fundingThresholdUsdc))} USDC` : "the threshold"}.</span>
        ) : (
          <span className="text-muted">Runs once fees reach {status.fundingThresholdUsdc ? fmtUsdc(Number(status.fundingThresholdUsdc)) : "the threshold"} USDC.</span>
        )}
      </div>
    </Station>
  );
}

function VaultStation({ status, econ }: { status: AgentStatus; econ: Economics }) {
  const bal = BigInt(status.budget.computeBalanceWei);
  const cap = BigInt(status.budget.spendCapPerDayWei);
  const spent = BigInt(status.budget.spentTodayWei);
  const pos = gaugePosition(bal);
  const marks = [
    { label: "pause", wei: FUEL_LINES.pauseWei },
    { label: "critical", wei: FUEL_LINES.criticalWei },
    { label: "low", wei: FUEL_LINES.lowWei },
  ];
  const fuelTone: Tone = bal < FUEL_LINES.criticalWei ? "danger" : bal < FUEL_LINES.lowWei ? "warn" : "ok";
  const fuel = toNumber(bal, "0G");
  return (
    <Station k="vault" name="Payment Layer fuel" lit={bal > 0n}>
      <p className="flex items-center gap-2">
        <TokenIcon symbol="0G" size={28} />
        <NumberTicker value={Number(fmt0g(fuel).replace(/,/g, ""))} decimalPlaces={Math.max(0, (fmt0g(fuel).split(".")[1] ?? "").length)} className="text-[40px] font-medium leading-none text-ink" />
        <Tk className="text-[18px] text-muted">0G</Tk>
      </p>
      <div data-ui className={cn("relative mt-5 max-w-[560px]", TONE_CLASS[fuelTone])}>
        <div className="relative h-2.5 rounded-[2px] bg-sunken" role="meter" aria-label="Fuel against the agent's budget lines, log scale" aria-valuemin={0.01} aria-valuemax={10} aria-valuenow={fuel}>
          <div className="absolute inset-y-0 left-0 w-full origin-left rounded-[2px] bg-[var(--tone)] transition-transform duration-700 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${pos})` }} />
          {marks.map((m) => (
            <span key={m.label} aria-hidden className="absolute -top-1 h-[18px] w-0.5 bg-paper" style={{ left: `${gaugePosition(m.wei) * 100}%` }} />
          ))}
        </div>
        <div className="relative mt-1.5 h-4 text-[13px] text-muted" aria-hidden>
          {marks.map((m) => <span key={m.label} className="num absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${gaugePosition(m.wei) * 100}%` }}>{String(toNumber(m.wei, "0G"))}</span>)}
          <span className="num absolute -translate-x-1/2" style={{ left: `${gaugePosition(10n ** 18n) * 100}%` }}>1</span>
          <span className="num absolute right-0">10 <Tk>0G</Tk></span>
        </div>
      </div>
      <Note className="max-w-[52ch] text-ink-2">
        {econ.runwayDays !== null ? <>Runway <span className="num font-medium text-ink">{significant(econ.runwayDays, 2)} days</span>{econ.reported.has("runwayDays") && cap > 0n ? <> at today&apos;s pace, never under {significant(Number(bal) / Number(cap), 2)} days at the full {fmt0g(toNumber(cap, "0G"))} <Tk>0G</Tk> daily cap</> : <> at the {fmt0g(toNumber(cap, "0G"))} <Tk>0G</Tk> daily cap</>}. </> : null}
        Today it has used <span className="num text-ink">{fmtPct(cap > 0n ? (Number(spent) / Number(cap)) * 100 : 0)}</span> of that cap. Under 0.5 the agent drops to a cheaper model, under 0.05 it stops.
      </Note>
      <WhatIf balanceWei={bal} />
    </Station>
  );
}

/** Drag a hypothetical fuel level and read what the agent's own budget lines would do with it. */
function WhatIf({ balanceWei }: { balanceWei: bigint }) {
  const start = Math.round(gaugePosition(balanceWei) * 300);
  // Follows the real balance until the reader moves it; only then is it a hypothetical.
  const [picked, setPicked] = useState<number | null>(null);
  const step = picked ?? start;
  const setStep = (n: number) => setPicked(n === start ? null : n);
  const wei = BigInt(Math.round(10 ** (-2 + (3 * step) / 300) * 1e18));
  const tier = tierForBalance(wei);
  const model = MODELS[tier];
  const v = toNumber(wei, "0G");
  return (
    <div className={cn("mt-4 max-w-[560px] rounded-card bg-panel px-4 py-3", `tone-${TIER_TONE[tier]}`)}>
      <label htmlFor="fuel-what-if" className="flex items-baseline justify-between gap-3 text-[13px] text-muted">
        <span>What if the fuel were</span>
        <span className="num text-[16px] text-ink">{fmt0g(v)} <Tk>0G</Tk></span>
      </label>
      <input id="fuel-what-if" type="range" min={0} max={300} value={step} onChange={(e) => setStep(Number(e.target.value))} className="mt-2 w-full accent-[var(--tone)]" aria-valuetext={`${fmt0g(v)} 0G, tier ${tier}`} />
      <p className="mt-1 text-[14px] text-ink-2" aria-live="polite">
        <span className="font-semibold text-[var(--tone)]">{tierWord(tier)}</span>
        {model ? <>, its tier model is <span className="num text-ink">{model}</span></> : ", no new AI runs"}
.
        {picked !== null ? <button type="button" onClick={() => setPicked(null)} className="ml-2 text-muted underline underline-offset-4 hover:text-ink">Back to the real balance</button> : null}
      </p>
    </div>
  );
}

/** Billed AI runs over the last 48 hours as a heartbeat; runs close in time draw as one spike with a count. */
function BrainStation({ status, nowMs }: { status: AgentStatus; nowMs: number }) {
  const start = nowMs - HEARTBEAT_WINDOW_MS;
  const runs = runsOf(status).filter((r) => r.atMs !== null && r.atMs >= start && r.atMs <= nowMs);
  const groups = cluster(runs, (r) => (r.atMs! - start) / HEARTBEAT_WINDOW_MS, 0.035);
  const last = runs[0] ?? null;
  const W = 300, H = 64, base = 42, top = 16;
  let d = `M0 ${base}`;
  for (const g of groups) {
    const x = g.x * W;
    d += ` L${Math.max(0, x - 7)} ${base} L${x - 3} ${base + 6} L${x} ${top} L${x + 3} ${base + 12} L${Math.min(W, x + 7)} ${base}`;
  }
  d += ` L${W} ${base}`;
  return (
    <Station k="brain" name="0G compute" lit={runs.length > 0}>
      <figure data-ui className="relative max-w-[300px]">
        <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full overflow-visible" role="img" aria-label={`${runs.length} billed AI runs in the last 48 hours`}>
          <line x1={0} x2={W} y1={base} y2={base} className="stroke-rule" strokeWidth={1} />
          <path d={d} fill="none" className="chain-zg stroke-[var(--chain)]" strokeWidth={2} strokeLinejoin="round" />
          {groups.map((g, i) => g.items.length > 1 ? <CountBadge key={i} x={g.x * W} y={top - 6} n={g.items.length} /> : <circle key={i} cx={g.x * W} cy={top} r={3} className="chain-zg fill-[var(--chain)]" />)}
        </svg>
        <MarkTips clusters={groups} y={(top / H) * 64} label={(it) => `${it.length} AI ${it.length === 1 ? "run" : "runs"}, show details`} render={(r) => <RunTip r={r} nowMs={nowMs} />} />
        <figcaption className="num flex justify-between text-[13px] text-muted"><span>48 h ago</span><span>now</span></figcaption>
      </figure>
      {last ? (
        <div className="mt-2 text-[13px]">
          <p className="flex flex-wrap items-center gap-x-2 text-ink-2">Last run <CopyLink value={last.requestId} label="AI request id" /></p>
          <p className="num text-muted">{runCost(last)}{last.atMs ? `, ${relativeTime(last.atMs, nowMs)}` : ""}{last.model ? `, ${last.model}` : ""}</p>
        </div>
      ) : <Note>No billed AI run in the last 48 hours.</Note>}
    </Station>
  );
}

function RunTip({ r, nowMs }: { r: Run; nowMs: number }) {
  return (
    <div className="space-y-0.5">
      <p className="num text-ink">{runCost(r)}</p>
      <p className="num text-muted">{r.atMs ? `${utcStamp(r.atMs)}, ${relativeTime(r.atMs, nowMs)}` : "time not reported"}</p>
      <CopyLink value={r.requestId} label="AI request id" />
    </div>
  );
}

function PriceStation({ status, view, now, nowReady }: { status: AgentStatus; view: View; now: number; nowReady: boolean }) {
  const soon = view.leg.soonest ?? [view.leg.buy, view.leg.sell].filter((p): p is Priced => p !== null).sort((a, b) => b.expiry - a.expiry)[0] ?? null;
  const run = soon?.quote.requestId;
  return (
    <Station k="price" name="Signed price" lit={!view.leg.open}>
      <Note className="mt-0 text-ink-2">Signed by the brain. Fills stop at expiry.</Note>
      {soon ? <Countdown expiry={soon.expiry} now={now} ttl={status.quoteTtlSeconds ?? 3600} ready={nowReady} className="mt-3 w-full max-w-[220px]" /> : <p className="mt-3 text-[13px] text-muted">No signed price yet.</p>}
      {run && run !== "price-only" ? <p className="mt-3 flex flex-wrap items-center gap-x-2 text-[13px] text-muted">From AI run <CopyLink value={run} label="AI request id" /></p> : null}
    </Station>
  );
}

function StationSkeleton({ k }: { k: NodeKey }) {
  const spot = SPOT[SPOTS[k]];
  return (
    <div aria-hidden className={cn("relative pl-10", spot.wrap, AREA[k])}>
      <span data-node={k} className={cn("absolute left-[5px] top-[3px] size-3.5 rounded-full border-2 border-rule-2 bg-paper", spot.node)} />
      <div className="skeleton h-4 w-24" />
      <div className="skeleton mt-3 h-6 w-40 max-w-full" />
      <div className="skeleton mt-2 h-4 w-52 max-w-full" />
    </div>
  );
}
