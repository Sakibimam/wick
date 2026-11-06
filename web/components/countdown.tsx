import { CLOSING_SECONDS, URGENT_SECONDS } from "@/lib/quotes";
import { countdown } from "@/lib/format";
import { fuseLeft } from "@/lib/machine";
import { cn } from "@/lib/utils";

/** The one countdown on the site: "expires in mm:ss" over a bar that drains to zero at expiry. */
export function Countdown({ expiry, now, ttl, ready, className, barClassName }: { expiry: number; now: number; ttl: number; ready: boolean; className?: string; barClassName?: string }) {
  if (!ready) return <span aria-hidden className={cn("skeleton inline-block h-[18px] w-[13ch] align-middle", className)} />;
  const left = Math.floor(expiry - now);
  // An expired price has one name on the whole site.
  if (left <= 0) return <span className={cn("num text-[13px] text-muted", className)}>Requoting</span>;
  const tone = left <= URGENT_SECONDS ? "tone-danger" : left <= CLOSING_SECONDS ? "tone-warn" : "tone-ok";
  return (
    <span className={cn("inline-flex flex-col gap-1", tone, className)}>
      <span className="num text-[13px] text-ink-2" aria-live="off">{countdown(left)}</span>
      <span aria-hidden className={cn("block h-1 w-full overflow-hidden rounded-[2px] bg-sunken", barClassName)}>
        <span className="block h-full origin-left bg-[var(--tone)] transition-transform duration-1000 ease-linear motion-reduce:transition-none" style={{ transform: `scaleX(${fuseLeft(expiry, now, ttl)})` }} />
      </span>
    </span>
  );
}
