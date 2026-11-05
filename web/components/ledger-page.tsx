"use client";

import { useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertBody, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EvidenceRow } from "@/components/evidence-row";
import { TierChip, TierMeter } from "@/components/tier-meter";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { useFills } from "@/hooks/use-fills";
import { useTierHistory } from "@/hooks/use-tier-history";
import { AgentError } from "@/lib/agent-api";
import { parseUnits } from "viem";
import { formatAmount, percentOf, truncateHex } from "@/lib/amounts";
import { BASE_CHAIN_ID, FILL_LOOKBACK_BLOCKS, TOKENS } from "@/lib/config";
import { describeStep, toMillis, txUrl } from "@/lib/funding";
import { formatPrice, relativeTime, utcStamp } from "@/lib/format";
import { clock, directionOf, impliedPrice, secondsLeft } from "@/lib/quotes";
import { usePostedAt } from "@/hooks/use-posted-at";
import { buildLoop, loopSentence, type Loop } from "@/lib/ledger";
import { reasonText } from "@/lib/tiers";
import type { AgentStatus } from "@/lib/schema";
import { cn } from "@/lib/utils";

export function LedgerPage() {
  const status = useAgentStatus();
  const { now } = useChainNow();
  const nowMs = now * 1000;
  const fills = useFills(status.data?.order);
  const history = useTierHistory(status.data ? { tier: status.data.budget.tier, reason: status.data.budget.reason } : null);
  const loop = useMemo(() => (status.data ? buildLoop(status.data, fills.data?.fills ?? []) : null), [status.data, fills.data?.fills]);
  const readAt = status.dataUpdatedAt ? utcStamp(status.dataUpdatedAt) : null;

  return (
    <>
      <div className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-6 md:pt-12">
        <h1 className="max-w-[18ch] text-[40px] font-semibold leading-[1.05] sm:max-w-none">Where the agent's AI money comes from.</h1>
        <p className="mt-3 max-w-[62ch] text-[15px]" aria-live="polite">
          {loop ? loopSentence(loop) : status.isError ? "The agent is not answering, so the loop cannot be traced right now." : "Reading the agent's records."}
        </p>
      </div>

      <div className="mt-8">
        <GaugeBand status={status.data} loading={status.isPending} error={status.isError && !status.data ? status.error : null} onRetry={() => void status.refetch()} />
      </div>

      <div className="mx-auto max-w-[1200px] px-4 py-8 sm:px-6 md:py-12">
        {status.isPending ? <RailSkeleton /> : loop && status.data ? (
          <ol className="relative space-y-10 before:absolute before:bottom-2 before:left-[13px] before:top-2 before:w-px before:bg-rule-2" aria-label="The money loop in order">
            <Stage n={1} title="The agent shipped its order and signed prices" caption={readAt ? `Prices read from the agent status API, ${readAt}. Order hash read from the router on Base.` : undefined}>
              <PriceRows status={status.data} orderHash={fills.data?.orderHash ?? null} nowMs={nowMs} />
            </Stage>
            <Stage n={2} title="Outside takers filled swaps" caption={fills.data ? `Read from Base blocks ${fills.data.fromBlock} to ${fills.data.toBlock}, Swapped events of the router for this strategy.` : `Read from the last ${FILL_LOOKBACK_BLOCKS.toLocaleString("en-US")} Base blocks.`}>
              <FillsRows loop={loop} query={fills} nowMs={nowMs} />
            </Stage>
            <Stage n={3} title="Fees collected from those fills" caption={readAt ? `Read from the agent status API, ${readAt}.` : undefined}>
              <FeesRow loop={loop} />
            </Stage>
            <Stage n={4} title="Fees turned into AI money" caption={readAt ? `Each step is a transaction. Read from the agent status API, ${readAt}.` : undefined}>
              <FundingRows loop={loop} threshold={status.data.fundingThresholdUsdc ?? null} nowMs={nowMs} />
            </Stage>
            <Stage n={5} title="AI runs paid from that balance" caption={readAt ? `Read from the agent status API, ${readAt}.` : undefined}>
              <RunRows loop={loop} nowMs={nowMs} />
            </Stage>
          </ol>
        ) : null}

        {status.data ? <TierHistory history={history} current={status.data.budget} /> : null}
      </div>
    </>
  );
}

