"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowDown, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberTicker } from "@/components/ui/number-ticker";
import { CopyLink } from "@/components/copy-link";
import { AgentError } from "@/lib/agent-api";
import { formatAmount, percentOf } from "@/lib/amounts";
import { BASE_CHAIN_ID } from "@/lib/config";
import { formatPrice, relativeTime, utcStamp } from "@/lib/format";
import { toMillis, txUrl } from "@/lib/funding";
import type { Fill } from "@/lib/ledger";
import { durationLabel, FUEL_LINES, fuseLeft, gaugePosition, heartbeat, hopEvidence, HOPS, machineSentence, priceLeg, TIER_TONE, tierWord, type HopKey, type Tone } from "@/lib/machine";
import { clock, CLOSING_SECONDS, URGENT_SECONDS, type Priced } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

type NodeKey = "pool" | "fees" | HopKey | "vault" | "brain" | "price";
const ORDER: NodeKey[] = ["pool", "fees", "swap", "bridge", "withdraw", "deposit", "vault", "brain", "price"];
type Pt = { x: number; y: number };
type Seg = { from: NodeKey; to: NodeKey; points: Pt[]; state: "lit" | "dim" | "open" | "fuse" };

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
  useEffect(() => { measure(); }, [measure, view?.key]);

  const tone: Tone = status ? TIER_TONE[status.budget.tier] : "quiet";
  const segs = useMemo(() => (pts && view ? segments(pts, view) : []), [pts, view]);
  const split = pts?.price && pts.withdraw && pts.pool && pts.price.x === pts.pool.x ? Math.round((pts.price.y + pts.withdraw.y) / 2) : null;

  return (
    <section aria-labelledby="machine-title" className={cn("relative isolate overflow-hidden", TONE_CLASS[tone])}>
      {view && split !== null ? <div aria-hidden className="absolute inset-x-0 bottom-0 -z-10 hidden bg-lane lg:block" style={{ top: (rootRef.current?.offsetTop ?? 0) + split }} /> : null}

      <div className="mx-auto max-w-[1312px] px-4 sm:px-6 lg:px-12">
        <div
          ref={rootRef}
          className="relative flex flex-col gap-9 pb-12 pt-8 lg:grid lg:min-h-[calc(100dvh-64px)] lg:grid-cols-4 lg:grid-rows-[auto_minmax(280px,1fr)_auto] lg:gap-x-8 lg:gap-y-0 lg:pb-10 lg:pt-8 lg:[grid-template-areas:'pool_fees_swap_bridge'_'price_infield_infield_withdraw'_'brain_vault_vault_deposit']"
        >
          {segs.length > 0 ? <Circuit segs={segs} reduce={reduce} view={view!} now={now} ttl={status?.quoteTtlSeconds ?? 3600} /> : null}
          {split !== null && status?.readAt && pts?.pool ? <LaneLabels baseBlock={status.readAt.baseBlock} zeroGBlock={status.readAt.zeroGBlock} split={split} left={pts.pool.x} /> : null}

          <Infield status={status} loading={loading} error={error} onRetry={onRetry} view={view} now={now} nowReady={nowReady} />

          {view && status ? (
            <>
              <PoolStation status={status} fills={fills} fillsError={fillsError} nowMs={nowMs} />
              <FeesStation status={status} />
              {HOPS.map((h) => <HopStation key={h.key} hop={h} evidence={view.hops[h.key]} nowMs={nowMs} thresholdUsdc={status.fundingThresholdUsdc ?? null} />)}
              <VaultStation status={status} />
              <BrainStation status={status} nowMs={nowMs} />
              <PriceStation view={view} now={now} nowReady={nowReady} ttl={status.quoteTtlSeconds ?? 3600} />
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
  const feesAccrued = BigInt(status.fees.accruedUsdc.includes(".") ? "1" : status.fees.accruedUsdc) > 0n || status.fees.accruedW0g !== "0";
  const aiBehindPrice = status.quotes.some((q) => q.requestId && q.requestId !== "price-only");
  const lit: Record<NodeKey, boolean> = {
    pool: fillCount > 0,
    fees: feesAccrued || fillCount > 0,
    swap: Boolean(hops.swap),
    bridge: Boolean(hops.bridge),
    withdraw: Boolean(hops.withdraw),
    deposit: Boolean(hops.deposit),
    vault: BigInt(status.budget.computeBalanceWei) > 0n,
    brain: beats > 0,
    price: !leg.open,
  };
  // Re-measure only when something that changes station heights changes.
  const key = `${fillCount}|${beats}|${status.funding.length}|${leg.open}|${status.budget.tier}`;
  return { leg, hops, lit, key, fillCount, aiBehindPrice };
}

/** A segment is lit once money has moved along it at least once; the price leg is a fuse, or open when no price is fresh. */
function segments(pts: Partial<Record<NodeKey, Pt>>, view: View): Seg[] {
  const out: Seg[] = [];
  const litEdge: Record<NodeKey, boolean> = {
    pool: view.fillCount > 0,
    fees: view.lit.swap,
    swap: view.lit.swap && view.lit.bridge,
    bridge: view.lit.withdraw,
    withdraw: view.lit.deposit,
    deposit: view.lit.vault,
    vault: view.lit.brain,
    brain: view.aiBehindPrice,
    price: !view.leg.open,
  };
  ORDER.forEach((from, i) => {
    const to = ORDER[(i + 1) % ORDER.length]!;
    const a = pts[from];
    const b = pts[to];
    if (!a || !b) return;
    const closing = from === "price";
    const points = closing && Math.abs(a.x - b.x) > 2 ? [a, { x: Math.min(a.x, b.x) - 14, y: a.y }, { x: Math.min(a.x, b.x) - 14, y: b.y }, b] : [a, b];
    out.push({ from, to, points, state: closing ? (view.leg.open ? "open" : "fuse") : litEdge[from] ? "lit" : "dim" });
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
  // The draw-in runs on animation frames; a hidden tab gets none, so after 2.6 s the circuit renders complete regardless.
  const [settled, setSettled] = useState(reduce);
  useEffect(() => { const t = setTimeout(() => setSettled(true), 2600); return () => clearTimeout(t); }, []);
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
  const stroke = (s: Seg) => cn(s.state === "lit" && "stroke-[var(--tone)]", s.state === "dim" && "stroke-rule-2", s.state === "open" && "stroke-danger", s.state === "fuse" && "stroke-rule");
  return (
    <svg aria-hidden className="pointer-events-none absolute inset-0 h-full w-full overflow-visible">
      {segs.map((s, i) => {
        const common = { d: pathOf(s.points), fill: "none", strokeWidth: s.state === "lit" || s.state === "fuse" ? 2.5 : 2, strokeDasharray: s.state === "open" ? "6 7" : undefined, className: stroke(s) };
        return settled ? <path key={s.from} {...common} /> : (
          <motion.path key={s.from} {...common} initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: 1 }} transition={{ delay: i * 0.12, duration: 0.5, ease: "linear" }} />
        );
      })}
      {settled ? segs.filter((s) => s.state !== "fuse").map((s) => <Chevron key={`c-${s.from}`} seg={s} className={stroke(s)} />) : null}
      {fusePath && settled ? (
        <path
          d={pathOf(fusePath.points)}
          fill="none"
          strokeWidth={2.5}
          pathLength={1}
          strokeDasharray={`${left} 1`}
          className={cn(left * ttl <= URGENT_SECONDS ? "stroke-danger" : left * ttl <= CLOSING_SECONDS ? "stroke-warn" : "stroke-[var(--tone)]")}
        />
      ) : null}
      {!reduce && view.fillCount > 0 ? <Pulses route={route("pool", "fees")} count={Math.min(view.fillCount, 5)} delay={1.2} /> : null}
      {!reduce && view.lit.deposit ? <Pulses route={route(view.lit.swap ? "fees" : "swap", "vault")} count={1} delay={1.6} dwell /> : null}
      {!reduce && view.lit.brain && view.aiBehindPrice && !view.leg.open ? <Pulses route={route("brain", "pool")} count={1} delay={2.6} /> : null}
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

/** Real events replayed once: one dot per fill entering at the pool, the recorded funding run riding the four hops. */
function Pulses({ route, count, delay, dwell }: { route: Pt[]; count: number; delay: number; dwell?: boolean }) {
  if (route.length < 2) return null;
  const lengths = route.slice(1).map((p, i) => Math.hypot(p.x - route[i]!.x, p.y - route[i]!.y));
  const total = lengths.reduce((a, b) => a + b, 0) || 1;
  const xs = route.map((p) => p.x);
  const ys = route.map((p) => p.y);
  let acc = 0;
  const times = [0, ...lengths.map((l) => (acc += l) / total)];
  const duration = Math.max(1.2, total / (dwell ? 160 : 260));
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <motion.circle
          key={i}
          r={4.5}
          className="fill-[var(--tone)]"
          initial={{ cx: xs[0], cy: ys[0], opacity: 0 }}
          animate={{ cx: xs, cy: ys, opacity: [0, ...Array(xs.length - 2).fill(1), 0] }}
          transition={{ delay: delay + i * 0.35, duration, times, ease: "linear" }}
        />
      ))}
    </>
  );
}

