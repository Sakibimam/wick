import type { ReactNode } from "react";
import { CopyLink } from "@/components/copy-link";
import { ChainChip } from "@/components/token-mark";
import { relativeTime, utcStamp } from "@/lib/format";

type Props = {
  title: ReactNode;
  plain: ReactNode;
  amount?: ReactNode;
  hash?: string;
  hashLabel?: string;
  href?: string | null;
  extra?: { href: string; label: string } | null;
  chainId?: number;
  timeMs?: number | null;
  nowMs: number;
};

/** One ledger row, the same four columns everywhere: what happened, how much, the transaction, and where and when. */
export function EvidenceRow({ title, plain, amount, hash, hashLabel, href, extra, chainId, timeMs, nowMs }: Props) {
  return (
    <li className="grid grid-cols-1 gap-x-6 gap-y-2 px-4 py-3.5 transition-colors duration-150 hover:bg-sunken md:grid-cols-[minmax(0,1fr)_minmax(0,11rem)_minmax(0,15rem)_minmax(0,8rem)] md:items-center">
      <div className="min-w-0">
        <p className="text-[15px] font-semibold text-ink">{title}</p>
        <p className="mt-0.5 text-[14px] text-muted">{plain}</p>
      </div>
      <div className="min-w-0 text-[15px] text-ink md:text-right">{amount ?? null}</div>
      <div className="min-w-0">{hash ? <CopyLink value={hash} href={href} label={hashLabel ?? "hash"} extra={extra} /> : <span className="text-[13px] text-muted">Read from the agent</span>}</div>
      <div className="flex items-center gap-3 md:flex-col md:items-end md:gap-1">
        {chainId !== undefined ? <ChainChip chainId={chainId} /> : null}
        {timeMs ? <time dateTime={new Date(timeMs).toISOString()} title={utcStamp(timeMs)} className="num text-[13px] text-muted">{relativeTime(timeMs, nowMs)}</time> : null}
      </div>
    </li>
  );
}
