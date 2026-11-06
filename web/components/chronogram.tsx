"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";
import { CopyLink } from "@/components/copy-link";
import { CountBadge, MarkTips } from "@/components/mark-tips";
import { ChainIcon, Tk } from "@/components/token-mark";
import { cluster } from "@/lib/cluster";
import { BASE_CHAIN_ID, TOKENS, ZERO_G_CHAIN_ID } from "@/lib/config";
import { runCost, runsOf } from "@/lib/economics";
import { fmtPrice, fmtUnits, relativeTime, utcStamp } from "@/lib/format";
import { describeStep, toMillis, txUrl } from "@/lib/funding";
import type { Fill } from "@/lib/ledger";
import { directionOf, impliedPrice } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

type Lane = "base" | "zg";
type Kind = "fill" | "price" | "funding" | "run";
type Mark = { id: string; lane: Lane; kind: Kind; atMs: number; what: string; chainId: number | null; link: string | null };

const ROW: Record<Lane, number> = { base: 36, zg: 116 };
const KIND_LABEL: Record<Kind, string> = { fill: "fill", price: "signed price", funding: "funding transaction", run: "billed AI run" };

/** Every recorded event on two rows, Base above and the 0G chain below, on one time axis. Close events stack into one mark with a count. */
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

  const postTimes = usePostTimes(status.quotes.map((q) => q.postedTx).filter((h): h is string => Boolean(h)));
  const marks: Mark[] = [
    ...fills.filter((f) => f.timeMs !== null).map((f) => {
      const sym = f.tokenIn.toLowerCase() === TOKENS.USDC.address.toLowerCase() ? "USDC" : "W0G";
      return { id: f.txHash, lane: "base" as const, kind: "fill" as const, atMs: f.timeMs!, what: `${fmtUnits(f.amountIn, sym)} ${sym} filled`, chainId: BASE_CHAIN_ID, link: f.txHash };
    }),
    ...status.quotes.flatMap((q) => {
      const t = q.postedTx ? postTimes[q.postedTx] : undefined;
      const d = directionOf(q);
      return t ? [{ id: q.postedTx!, lane: "base" as const, kind: "price" as const, atMs: t, what: d ? `${d === "buy-w0g" ? "Ask" : "Bid"} ${fmtPrice(impliedPrice(d, BigInt(q.rateE18)))} USDC` : "Signed price", chainId: BASE_CHAIN_ID, link: q.postedTx! }] : [];
    }),
    ...status.funding.flatMap((f) => { const t = toMillis(f.time); return t === null ? [] : [{ id: f.txHash, lane: (f.chainId === ZERO_G_CHAIN_ID ? "zg" : "base") as Lane, kind: "funding" as const, atMs: t, what: describeStep(f.step).title, chainId: f.chainId, link: f.txHash }]; }),
    ...runsOf(status).flatMap((r) => (r.atMs === null ? [] : [{ id: r.requestId, lane: "zg" as const, kind: "run" as const, atMs: r.atMs, what: `AI run, ${runCost(r)}`, chainId: null, link: r.requestId }])),
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
    const posts = status.quotes.filter((q) => q.requestId === r.requestId && q.postedTx && postTimes[q.postedTx]).map((q) => postTimes[q.postedTx!]!);
    if (ra !== null && posts.length) crossings.push({ a: ra, b: Math.min(...posts), from: "zg", key: `run-${r.requestId}` });
  }
  // Gridlines every 6 hours of UTC so the long quiet stretches still read as time.
  const SIX = 6 * 3600_000;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / SIX) * SIX; t < nowMs - SIX / 3; t += SIX) if (x(t) - padL > 40) ticks.push(t);
  const counts = (Object.keys(KIND_LABEL) as Kind[]).map((k) => [k, marks.filter((m) => m.kind === k).length] as const);
  const lanes = (["base", "zg"] as const).map((lane) => ({ lane, groups: cluster(marks.filter((m) => m.lane === lane), (m) => (w > 0 ? x(m.atMs) / w : 0), 18 / Math.max(1, w)) }));

  return (
    <figure data-ui className="w-full">
      <div ref={ref} className="relative h-[172px] w-full">
        {w > 0 ? (
          <>
            <svg width={w} height={172} className="absolute inset-0 overflow-visible" role="img" aria-label={`${marks.length} recorded events from ${utcStamp(t0)} to now`}>
              {(["base", "zg"] as const).map((lane) => (
                <g key={lane} className={lane === "base" ? "chain-base" : "chain-zg"}>
                  <line x1={padL} x2={w - padR} y1={ROW[lane]} y2={ROW[lane]} className="stroke-rule" strokeWidth={2} />
                </g>
              ))}
              {crossings.map((c) => {
                const ya = ROW[c.from], yb = ROW[c.from === "base" ? "zg" : "base"];
                const xa = x(c.a), xb = x(c.b);
                return <path key={c.key} d={`M${xa} ${ya} C${xa} ${(ya + yb) / 2} ${xb} ${(ya + yb) / 2} ${xb} ${yb}`} fill="none" strokeWidth={1.5} strokeDasharray={c.key === "ccip" ? undefined : "3 4"} className={cn("stroke-[var(--chain)]", c.from === "base" ? "chain-base" : "chain-zg")} />;
              })}
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={x(t)} x2={x(t)} y1={ROW.base - 14} y2={ROW.zg + 14} className="stroke-rule" strokeWidth={1} strokeDasharray="2 4" />
                  {w > 640 ? <text x={x(t)} y={ROW.zg + 30} textAnchor="middle" className="num fill-muted text-[12px]">{hourLabel(t)}</text> : null}
                </g>
              ))}
              {lanes.map(({ lane, groups }) => groups.map((g, i) => {
                const cx = g.x * w, cy = ROW[lane];
                // A fill is the rarest and most important event, so it is the shape a mixed cluster shows.
                const m = g.items.find((it) => it.kind === "fill") ?? g.items.find((it) => it.kind === "run") ?? g.items[0]!;
                const crowded = i > 0 && (g.x - groups[i - 1]!.x) * w < 28 && i % 2 === 1;
                return (
                  <g key={`${lane}-${i}`} className={lane === "base" ? "chain-base" : "chain-zg"}>
                    <Shape kind={m.kind} cx={cx} cy={cy} />
                    <CountBadge x={cx + 10} y={crowded ? cy + 14 : cy - 12} n={g.items.length} />
                  </g>
                );
              }))}
              <text x={padL} y={166} className="num fill-muted text-[13px]">{utcStamp(t0)}</text>
              <text x={w - padR} y={166} textAnchor="end" className="num fill-muted text-[13px]">now</text>
            </svg>
            <p className="pointer-events-none absolute left-0 flex items-center gap-1.5 font-display text-[15px] font-semibold uppercase tracking-[0.04em] text-ink" style={{ top: ROW.base - 10 }}><ChainIcon chainId={BASE_CHAIN_ID} size={16} />Base</p>
            <p className="pointer-events-none absolute left-0 flex items-center gap-1.5 font-display text-[15px] font-semibold uppercase tracking-[0.04em] text-ink" style={{ top: ROW.zg - 10 }}><ChainIcon chainId={ZERO_G_CHAIN_ID} size={16} /><Tk>0G</Tk></p>
            {lanes.map(({ lane, groups }) => (
              <MarkTips
                key={lane}
                clusters={groups}
                y={ROW[lane]}
                label={(items) => `${items.length} ${items.length === 1 ? KIND_LABEL[items[0]!.kind] : "events"} on ${lane === "base" ? "Base" : "0G"}, show details`}
                render={(m) => (
                  <div className="space-y-0.5">
                    <p className="text-ink"><Tk>{m.what}</Tk></p>
                    <p className="num text-muted">{utcStamp(m.atMs)}, {relativeTime(m.atMs, nowMs)}</p>
                    {m.link ? <CopyLink value={m.link} href={m.chainId ? txUrl(m.chainId, m.link) : null} label={KIND_LABEL[m.kind]} /> : null}
                  </div>
                )}
              />
            ))}
          </>
        ) : null}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-muted">
        {counts.map(([k, n]) => (
          <span key={k} className="inline-flex items-center gap-2">
            <svg width={14} height={14} aria-hidden className={k === "run" || k === "funding" ? "chain-zg" : "chain-base"}><Shape kind={k} cx={7} cy={7} small /></svg>
            <span className="num text-ink">{n}</span> {KIND_LABEL[k]}{n === 1 ? "" : "s"}
          </span>
        ))}
        <span>Solid curve: CCIP carrying <Tk>W0G</Tk> to <Tk>0G</Tk>. Dashed: an AI run on <Tk>0G</Tk> becoming a signed price on Base. Tap a mark for its transaction.</span>
      </figcaption>
    </figure>
  );
}

