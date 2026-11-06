"use client";

import { useMemo, useState } from "react";
import { Machine } from "@/components/machine";
import { SwapTicket } from "@/components/swap-ticket";
import { CopyLink } from "@/components/copy-link";
import { Amount, ProtocolIcon, Tk } from "@/components/token-mark";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { useFills } from "@/hooks/use-fills";
import { BASE_CHAIN_ID, TOKENS } from "@/lib/config";
import { economicsOf, fillEconomics, fmtDecisions, maxFillIn, runCost, takersOf } from "@/lib/economics";
import { fmt0g, fmtUnits, fmtUsd, fmtUsdc, relativeTime, significant } from "@/lib/format";
import { txUrl } from "@/lib/funding";
import type { Fill } from "@/lib/ledger";
import { latestByDirection, type Direction, type Priced } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";

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
      <section id="swap" aria-labelledby="swap-title" className="scroll-mt-4 border-t border-rule bg-paper">
        <div className="mx-auto grid max-w-[1312px] grid-cols-1 gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-20 lg:px-12 lg:py-20">
          <div>
            <h2 id="swap-title" className="text-[40px] lg:text-[52px]">Trade the signed price</h2>
            <p className="mb-8 mt-4 max-w-[44ch] text-[16px] text-ink-2"><Tk>W0G</Tk> is wrapped <Tk>0G</Tk> on Base. You swap with the agent&apos;s 1inch Aqua strategy at the price its AI run signed, and your fee starts the trip to its next run.</p>
            <SwapTicket status={status.data} priced={priced} direction={direction} setDirection={setDirection} now={now} nowReady={ready} />
          </div>
          <Economics status={status.data} priced={priced} fills={fills.data?.fills ?? null} nowMs={now * 1000} loading={status.isPending} />
        </div>
      </section>
    </>
  );
}

/** What a swap is worth to the agent: depth it can fill, what one AI run costs in swap volume, and who has filled so far. */
function Economics({ status, priced, fills, nowMs, loading }: { status: AgentStatus | undefined; priced: Record<Direction, Priced | null>; fills: Fill[] | null; nowMs: number; loading: boolean }) {
  if (loading) return <div aria-busy="true" className="space-y-6 lg:pt-28"><div className="skeleton h-32 w-full" /><div className="skeleton h-40 w-full" /><div className="skeleton h-32 w-full" /></div>;
  if (!status) return null;
  const econ = economicsOf(status);
  const buyMax = maxFillIn("buy-w0g", status, priced["buy-w0g"]);
  const sellMax = maxFillIn("sell-w0g", status, priced["sell-w0g"]);
  const takers = fills ? takersOf(status, fills) : null;
  return (
    <div className="space-y-10 lg:pt-28">
      {econ.breakEvenFillUsdcPerRun !== null && econ.lastRun ? (
        <div>
          <p className="label">Swap volume that pays for one AI run</p>
          <p className="mt-2 font-display text-[64px] font-semibold leading-none text-ink"><Amount value={fmtUsdc(econ.breakEvenFillUsdcPerRun)} symbol="USDC" size={28} unitClassName="text-[24px]" /></p>
          <p className="mt-3 max-w-[56ch] text-[16px] leading-[1.6] text-ink-2">
            The last AI run cost <span className="num text-ink">{runCost(econ.lastRun)}</span>. At the {status.strategy ? `${(status.strategy.feeBps / 100).toFixed(2)}%` : ""} maker fee, that much trading pays for the next one.
          </p>
        </div>
      ) : null}

      <div className="border-t border-rule pt-6">
        <p className="label flex items-center gap-1.5"><ProtocolIcon protocol="aqua" size={14} />Depth the strategy can fill right now</p>
        <dl className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="ask">
            <dt className="text-[13px] text-ink-2"><span className="font-semibold text-[var(--tone)]">Buy</span> <Tk>W0G</Tk>, pay up to</dt>
            <dd className="mt-1 text-[24px] text-ink">{buyMax !== null ? <Amount value={fmtUnits(buyMax, "USDC")} symbol="USDC" /> : "no price signed"}</dd>
            {status.strategy ? <dd className="num text-[13px] text-muted">for up to {fmt0g(Number(status.strategy.w0g) / 1e18)} <Tk>W0G</Tk> in the strategy</dd> : null}
          </div>
          <div className="bid">
            <dt className="text-[13px] text-ink-2"><span className="font-semibold text-[var(--tone)]">Sell</span> <Tk>W0G</Tk>, pay up to</dt>
            <dd className="mt-1 text-[24px] text-ink">{sellMax !== null ? <Amount value={fmtUnits(sellMax, "W0G")} symbol="W0G" /> : "no price signed"}</dd>
            {status.strategy ? <dd className="num text-[13px] text-muted">for up to {fmtUsdc(Number(status.strategy.usdc) / 1e6)} USDC in the strategy</dd> : null}
          </div>
        </dl>
      </div>

      <div className="border-t border-rule pt-6">
        <p className="label">Takers</p>
        <p className="num mt-2 text-[16px] text-ink-2">
          {takers ? (takers.outside === 0 ? `Be the first outside fill. The agent seeded ${takers.seedFills === 1 ? "one" : takers.seedFills} at 0.10 USDC.` : `${takers.outside} outside ${takers.outside === 1 ? "wallet has" : "wallets have"} filled${takers.seedFills > 0 ? `, after ${takers.seedFills} seed fill (agent)` : ""}.`) : <span aria-hidden className="skeleton inline-block h-4 w-64" />}
        </p>
        {fills && fills.length > 0 ? (
          <ul className="mt-4 divide-y divide-rule rounded-card bg-panel">
            {fills.slice(0, 4).map((f) => {
              const e = fillEconomics(f, status);
              const inSym = f.tokenIn.toLowerCase() === TOKENS.USDC.address.toLowerCase() ? "USDC" : "W0G";
              return (
                <li key={`${f.txHash}-${f.amountIn}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-[13px]">
                  <span className="flex items-center gap-2 text-ink">
                    <Amount value={fmtUnits(f.amountIn, inSym)} symbol={inSym} size={14} />
                    {e.seed ? <span className="rounded-control bg-sunken px-1.5 py-0.5 text-[12px] text-muted">seed fill (agent)</span> : null}
                  </span>
                  <span className="num text-muted">{e.feeUsdc !== null ? `fee ${fmtUsd(e.feeUsdc)}` : ""}{e.decisionsFunded !== null ? `, funds ${fmtDecisions(e.decisionsFunded)} decisions` : ""}</span>
                  <span className="flex items-center gap-2"><CopyLink value={f.txHash} href={txUrl(BASE_CHAIN_ID, f.txHash)} label="fill transaction" />{f.timeMs ? <span className="num text-muted">{relativeTime(f.timeMs, nowMs)}</span> : null}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
