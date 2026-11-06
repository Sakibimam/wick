import type { ReactNode } from "react";
import { CopyLink } from "@/components/copy-link";
import { CHAIN_NAMES } from "@/lib/config";
import { relativeTime, utcStamp } from "@/lib/format";

type Props = {
  title: ReactNode;
  plain: ReactNode;
  hash?: string;
  hashLabel?: string;
  href?: string | null;
  chainId?: number;
  timeMs?: number | null;
  nowMs: number;
};

export function EvidenceRow({ title, plain, hash, hashLabel, href, chainId, timeMs, nowMs }: Props) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3.5 transition-colors duration-150 hover:bg-sunken md:grid-cols-[minmax(0,1fr)_minmax(0,17rem)_minmax(0,9.5rem)] md:items-center">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-[14px] text-muted">{plain}</p>
      </div>
      <div className="min-w-0">{hash ? <CopyLink value={hash} href={href} label={hashLabel ?? "hash"} head={10} tail={8} /> : <span className="text-[13px] text-muted">No transaction, read from the agent</span>}</div>
      <div className="flex items-center gap-3 md:flex-col md:items-end md:gap-1">
        {chainId !== undefined ? <span className="rounded-control bg-sunken px-1.5 py-0.5 text-[12px] text-ink-2">{CHAIN_NAMES[chainId] ?? `Chain ${chainId}`}</span> : null}
        {timeMs ? <time dateTime={new Date(timeMs).toISOString()} title={utcStamp(timeMs)} className="num text-[13px] text-muted">{relativeTime(timeMs, nowMs)}</time> : null}
      </div>
    </li>
  );
}
