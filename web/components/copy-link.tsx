"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { shortHash } from "@/lib/format";
import { cn } from "@/lib/utils";

type Link = { href: string; label: string };
type Props = { value: string; href?: string | null; label?: string; extra?: Link | null; className?: string };

/** A hash, address or id: one truncation rule, copy always, and an explorer link whenever an explorer knows it. */
export function CopyLink({ value, href, label, extra, className }: Props) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
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
  const icon = "grid size-8 shrink-0 sm:size-6 place-items-center rounded-control text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink";
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-0.5", className)}>
      <span className="num mr-1 min-w-0 truncate text-[13px] text-ink" title={value}>{shortHash(value)}</span>
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy ${label ?? "value"}`} className={icon}>
        {copied ? <Check className="size-3.5 text-ok" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </button>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" aria-label={`Open ${label ?? "value"} in the explorer`} title="Open in the explorer" className={icon}>
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ) : null}
      {extra ? (
        <a href={extra.href} target="_blank" rel="noreferrer" className="ml-1 whitespace-nowrap text-[13px] text-muted underline decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:text-ink hover:decoration-ink">
          {extra.label}
        </a>
      ) : null}
    </span>
  );
}