function GaugeBand({ status, loading, error, onRetry }: { status: AgentStatus | undefined; loading: boolean; error: Error | null; onRetry: () => void }) {
  return (
    <section aria-label="AI account balance" className="on-graphite border-y border-graphite-rule bg-graphite text-on-graphite">
      <div className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 md:py-8">
        {loading ? (
          <div aria-busy="true" className="grid grid-cols-1 gap-8 md:grid-cols-3">
            {[0, 1, 2].map((i) => <div key={i} className="space-y-3"><div className="skeleton h-4 w-40" /><div className="skeleton h-14 w-56" /><div className="skeleton h-4 w-full" /></div>)}
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="font-display text-[20px] font-medium">{error instanceof AgentError && error.kind === "unreachable" ? "The agent is not answering." : "The agent's answer could not be read."}</p>
              <p className="num mt-2 text-[12px] text-on-graphite-muted">{error.message}</p>
            </div>
            <Button variant="inverse" onClick={onRetry}><RefreshCw className="size-4" aria-hidden />Try again</Button>
          </div>
        ) : status ? <GaugeLive status={status} /> : null}
      </div>
    </section>
  );
}

function GaugeLive({ status }: { status: AgentStatus }) {
  const balance = BigInt(status.budget.computeBalanceWei);
  const spent = BigInt(status.budget.spentTodayWei);
  const cap = BigInt(status.budget.spendCapPerDayWei);
  const pct = percentOf(spent, cap);
  const barTone = pct >= 90 ? "bg-danger" : pct >= 75 ? "bg-warn" : "bg-ok";
  return (
    <div className="grid grid-cols-1 gap-8 md:grid-cols-[1.1fr_1fr_1.1fr] md:gap-10">
      <div>
        <p className="label">AI account balance</p>
        <p className="mt-2 flex items-baseline gap-3"><span className="readout text-[40px] leading-none md:text-[56px]">{formatAmount(balance, 18, 4)}</span><span className="num text-[16px] text-on-graphite-muted md:text-[20px]">0G</span></p>
        <p className="mt-2 text-[13px] text-on-graphite-muted">Held in the 0G Payment Layer. Every AI run is paid from this number.</p>
      </div>
      <div>
        <p className="label">Spent today against the daily cap</p>
        <p className="mt-2 flex items-baseline gap-3"><span className="readout text-[28px] leading-none">{formatAmount(spent, 18, 4)}</span><span className="num text-[14px] text-on-graphite-muted">{cap === 0n ? "no cap set" : `of ${formatAmount(cap, 18, 4)} 0G`}</span></p>
        <div className="mt-4 h-1.5 overflow-hidden rounded-sm bg-graphite-2" role="progressbar" aria-label="Share of the daily cap spent" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div className={cn("h-full rounded-sm", barTone)} style={{ width: `${pct}%` }} />
        </div>
        <p className="num mt-2 text-[13px] text-on-graphite-muted">{cap === 0n ? "A zero cap pauses the agent." : `${pct.toFixed(0)}% of today's cap used. At the cap the agent pauses.`}</p>
      </div>
      <div>
        <p className="label mb-3">Budget tier now</p>
        <TierMeter tier={status.budget.tier} reason={status.budget.reason} tone="graphite" />
      </div>
    </div>
  );
}