/** The two chains, written up and down the left rail where the circuit crosses from one to the other. */
function LaneLabels({ baseBlock, zeroGBlock, split, left }: { baseBlock: string; zeroGBlock: string; split: number; left: number }) {
  const n = (v: string) => Number(v).toLocaleString("en-US");
  const cls = "station absolute whitespace-nowrap text-[13px] text-muted [writing-mode:vertical-rl]";
  return (
    <div aria-label="Chains" className="pointer-events-none absolute inset-0 hidden lg:block">
      <p className={cn(cls, "rotate-180")} style={{ left: left + 9, bottom: `calc(100% - ${split - 10}px)` }}>Base <span className="num font-normal normal-case tracking-normal">{n(baseBlock)}</span></p>
      <p className={cls} style={{ left: left + 9, top: split + 10 }}>0G chain <span className="num font-normal normal-case tracking-normal">{n(zeroGBlock)}</span></p>
    </div>
  );
}

function Infield({ status, loading, error, onRetry, view, now, nowReady }: { status: AgentStatus | undefined; loading: boolean; error: Error | null; onRetry: () => void; view: View | null; now: number; nowReady: boolean }) {
  const tone = status ? TIER_TONE[status.budget.tier] : "quiet";
  return (
    <div className="relative z-10 flex flex-col justify-center lg:px-10 lg:py-10 lg:[grid-area:infield]">
      <h1 id="machine-title" className="max-w-[15ch] text-[44px] sm:text-[60px] lg:text-[68px]">Upkeep pays for its own brain</h1>
      <p className="mt-4 max-w-[46ch] text-[18px] leading-[1.5] text-ink-2">
        A market maker on Base. Every swap pays a fee, the fee crosses to the 0G chain, and it buys the AI run that signs the next price. No fresh price, no fill.
      </p>
      <div className="mt-5 min-h-[48px]" aria-live="polite">
        {error && !status ? (
          <div role="alert" className="flex flex-wrap items-center gap-3">
            <p className="text-[16px] text-danger-ink">{error instanceof AgentError && error.kind === "unreachable" ? "The agent's status route is not answering, so the machine cannot be read right now." : `The status could not be read: ${error.message}`}</p>
            <Button variant="secondary" size="sm" onClick={onRetry}><RefreshCw className="size-4" aria-hidden />Read again</Button>
          </div>
        ) : status && view && nowReady ? (
          <p className="flex max-w-[60ch] items-start gap-3 text-[16px] leading-[1.5] text-ink">
            <span aria-hidden className={cn("mt-[5px] size-2.5 shrink-0 rounded-full bg-[var(--tone)]", TONE_CLASS[tone], tone !== "quiet" && "motion-safe:animate-pulse")} />
            <span><span className="font-semibold">{tierWord(status.budget.tier)}.</span> {machineSentence(status, view.leg, now).replace(/^[^.]+\.\s*/, "")}</span>
          </p>
        ) : loading ? (
          <div className="skeleton h-5 w-80 max-w-full" aria-label="Reading the agent" />
        ) : null}
      </div>
      <div className="mt-6 flex flex-wrap gap-3">
        <Button asChild className="w-full sm:w-auto"><a href="#swap">Swap the signed price <ArrowDown className="size-4" aria-hidden /></a></Button>
        <Button asChild variant="secondary" className="w-full sm:w-auto"><Link href="/ledger">Read the ledger</Link></Button>
      </div>
    </div>
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

function Station({ k, name, chain, lit, children, className }: { k: NodeKey; name: string; chain: "Base" | "0G"; lit: boolean; children: ReactNode; className?: string }) {
  const spot = SPOT[SPOTS[k]];
  return (
    <article aria-label={name} className={cn("relative min-w-0 pl-10", spot.wrap, AREA[k], className)}>
      <span data-node={k} aria-hidden className={cn("absolute left-[5px] top-[3px] size-3.5 rounded-full border-2", lit ? "border-[var(--tone)] bg-[var(--tone)]" : "border-rule-2 bg-paper", spot.node)} />
      <h2 className="station flex items-baseline gap-2 lg:block">
        {name}
        <span className="text-[13px] font-medium normal-case tracking-normal text-muted lg:hidden">on {chain}</span>
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
  return (
    <Station k="pool" name="Aqua pool" chain="Base" lit={(fills?.length ?? 0) > 0}>
      {status.strategy ? (
        <Value>{formatAmount(BigInt(status.strategy.w0g), 18, 4)} <span className="text-[13px] text-muted">W0G</span> + {formatAmount(BigInt(status.strategy.usdc), 6, 2)} <span className="text-[13px] text-muted">USDC</span></Value>
      ) : <Value>Strategy shipped</Value>}
      <Note>Traders swap here against the signed price{fee ? `, paying ${fee}% per fill` : ""}.</Note>
      <div className="mt-2 text-[13px] text-ink-2">
        {fillsError ? <span className="text-warn-ink">Fills unreadable right now</span> : fills === null ? <span className="text-muted">Reading fills</span> : fills.length === 0 ? <span>No fill yet</span> : (
          <span className="inline-flex flex-wrap items-center gap-x-2">
            <span className="num">{fills.length} {fills.length === 1 ? "fill" : "fills"}, latest {latest?.timeMs ? relativeTime(latest.timeMs, nowMs) : `block ${latest?.blockNumber}`}</span>
            {latest ? <CopyLink value={latest.txHash} href={txUrl(BASE_CHAIN_ID, latest.txHash)} label="latest fill" head={6} tail={4} /> : null}
          </span>
        )}
      </div>
    </Station>
  );
}

function FeesStation({ status }: { status: AgentStatus }) {
  const usdc = BigInt(status.fees.accruedUsdc.includes(".") ? Math.round(Number(status.fees.accruedUsdc) * 1e6) : status.fees.accruedUsdc);
  const threshold = status.fundingThresholdUsdc ? BigInt(Math.round(Number(status.fundingThresholdUsdc) * 1e6)) : null;
  const pct = threshold ? percentOf(usdc, threshold) : 0;
  return (
    <Station k="fees" name="Fees" chain="Base" lit={usdc > 0n}>
      <Value>{formatAmount(usdc, 6, 6)} <span className="text-[13px] text-muted">USDC</span></Value>
      <Note>Collected from fills, waiting for the next funding run.</Note>
      {threshold ? (
        <div className="mt-3 max-w-[220px]">
          <div className="h-1 overflow-hidden rounded-[2px] bg-sunken" role="progressbar" aria-label="Fees against the funding threshold" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
            <div className="h-full origin-left bg-[var(--tone)]" style={{ transform: `scaleX(${pct / 100})` }} />
          </div>
          <p className="num mt-1.5 text-[13px] text-muted">{pct.toFixed(pct < 1 ? 2 : 0)}% of the {status.fundingThresholdUsdc} USDC that starts a run</p>
        </div>
      ) : null}
    </Station>
  );
}

function HopStation({ hop, evidence, nowMs, thresholdUsdc }: { hop: (typeof HOPS)[number]; evidence: AgentStatus["funding"][number] | null; nowMs: number; thresholdUsdc: string | null }) {
  const at = evidence ? toMillis(evidence.time) : null;
  const chain = hop.chainId === BASE_CHAIN_ID ? "Base" : "0G";
  const spot = SPOTS[hop.key];
  const right = spot === "top-r" || spot === "side-r" || spot === "bot-r";
  return (
    <Station k={hop.key} name={hop.name} chain={chain} lit={Boolean(evidence)}>
      <Note className="mt-0 text-balance text-ink-2">{hop.what}</Note>
      <div className={cn("mt-2 flex flex-wrap items-center gap-x-2 text-[13px]", right && "lg:justify-end")}>
        {evidence ? (
          <>
            <CopyLink value={evidence.txHash} href={txUrl(evidence.chainId, evidence.txHash)} label={`${hop.name} transaction`} head={6} tail={4} />
            <time className="num text-muted" dateTime={new Date(at ?? 0).toISOString()} title={at ? utcStamp(at) : undefined}>{at ? relativeTime(at, nowMs) : ""}</time>
          </>
        ) : (
          <span className="text-muted">Runs once fees reach {thresholdUsdc ?? "the threshold"} USDC.</span>
        )}
      </div>
    </Station>
  );
}

function VaultStation({ status }: { status: AgentStatus }) {
  const bal = BigInt(status.budget.computeBalanceWei);
  const cap = BigInt(status.budget.spendCapPerDayWei);
  const spent = BigInt(status.budget.spentTodayWei);
  const pos = gaugePosition(bal);
  const days = cap > 0n ? Number(bal) / Number(cap) : null;
  const marks = [
    { label: "pause", wei: FUEL_LINES.pauseWei },
    { label: "critical", wei: FUEL_LINES.criticalWei },
    { label: "low", wei: FUEL_LINES.lowWei },
  ];
  const fuelTone: Tone = bal < FUEL_LINES.criticalWei ? "danger" : bal < FUEL_LINES.lowWei ? "warn" : "ok";
  return (
    <Station k="vault" name="Payment Layer fuel" chain="0G" lit={bal > 0n}>
      <p className="flex items-baseline gap-2">
        <NumberTicker value={Number(formatAmount(bal, 18, 4).replace(/,/g, ""))} decimalPlaces={4} className="text-[44px] font-medium leading-none text-ink lg:text-[56px]" />
        <span className="text-[18px] text-muted">0G</span>
      </p>
      <div data-ui className={cn("relative mt-5 max-w-[560px]", TONE_CLASS[fuelTone])}>
        <div className="relative h-2.5 rounded-[2px] bg-sunken" role="meter" aria-label="Fuel against the agent's budget lines, log scale" aria-valuemin={0.01} aria-valuemax={10} aria-valuenow={Number(bal) / 1e18}>
          <div className="absolute inset-y-0 left-0 w-full origin-left rounded-[2px] bg-[var(--tone)] transition-transform duration-700 ease-out motion-reduce:transition-none" style={{ transform: `scaleX(${pos})` }} />
          {marks.map((m) => (
            <span key={m.label} aria-hidden className="absolute -top-1 h-[18px] w-0.5 bg-paper" style={{ left: `${gaugePosition(m.wei) * 100}%` }} />
          ))}
        </div>
        <div className="relative mt-1.5 h-4 text-[13px] text-muted" aria-hidden>
          {marks.map((m) => <span key={m.label} className="num absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${gaugePosition(m.wei) * 100}%` }}>{Number(m.wei) / 1e18}</span>)}
          <span className="num absolute -translate-x-1/2" style={{ left: `${gaugePosition(10n ** 18n) * 100}%` }}>1</span>
          <span className="num absolute right-0">10 0G</span>
        </div>
      </div>
      <Note className="max-w-[52ch] text-ink-2">
        {days !== null ? <>About <span className="num font-medium text-ink">{days.toFixed(1)} days</span> of AI at the {formatAmount(cap, 18, 2)} 0G daily cap. </> : null}
        Spent today <span className="num text-ink">{formatAmount(spent, 18, 4)} 0G</span>. Under 0.5 the agent drops to a cheaper model, under 0.05 it stops.
      </Note>
    </Station>
  );
}

function BrainStation({ status, nowMs }: { status: AgentStatus; nowMs: number }) {
  const beats = heartbeat(status.inferences, nowMs, HEARTBEAT_WINDOW_MS);
  const last = beats.at(-1) ?? null;
  const W = 300, H = 56, base = 34;
  let d = `M0 ${base}`;
  for (const b of beats) {
    const x = b.x * W;
    d += ` L${Math.max(0, x - 7)} ${base} L${x - 3} ${base + 6} L${x} 6 L${x + 3} ${base + 12} L${Math.min(W, x + 7)} ${base}`;
  }
  d += ` L${W} ${base}`;
  const quietMs = last ? nowMs - last.atMs : null;
  return (
    <Station k="brain" name="0G compute" chain="0G" lit={beats.length > 0}>
      <figure data-ui className="max-w-[300px]">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label={`${beats.length} billed AI runs in the last 48 hours`}>
          <line x1={0} x2={W} y1={base} y2={base} className="stroke-rule" strokeWidth={1} vectorEffect="non-scaling-stroke" />
          <path d={d} fill="none" className="stroke-[var(--tone)]" strokeWidth={2} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {beats.map((b) => <circle key={b.requestId} cx={b.x * W} cy={6} r={2.5} className="fill-[var(--tone)]"><title>{`${b.requestId} at ${utcStamp(b.atMs)}`}</title></circle>)}
        </svg>
        <figcaption className="num flex justify-between text-[13px] text-muted"><span>48 h ago</span><span>now</span></figcaption>
      </figure>
      {last ? (
        <div className="mt-2 text-[13px]">
          <p className="flex flex-wrap items-center gap-x-2 text-ink-2">Last run <CopyLink value={last.requestId} label="AI request id" head={8} tail={4} /></p>
          <p className="num text-muted">{last.costLabel ? `billed ${last.costLabel}, ` : ""}{quietMs !== null ? `${durationLabel(quietMs)} ago` : ""}{status.budget.model ? `, model ${status.budget.model}` : ""}</p>
        </div>
      ) : <Note>No billed AI run in the last 48 hours.</Note>}
    </Station>
  );
}

function PriceStation({ view, now, nowReady, ttl }: { view: View; now: number; nowReady: boolean; ttl: number }) {
  return (
    <Station k="price" name="Signed price" chain="Base" lit={!view.leg.open}>
      <Note className="mt-0 text-ink-2">The brain's answer, signed and posted. The pool fills only until it expires.</Note>
      <div className="mt-3 space-y-3">
        <Fuse label="Buy 1 W0G" p={view.leg.buy} now={now} ready={nowReady} ttl={ttl} />
        <Fuse label="Sell 1 W0G" p={view.leg.sell} now={now} ready={nowReady} ttl={ttl} />
      </div>
    </Station>
  );
}

function Fuse({ label, p, now, ready, ttl }: { label: string; p: Priced | null; now: number; ready: boolean; ttl: number }) {
  if (!p) return <p className="text-[13px] text-muted">{label}: no signed price yet</p>;
  const left = Math.max(0, Math.floor(p.expiry - now));
  const frac = fuseLeft(p.expiry, now, ttl);
  const tone: Tone = left <= 0 ? "danger" : left <= URGENT_SECONDS ? "danger" : left <= CLOSING_SECONDS ? "warn" : "ok";
  return (
    <div className={TONE_CLASS[tone]}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] text-muted">{label}</span>
        <span className={cn("num text-[16px] font-medium", left > 0 ? "text-ink" : "text-muted line-through decoration-danger")}>{formatPrice(p.priceUsdcPerW0g)} <span className="text-[13px] font-normal text-muted no-underline">USDC</span></span>
      </div>
      <div className="mt-1.5 h-1 overflow-hidden rounded-[2px] bg-sunken">
        <div className="h-full origin-left bg-[var(--tone)] transition-transform duration-1000 ease-linear motion-reduce:transition-none" style={{ transform: `scaleX(${ready ? frac : 0})` }} />
      </div>
      <p className={cn("mono mt-1 text-[13px]", left > 0 ? "text-ink-2" : "text-danger-ink")}>{!ready ? "reading the chain clock" : left > 0 ? `T-${clock(left)}` : `expired ${durationLabel((now - p.expiry) * 1000)} ago`}</p>
    </div>
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

