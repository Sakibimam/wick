"use client";

import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Where a figure is read from, for the reader who wants the contract call or event name. Body copy stays plain. */
export function SourceNote({ children, className }: { children: ReactNode; className?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className={cn("group relative inline-block", className)}>
      <button
        type="button"
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onBlur={() => setOpen(false)}
        className="rounded-control text-[13px] text-muted underline decoration-dotted decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:text-ink"
      >
        Source
      </button>
      <span
        id={id}
        role="tooltip"
        className={cn(
          "absolute bottom-full left-0 z-30 mb-2 w-max max-w-[min(80vw,420px)] rounded-control border border-rule-2 bg-panel px-3 py-2 text-[13px] leading-[1.45] text-ink-2 shadow-[0_8px_24px_oklch(0%_0_0/0.4)]",
          open ? "block" : "hidden group-hover:block group-focus-within:block",
        )}
      >
        {children}
      </span>
    </span>
  );
}