function Stage({ n, title, caption, children }: { n: number; title: string; caption?: string; children: ReactNode }) {
  return (
    <li className="relative pl-11">
      <span className="num absolute left-0 top-0 grid size-7 place-items-center rounded-full border border-rule-2 bg-paper text-[12px] text-ink">{n}</span>
      <h2 className="text-[20px] font-medium leading-7">{title}</h2>
      <div className="mt-3">{children}</div>
      {caption ? <p className="num mt-2 text-[12px] text-muted">{caption}</p> : null}
    </li>
  );
}

const Rows = ({ children }: { children: ReactNode }) => <ul className="divide-y divide-rule overflow-hidden rounded-card border border-rule bg-panel">{children}</ul>;

function EmptyBlock({ title, next }: { title: string; next: string }) {
  return (
    <div className="rounded-card border border-dashed border-rule-2 bg-panel px-4 py-5">
      <p className="text-[15px] font-medium text-ink">{title}</p>
      <p className="mt-1 text-[14px] text-muted">{next}</p>
    </div>
  );
}

function FillsRows({ loop, query, nowMs }: { loop: Loop; query: ReturnType<typeof useFills>; nowMs: number }) {
  if (query.isPending) return <div aria-busy="true" className="space-y-2">{[0, 1].map((i) => <div key={i} className="skeleton h-16 w-full" />)}</div>;
  if (query.isError) {
    return (
      <Alert tone="danger">
        <AlertTitle>The fills could not be read from Base.</AlertTitle>
        <AlertBody>{query.error.message.split("\n")[0]}</AlertBody>
        <Button variant="secondary" size="sm" className="mt-3" onClick={() => void query.refetch()}><RefreshCw className="size-4" aria-hidden />Read again</Button>
      </Alert>
    );
  }
  if (loop.fills.length === 0) {
    return <EmptyBlock title="No outside swap has filled against this strategy in this window." next="The first taker who swaps against a fresh signed price shows up here with the transaction. Their fee is what starts the loop." />;
  }
  const sym = (addr: string) => (addr.toLowerCase() === TOKENS.W0G.address.toLowerCase() ? TOKENS.W0G : TOKENS.USDC);
  return (
    <Rows>
      {loop.fills.map((f) => {
        const a = sym(f.tokenIn);
        const b = sym(f.tokenOut);
        return (
          <EvidenceRow
            key={`${f.txHash}-${f.amountIn}`}
            title={`${formatAmount(f.amountIn, a.decimals, 6)} ${a.symbol} for ${formatAmount(f.amountOut, b.decimals, 6)} ${b.symbol}`}
            plain={<>Taker <span className="num text-[13px]">{truncateHex(f.taker, 6, 4)}</span> filled against a signed price.</>}
            hash={f.txHash}
            hashLabel="fill transaction"
            href={txUrl(BASE_CHAIN_ID, f.txHash)}
            chainId={BASE_CHAIN_ID}
            timeMs={f.timeMs}
            nowMs={nowMs}
          />
        );
      })}
    </Rows>
  );
}

function PriceRows({ status, orderHash, nowMs }: { status: AgentStatus; orderHash: string | null; nowMs: number }) {
  const quotes = [...status.quotes].sort((a, b) => Number(BigInt(b.expiry) - BigInt(a.expiry)));
  return (
    <Rows>
      <EvidenceRow
        title="Aqua order on the router"
        plain={<>Maker <span className="num text-[13px]">{truncateHex(status.order.maker, 6, 4)}</span> holds W0G and USDC in this order. It settles a fill only against a fresh price signed by agent <span className="num text-[13px]">{truncateHex(status.agent, 6, 4)}</span>.</>}
        hash={orderHash ?? undefined}
        hashLabel="order hash"
        chainId={BASE_CHAIN_ID}
        nowMs={nowMs}
      />
      {quotes.length === 0 ? (
        <li className="px-4 py-4">
          <p className="text-[15px] font-medium text-ink">No signed price yet.</p>
          <p className="mt-0.5 text-[14px] text-muted">{reasonText(status.budget.reason)} The agent signs a price for each direction after an AI run, and each one lands here with its posting transaction.</p>
        </li>
      ) : quotes.map((q) => <PriceRow key={`${q.inferenceId}-${q.expiry}`} q={q} nowMs={nowMs} />)}
    </Rows>
  );
}

