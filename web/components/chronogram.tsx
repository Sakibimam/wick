"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { usePostedAt } from "@/hooks/use-posted-at";
import { describeStep, toMillis } from "@/lib/funding";
import { utcStamp } from "@/lib/format";
import type { Fill } from "@/lib/ledger";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

type Lane = "base" | "zg";
type Kind = "fill" | "price" | "funding" | "run";
type Mark = { id: string; lane: Lane; kind: Kind; atMs: number; label: string; link?: string };

const ROW: Record<Lane, number> = { base: 28, zg: 108 };
const KIND_LABEL: Record<Kind, string> = { fill: "fill", price: "signed price", funding: "funding step", run: "billed AI run" };

/** Every recorded event on two rows, Base above and the 0G chain below, on one time axis. Crossings are drawn where money or a price changed chains. */
export function Chronogram({ status, fills, nowMs }: { status: AgentStatus; fills: Fill[]; nowMs: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const posts = status.quotes.filter((q) => q.postedTx).sort((a, b) => Number(BigInt(b.expiry) - BigInt(a.expiry))).slice(0, 8);
  const postTimes = usePostTimes(posts.map((q) => q.postedTx!));
  const marks: Mark[] = [
    ...fills.filter((f) => f.timeMs !== null).map((f) => ({ id: f.txHash, lane: "base" as const, kind: "fill" as const, atMs: f.timeMs!, label: "fill" })),
    ...posts.flatMap((q) => (postTimes[q.postedTx!] ? [{ id: q.postedTx!, lane: "base" as const, kind: "price" as const, atMs: postTimes[q.postedTx!]!, label: q.requestId ?? "price" }] : [])),
    ...status.funding.flatMap((f) => { const t = toMillis(f.time); return t === null ? [] : [{ id: f.txHash, lane: (f.chainId === 16661 ? "zg" : "base") as Lane, kind: "funding" as const, atMs: t, label: describeStep(f.step).title }]; }),
    ...status.inferences.flatMap((r) => { const t = toMillis(r.time); return t === null ? [] : [{ id: r.requestId, lane: "zg" as const, kind: "run" as const, atMs: t, label: r.requestId }]; }),
  ];
  const t0 = Math.min(...marks.map((m) => m.atMs), nowMs - 3600_000);
  const span = Math.max(1, nowMs - t0);
  const padL = 96, padR = 24;
  const x = (t: number) => padL + ((t - t0) / span) * Math.max(1, w - padL - padR);

  // CCIP send on Base lands as the unwrap on 0G; each billed run lands as the prices signed from it.
  const ccip = status.funding.find((f) => describeStep(f.step).kind === "bridge");
  const unwrap = status.funding.find((f) => describeStep(f.step).kind === "withdraw");
  const crossings: { a: number; b: number; from: Lane; key: string }[] = [];
  if (ccip && unwrap) { const a = toMillis(ccip.time), b = toMillis(unwrap.time); if (a !== null && b !== null) crossings.push({ a, b, from: "base", key: "ccip" }); }
  for (const r of status.inferences) {
    const ra = toMillis(r.time);
    const post = marks.filter((m) => m.kind === "price" && m.label === r.requestId).sort((p, q) => p.atMs - q.atMs)[0];
    if (ra !== null && post) crossings.push({ a: ra, b: post.atMs, from: "zg", key: `run-${r.requestId}` });
  }
  const counts = (Object.keys(KIND_LABEL) as Kind[]).map((k) => [k, marks.filter((m) => m.kind === k).length] as const);

  return (
    <figure data-ui className="w-full">
      <div ref={ref} className="relative h-[164px] w-full">
        {w > 0 ? (
          <svg width={w} height={164} className="absolute inset-0" role="img" aria-label={`${marks.length} recorded events from ${utcStamp(t0)} to now`}>
            <rect x={0} y={68} width={w} height={96} className="fill-paper/40" />
            {(["base", "zg"] as const).map((lane) => (
              <g key={lane} className={lane === "base" ? "chain-base" : "chain-zg"}>
                <line x1={padL} x2={w - padR} y1={ROW[lane]} y2={ROW[lane]} className="stroke-rule" strokeWidth={2} />
                <text x={0} y={ROW[lane] + 5} className="fill-[var(--chain)] font-display text-[15px] font-semibold uppercase tracking-[0.04em]">{lane === "base" ? "Base" : "0G chain"}</text>
              </g>
            ))}
            {crossings.map((c) => {
              const ya = ROW[c.from], yb = ROW[c.from === "base" ? "zg" : "base"];
              const xa = x(c.a), xb = x(c.b);
              return <path key={c.key} d={`M${xa} ${ya} C${xa} ${(ya + yb) / 2} ${xb} ${(ya + yb) / 2} ${xb} ${yb}`} fill="none" strokeWidth={1.5} strokeDasharray={c.key === "ccip" ? undefined : "3 4"} className={cn("stroke-[var(--chain)]", c.from === "base" ? "chain-base" : "chain-zg")} />;
            })}
            {marks.map((m) => {
              const cx = x(m.atMs), cy = ROW[m.lane];
              const cls = cn(m.lane === "base" ? "chain-base" : "chain-zg");
              return (
                <g key={`${m.kind}-${m.id}`} className={cls}>
                  {m.kind === "run" ? <path d={`M${cx} ${cy - 8} L${cx + 7} ${cy + 5} L${cx - 7} ${cy + 5} Z`} className="fill-[var(--chain)]" /> :
                   m.kind === "price" ? <rect x={cx - 5} y={cy - 5} width={10} height={10} transform={`rotate(45 ${cx} ${cy})`} className="fill-[var(--chain)]" /> :
                   m.kind === "fill" ? <rect x={cx - 6} y={cy - 6} width={12} height={12} className="fill-ink" /> :
                   <circle cx={cx} cy={cy} r={5.5} className="fill-paper stroke-[var(--chain)]" strokeWidth={2.5} />}
                  <title>{`${KIND_LABEL[m.kind]}: ${m.label}, ${utcStamp(m.atMs)}`}</title>
                </g>
              );
            })}
            <text x={padL} y={158} className="num fill-muted text-[13px]">{utcStamp(t0)}</text>
            <text x={w - padR} y={158} textAnchor="end" className="num fill-muted text-[13px]">now</text>
          </svg>
        ) : null}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted">
        {counts.map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-2">
            <svg width={14} height={14} aria-hidden className="chain-zg">
              {k === "run" ? <path d="M7 1 L13 12 L1 12 Z" className="fill-[var(--chain)]" /> : k === "price" ? <rect x={3} y={3} width={8} height={8} transform="rotate(45 7 7)" className="chain-base fill-[var(--chain)]" /> : k === "fill" ? <rect x={1} y={1} width={12} height={12} className="fill-ink" /> : <circle cx={7} cy={7} r={5} className="fill-paper stroke-ink-2" strokeWidth={2} />}
            </svg>
            <span className="num text-ink">{n}</span> {KIND_LABEL[k]}{n === 1 ? "" : "s"}
          </span>
        ))}
        <span>Solid curve: CCIP carrying W0G to 0G. Dashed: an AI run on 0G becoming a signed price on Base.</span>
      </figcaption>
    </figure>
  );
}

/** Block times of the price-posting transactions, each read once from Base. Hooks per tx, so the list is capped. */
function usePostTimes(hashes: string[]): Record<string, number> {
  const list = hashes.slice(0, 8);
  const out: Record<string, number> = {};
  for (let i = 0; i < 8; i++) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const t = usePostedAt(list[i]);
    if (list[i] && t) out[list[i]!] = t * 1000;
  }
  return out;
}
