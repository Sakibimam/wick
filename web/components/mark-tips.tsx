"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type Cluster<T> = { x: number; items: T[] };

/**
 * Hover, focus or tap targets laid over a chart's marks. Each target is one cluster of marks; its tooltip lists every
 * item in the cluster with whatever the caller renders (amount, time, transaction link).
 */
export function MarkTips<T>({ clusters, y, label, render, className }: { clusters: Cluster<T>[]; y: number; label: (items: T[]) => string; render: (item: T) => ReactNode; className?: string }) {
  const [pinned, setPinned] = useState<number | null>(null);
  return (
    <div className={cn("pointer-events-none absolute inset-0", className)}>
      {clusters.map((c, i) => {
        const open = pinned === i;
        const side = c.x < 0.25 ? "left-0" : c.x > 0.75 ? "right-0" : "left-1/2 -translate-x-1/2";
        return (
          <div key={i} className="group pointer-events-auto absolute" style={{ left: `${c.x * 100}%`, top: y }} onMouseLeave={() => setPinned((p) => (p === i ? null : p))}>
            <button
              type="button"
              aria-label={label(c.items)}
              aria-expanded={open}
              onClick={() => setPinned(open ? null : i)}
              className="absolute size-8 -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-offset-0"
            />
            <div
              role="tooltip"
              className={cn(
                "absolute bottom-5 z-30 w-max max-w-[min(86vw,340px)] space-y-2 rounded-control border border-rule-2 bg-panel px-3 py-2.5 text-[13px] text-ink-2 shadow-[0_8px_24px_oklch(0%_0_0/0.45)]",
                side,
                open ? "block" : "hidden group-hover:block group-focus-within:block",
              )}
            >
              {c.items.map((it, j) => <div key={j}>{render(it)}</div>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The count printed on a mark that stands for more than one event. */
export function CountBadge({ x, y, n }: { x: number | string; y: number; n: number }) {
  if (n < 2) return null;
  return (
    <g aria-hidden>
      <circle cx={x} cy={y} r={9} className="fill-ink" />
      <text x={x} y={y + 4} textAnchor="middle" className="num fill-paper text-[12px] font-semibold">{n}</text>
    </g>
  );
}