function PriceRow({ q, nowMs }: { q: AgentStatus["quotes"][number]; nowMs: number }) {
  const postedAt = usePostedAt(q.postedTx);
  const direction = directionOf(q);
  const price = direction ? impliedPrice(direction, BigInt(q.rateE18)) : Number.NaN;
  const expiryMs = Number(q.expiry) * 1000;
  const left = secondsLeft(Number(q.expiry), nowMs / 1000);
  const what = direction === "buy-w0g" ? `Buy price: 1 W0G costs ${formatPrice(price)} USDC` : direction === "sell-w0g" ? `Sell price: 1 W0G pays ${formatPrice(price)} USDC` : "Price for an unknown pair";
  const source = q.requestId === "price-only" ? "Signed from the Uniswap pool mid, with no AI run behind it." : <>Signed after AI run <span className="num text-[13px]">{truncateHex(q.requestId, 10, 6)}</span>.</>;
  return (
    <EvidenceRow
      title={<>{what} <span className={cn("num ml-1 text-[12px] font-normal", left > 0 ? "text-ok-ink" : "text-danger-ink")}>{left > 0 ? `expires in ${clock(left)}` : `expired ${relativeTime(expiryMs, nowMs)}`}</span></>}
      plain={source}
      hash={q.postedTx}
      hashLabel="posting transaction"
      href={q.postedTx ? txUrl(BASE_CHAIN_ID, q.postedTx) : null}
      chainId={BASE_CHAIN_ID}
      timeMs={postedAt ? postedAt * 1000 : null}
      nowMs={nowMs}
    />
  );
}

function FeesRow({ loop }: { loop: Loop }) {
  const none = loop.accruedUsdc === 0n && loop.accruedW0g === 0n;
  if (none) return <EmptyBlock title="No fees collected yet." next="Every fill leaves a fee in the strategy. Once fills arrive, the total shows here before the agent turns it into 0G." />;
  return (
    <Rows>
      <li className="grid grid-cols-1 gap-2 px-4 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
        <div>
          <p className="text-[15px] font-medium text-ink">Fees accrued by the agent</p>
          <p className="mt-0.5 text-[14px] text-muted">The running total of fees takers have paid, split by token. This is the money the next funding step spends.</p>
        </div>
        <p className="num text-right text-[20px] text-ink md:text-[28px]">
          {formatAmount(loop.accruedUsdc, 6, 6)} <span className="text-[13px] text-muted">USDC</span>
          <span className="mx-2 text-muted">+</span>
          {formatAmount(loop.accruedW0g, 18, 4)} <span className="text-[13px] text-muted">W0G</span>
        </p>
      </li>
    </Rows>
  );
}

