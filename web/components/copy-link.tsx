"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { truncateHex } from "@/lib/amounts";
import { cn } from "@/lib/utils";

type Props = { value: string; href?: string | null; label?: string; head?: number; tail?: number; tone?: "paper" | "graphite"; className?: string };

/** A hash or id with copy and, when an explorer knows it, an open link. One control, two verbs. */
export function CopyLink({ value, href, label, head = 8, tail = 6, tone = "paper", className }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const quiet = tone === "graphite" ? "text-on-graphite-muted hover:text-on-graphite" : "text-muted hover:text-ink";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    } catch (e) {
      if (!(e instanceof DOMException)) throw e;
    }
  };
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span className={cn("num min-w-0 truncate text-[13px]", tone === "graphite" ? "text-on-graphite" : "text-ink")} title={value}>{truncateHex(value, head, tail)}</span>
      <button type="button" onClick={copy} aria-label={`Copy ${label ?? "value"}`} className={cn("grid size-6 shrink-0 place-items-center rounded-control", quiet)}>
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label ?? "value"} in the explorer`} className={cn("grid size-6 shrink-0 place-items-center rounded-control", quiet)}>
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
    </span>
  );
}
