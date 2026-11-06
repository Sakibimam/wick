"use client";

import { useMemo, useState } from "react";
import { Machine } from "@/components/machine";
import { SwapTicket } from "@/components/swap-ticket";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { useFills } from "@/hooks/use-fills";
import { formatAmount } from "@/lib/amounts";
import { formatPrice } from "@/lib/format";
import { durationLabel } from "@/lib/machine";
import { clock, CLOSING_SECONDS, latestByDirection, offMidPct, URGENT_SECONDS, type Direction, type Priced } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

export function SwapPage() {
  const status = useAgentStatus();
  const { now, ready } = useChainNow();
  const fills = useFills(status.data?.order);
  const [direction, setDirection] = useState<Direction>("buy-w0g");
  const priced = useMemo(() => latestByDirection(status.data?.quotes ?? []), [status.data?.quotes]);
  const error = status.isError && !status.data ? status.error : null;

  return (
    <>
      <Machine
        status={status.data}
        loading={status.isPending}
        error={error}
        onRetry={() => void status.refetch()}
        fills={fills.data?.fills ?? null}
        fillsError={fills.isError && !fills.data}
        now={now}
        nowReady={ready}
      />
      <section id="swap" aria-labelledby="swap-title" className="scroll-mt-4 bg-paper">
        <div className="mx-auto grid max-w-[1312px] grid-cols-1 gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-20 lg:px-12 lg:py-28">
          <div>
            <h2 id="swap-title" className="text-[40px] lg:text-[52px]">Trade the signed price</h2>
            <p className="mb-8 mt-4 max-w-[44ch] text-[16px] text-ink-2">W0G is wrapped 0G on Base. You swap with the agent's Aqua strategy at the price its AI run signed, and your fee starts the trip to its next run.</p>
            <SwapTicket status={status.data} priced={priced} direction={direction} setDirection={setDirection} now={now} nowReady={ready} />
          </div>
          <PriceBoard status={status.data} priced={priced} direction={direction} now={now} ready={ready} loading={status.isPending} />
        </div>
      </section>
    </>
  );
}

/** The two signed prices as launch clocks: time left set directly above the price it counts down. */
function PriceBoard({ status, priced, direction, now, ready, loading }: { status: AgentStatus | undefined; priced: Record<Direction, Priced | null>; direction: Direction; now: number; ready: boolean; loading: boolean }) {
  if (loading) return <div aria-busy="true" className="space-y-6 lg:pt-32"><div className="skeleton h-14 w-72" /><div className="skeleton h-14 w-72" /><div className="skeleton h-24 w-full" /></div>;
  if (!status) return null;
  const mid = status.mid;
  return (
    <div data-ui className="lg:pt-[140px]">
      <div className="space-y-10">
        {(["buy-w0g", "sell-w0g"] as const).map((d) => <Clock key={d} d={d} p={priced[d]} now={now} ready={ready} mid={mid} active={d === direction} />)}
      </div>
      <dl className="mt-14 grid grid-cols-1 gap-x-10 gap-y-6 rounded-card bg-panel p-6 sm:grid-cols-2">
        <Fact k="Pool mid on Uniswap" v={mid !== null ? `${formatPrice(mid)} USDC` : "unavailable"} note={status.readAt ? `Base block ${Number(status.readAt.baseBlock).toLocaleString("en-US")}` : undefined} />
        {status.strategy ? <Fact k="The strategy can pay out" v={`${formatAmount(BigInt(status.strategy.w0g), 18, 4)} W0G, ${formatAmount(BigInt(status.strategy.usdc), 6, 2)} USDC`} note="Aqua safeBalances, read live" /> : null}
        {status.strategy ? <Fact k="Maker fee" v={`${(status.strategy.feeBps / 100).toFixed(2)}% of what you pay`} note="Goes to the agent's AI budget" /> : null}
        <Fact k="Funding run starts at" v={`${status.fundingThresholdUsdc ?? "10"} USDC of fees`} note="Then Uniswap, CCIP, unwrap, depositFor" />
      </dl>
    </div>
  );
}

function Clock({ d, p, now, ready, mid, active }: { d: Direction; p: Priced | null; now: number; ready: boolean; mid: number | null; active: boolean }) {
  const name = d === "buy-w0g" ? "Buy W0G" : "Sell W0G";
  if (!p) return <div><p className="mono text-[16px] text-muted">no signature yet</p><p className="font-display text-[40px] font-semibold uppercase leading-none text-muted">{name}</p></div>;
  const left = Math.max(0, Math.floor(p.expiry - now));
  const tone = left <= URGENT_SECONDS ? "danger" : left <= CLOSING_SECONDS ? "warn" : "ok";
  const off = offMidPct(p.priceUsdcPerW0g, mid);
  return (
    <div className={cn("transition-opacity duration-200", active ? "opacity-100" : "opacity-60")}>
      <p className={cn("mono text-[16px]", left > 0 ? (tone === "ok" ? "text-ok-ink" : tone === "warn" ? "text-warn-ink" : "text-danger-ink") : "text-danger-ink")}>
        {!ready ? "reading the chain clock" : left > 0 ? `T-${clock(left)}` : `Expired ${durationLabel((now - p.expiry) * 1000)} ago, the pool refuses this side`}
      </p>
      <p className="mt-1 flex flex-wrap items-baseline gap-x-4 font-display font-semibold uppercase leading-none text-ink">
        <span className="text-[40px] lg:text-[56px]">{name}</span>
        <span className={cn("num text-[40px] lg:text-[56px]", left <= 0 && "text-muted line-through decoration-danger decoration-2")}>{formatPrice(p.priceUsdcPerW0g)}</span>
        <span className="text-[22px] text-muted">USDC</span>
      </p>
      {off !== null ? <p className="num mt-2 text-[13px] text-muted">{off >= 0 ? "+" : ""}{off.toFixed(2)}% against the pool mid</p> : null}
    </div>
  );
}

function Fact({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div>
      <dt className="label">{k}</dt>
      <dd className="num mt-1 text-[22px] font-medium text-ink">{v}</dd>
      {note ? <dd className="mt-0.5 text-[13px] text-muted">{note}</dd> : null}
    </div>
  );
}