function FundingRows({ loop, threshold, nowMs }: { loop: Loop; threshold: string | null; nowMs: number }) {
  if (loop.funding.length === 0) {
    const steps = "the agent swaps them to 0G on Uniswap, sends them over the CCIP bridge to the 0G chain, unwraps them and deposits them for AI runs. Each step appears here with its transaction.";
    if (!threshold) return <EmptyBlock title="No funding step recorded yet." next={`When accrued fees reach the agent's funding threshold, ${steps}`} />;
    const need = parseUnits(threshold, TOKENS.USDC.decimals);
    const pct = percentOf(loop.accruedUsdc, need);
    return (
      <div className="rounded-card border border-dashed border-rule-2 bg-panel px-4 py-5">
        <p className="text-[15px] font-medium text-ink">No funding step yet. The first one runs when accrued fees reach {threshold} USDC.</p>
        <p className="mt-1 text-[14px] text-muted">Then {steps}</p>
        <div className="mt-4 h-1.5 overflow-hidden rounded-sm bg-sunken" role="progressbar" aria-label="Accrued fees against the funding threshold" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
          <div className="h-full rounded-sm bg-accent" style={{ width: `${pct}%` }} />
        </div>
        <p className="num mt-2 text-[13px] text-ink-2">{formatAmount(loop.accruedUsdc, TOKENS.USDC.decimals, 6)} of {threshold} USDC accrued ({pct.toFixed(pct < 1 ? 2 : 0)}%)</p>
      </div>
    );
  }
  return (
    <Rows>
      {loop.funding.map((s) => {
        const info = describeStep(s.step);
        return (
          <EvidenceRow
            key={`${s.txHash}-${s.step}`}
            title={<>{info.title} <span className="num text-[12px] font-normal text-muted">({info.tech})</span></>}
            plain={info.plain}
            hash={s.txHash}
            hashLabel="funding transaction"
            href={txUrl(s.chainId, s.txHash)}
            chainId={s.chainId}
            timeMs={toMillis(s.time)}
            nowMs={nowMs}
          />
        );
      })}
    </Rows>
  );
}

function RunRows({ loop, nowMs }: { loop: Loop; nowMs: number }) {
  if (loop.inferences.length === 0) {
    return <EmptyBlock title="No AI run has been paid yet." next="The agent buys an AI run each time it needs a new price. Each run's request id lands here, so you can match a signed price on the swap page to the money that paid for it." />;
  }
  return (
    <Rows>
      {loop.inferences.map((r) => {
        const cost = r.costWei === null ? null : BigInt(r.costWei);
        return (
          <EvidenceRow
            key={r.requestId}
            title="AI run paid"
            plain={<><span className="num text-[13px]">{r.model}</span>, {cost === null || cost === 0n ? "cost not metered by the router" : `cost ${formatAmount(cost, 18, 6)} 0G`}.</>}
            hash={r.requestId}
            hashLabel="AI request id"
            chainId={16661}
            timeMs={toMillis(r.time)}
            nowMs={nowMs}
          />
        );
      })}
    </Rows>
  );
}

function TierHistory({ history, current }: { history: ReturnType<typeof useTierHistory>; current: AgentStatus["budget"] }) {
  const entries = [...history].reverse();
  return (
    <section aria-label="Tier changes seen by this browser" className="mt-14 border-t border-rule pt-8">
      <h2 className="text-[20px] font-medium">Tier changes this browser has seen</h2>
      <p className="mt-1 max-w-[62ch] text-[14px] text-muted">The agent reports only its current tier. This list starts the first time this browser opened the page and adds a line whenever the tier changes.</p>
      {entries.length === 0 ? (
        <p className="mt-4 text-[14px] text-muted">Reading the first tier.</p>
      ) : (
        <ul className="mt-4 divide-y divide-rule overflow-hidden rounded-card border border-rule bg-panel">
          {entries.map((e, i) => (
            <li key={`${e.atMs}-${e.tier}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <TierChip tier={e.tier} />
              <span className="min-w-0 flex-1 text-[14px] text-ink-2">{reasonText(i === 0 ? current.reason : e.reason)}</span>
              <time className="num text-[12px] text-muted" dateTime={new Date(e.atMs).toISOString()}>{i === 0 ? "now, since " : ""}{utcStamp(e.atMs)}</time>
            </li>
          ))}
        </ul>
      )}
      {entries.length === 1 ? <p className="mt-3 text-[13px] text-muted">No change seen yet. If the agent moves to a different tier while this page is open, it is added here.</p> : null}
    </section>
  );
}

function RailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the agent's records" className="space-y-10">
      {[0, 1, 2].map((i) => <div key={i} className="pl-11"><div className="skeleton mb-3 h-6 w-64" /><div className="skeleton h-20 w-full" /></div>)}
    </div>
  );
}
