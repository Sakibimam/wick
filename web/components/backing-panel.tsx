import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CopyLink } from "@/components/copy-link";
import { TierMeter } from "@/components/tier-meter";
import { formatAmount, percentOf, truncateHex } from "@/lib/amounts";
import { CHAIN_NAMES, BASE_CHAIN_ID } from "@/lib/config";
import { describeStep, sortFunding, toMillis, txUrl } from "@/lib/funding";
import { relativeTime } from "@/lib/format";
import type { Direction, Priced } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";

type Props = { status: AgentStatus | undefined; loading: boolean; priced: Record<Direction, Priced | null>; direction: Direction; nowMs: number };

export function BackingPanel({ status, loading, priced, direction, nowMs }: Props) {
  if (loading) {
    return (
      <div aria-busy="true" className="space-y-4">
        <div className="skeleton h-6 w-56" /><div className="skeleton h-4 w-full" /><div className="skeleton h-4 w-4/5" /><div className="skeleton h-24 w-full" />
      </div>
    );
  }
  if (!status) {
    return (
      <div>
        <h2 className="text-[20px] font-medium">What backs this price</h2>
        <p className="mt-2 text-[14px] text-muted">Once the agent answers, this shows the AI run behind the price, its budget tier and the money that pays for it.</p>
      </div>
    );
  }
  const p = priced[direction];
  const last = sortFunding(status.funding).filter((f) => describeStep(f.step).kind !== "charge").at(-1);
  const lastInfo = last ? describeStep(last.step) : null;
  const lastMs = last ? toMillis(last.time) : null;
  const spent = BigInt(status.budget.spentTodayWei);
  const cap = BigInt(status.budget.spendCapPerDayWei);
  const pct = percentOf(spent, cap);
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[20px] font-medium">What backs this price</h2>
        <p className="mt-1 text-[14px]">{p?.quote.requestId === "price-only" ? "The agent signed this price from the Uniswap pool mid without an AI run. The pool only fills against that signature." : "The agent asked an AI for this price, signed the answer, and the pool only fills against that signature."}</p>
      </div>

      <section aria-label="The AI run behind this price" className="rounded-card border border-rule bg-panel p-4">
        <p className="label">AI run behind the {direction === "sell-w0g" ? "sell" : "buy"} price</p>
        {p ? (
          <dl className="mt-3 space-y-2.5 text-[14px]">
            {p.quote.requestId === "price-only" ? (
              <Line k="AI run"><span className="text-[13px] text-ink">none, signed from the pool mid</span></Line>
            ) : p.quote.requestId ? (
              <Line k="Request id on 0G"><CopyLink value={p.quote.requestId} label="AI request id" head={10} tail={6} /></Line>
            ) : null}
            <Line k="Model now"><span className="num text-[13px] text-ink">{status.budget.model ?? `none while ${status.budget.tier.toLowerCase()}`}</span></Line>
            <Line k="Quote id on Base"><CopyLink value={p.quote.inferenceId} label="quote id" head={10} tail={6} /></Line>
            {p.quote.postedTx ? <Line k="Posted in"><CopyLink value={p.quote.postedTx} href={txUrl(BASE_CHAIN_ID, p.quote.postedTx)} label="posting transaction" head={10} tail={6} /></Line> : null}
          </dl>
        ) : (
          <p className="mt-2 text-[14px] text-muted">No signed price in this direction yet, so there is no AI run to show.</p>
        )}
      </section>

      <section aria-label="Strategy inventory on Aqua">
        <p className="label">What the pool can pay out</p>
        <dl className="mt-3 space-y-2 text-[14px]">
          <Line k="W0G in the strategy"><span className="num text-ink">{formatAmount(BigInt(status.strategy.w0g), 18, 6)} W0G</span></Line>
          <Line k="USDC in the strategy"><span className="num text-ink">{formatAmount(BigInt(status.strategy.usdc), 6, 6)} USDC</span></Line>
          <Line k="Maker fee"><span className="num text-ink">{(status.strategy.feeBps / 100).toFixed(2)}% of what you pay</span></Line>
        </dl>
        <p className="num mt-2 text-[12px] text-muted">Aqua safeBalances for strategy {truncateHex(status.strategy.hash, 6, 4)}, Base block {status.readAt.baseBlock}.</p>
      </section>

      <section aria-label="Budget tier">
        <p className="label mb-3">Budget tier</p>
        <TierMeter tier={status.budget.tier} reason={status.budget.reason} />
        <dl className="mt-4 space-y-2 text-[14px]">
          <Line k="AI account balance"><span className="num text-ink">{formatAmount(BigInt(status.budget.computeBalanceWei), 18, 4)} 0G</span></Line>
          <Line k="Spent today"><span className="num text-ink">{formatAmount(spent, 18, 4)} of {cap === 0n ? "no cap set" : `${formatAmount(cap, 18, 4)} 0G`}{cap > 0n ? ` (${pct.toFixed(0)}%)` : ""}</span></Line>
          <Line k="Gas for posting prices"><span className="num text-ink">{formatAmount(BigInt(status.gasWei), 18, 6)} ETH</span></Line>
        </dl>
        <p className="num mt-2 text-[12px] text-muted">Payment Layer balanceOf on 0G block {status.readAt.zeroGBlock}.</p>
      </section>

      <section aria-label="Latest funding step" className="border-t border-rule pt-4">
        <p className="label">Latest step that funded the AI</p>
        {last && lastInfo ? (
          <div className="mt-2 text-[14px]">
            <p className="font-medium text-ink">{lastInfo.title} <span className="num text-[12px] font-normal text-muted">({lastInfo.tech})</span></p>
            <p className="mt-0.5 text-muted">{CHAIN_NAMES[last.chainId] ?? `Chain ${last.chainId}`}{lastMs ? `, ${relativeTime(lastMs, nowMs)}` : ""}</p>
            <CopyLink className="mt-1" value={last.txHash} href={txUrl(last.chainId, last.txHash)} label="funding transaction" head={10} tail={6} />
          </div>
        ) : (
          <p className="mt-2 text-[14px] text-muted">None recorded yet. Fees from the first fills go through the funding steps before the agent can buy more AI runs.</p>
        )}
        <Link href="/ledger" className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-accent underline-offset-4 hover:underline">
          Trace the whole loop on the ledger <ArrowRight className="size-4" aria-hidden />
        </Link>
      </section>
    </div>
  );
}

function Line({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <dt className="shrink-0 text-muted">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}