function Shape({ kind, cx, cy, small }: { kind: Kind; cx: number; cy: number; small?: boolean }) {
  const s = small ? 0.75 : 1;
  if (kind === "run") return <path d={`M${cx} ${cy - 8 * s} L${cx + 7 * s} ${cy + 5 * s} L${cx - 7 * s} ${cy + 5 * s} Z`} className="chain-zg fill-[var(--chain)]" />;
  if (kind === "price") return <rect x={cx - 5 * s} y={cy - 5 * s} width={10 * s} height={10 * s} transform={`rotate(45 ${cx} ${cy})`} className="fill-[var(--chain)]" />;
  if (kind === "fill") return <rect x={cx - 6 * s} y={cy - 6 * s} width={12 * s} height={12 * s} className="fill-ink" />;
  return <circle cx={cx} cy={cy} r={5.5 * s} className="fill-paper stroke-[var(--chain)]" strokeWidth={2.5} />;
}

/** Block times of every price-posting transaction, each read once from Base and cached for good. */
function usePostTimes(hashes: string[]): Record<string, number> {
  const client = usePublicClient({ chainId: base.id });
  const results = useQueries({
    queries: hashes.map((h) => ({
      queryKey: ["posted-at", h],
      enabled: Boolean(client),
      staleTime: Infinity,
      retry: 2,
      queryFn: async () => {
        const receipt = await client!.getTransactionReceipt({ hash: h as `0x${string}` });
        const block = await client!.getBlock({ blockNumber: receipt.blockNumber });
        return Number(block.timestamp);
      },
    })),
  });
  const out: Record<string, number> = {};
  results.forEach((r, i) => { if (r.data) out[hashes[i]!] = r.data * 1000; });
  return out;
}

function hourLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:00`;
}
