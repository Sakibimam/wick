"use client";

import { useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Alert, AlertBody, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/copy-link";
import { EvidenceRow } from "@/components/evidence-row";
import { Chronogram } from "@/components/chronogram";
import { CountBadge, MarkTips } from "@/components/mark-tips";
import { SourceNote } from "@/components/source-note";
import { Amount, ChainChip, Tk } from "@/components/token-mark";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { useFills } from "@/hooks/use-fills";
import { usePostedAt } from "@/hooks/use-posted-at";
import { AgentError } from "@/lib/agent-api";
import { cluster } from "@/lib/cluster";
import { BASE_CHAIN_ID, FILL_LOOKBACK_BLOCKS, TOKENS, ZERO_G_CHAIN_ID } from "@/lib/config";
import { economicsOf, fillEconomics, runCost, runsOf, takersOf, type Economics, type Run } from "@/lib/economics";
import { countdown, fmt0g, fmtBlock, fmtPct, fmtPrice, fmtUnits, fmtUsd, fmtUsdc, relativeTime, shortHash, significant, toNumber, utcStamp } from "@/lib/format";
import { describeStep, toMillis, txUrl } from "@/lib/funding";
import { buildLoop, loopSentence, type Fill, type Loop } from "@/lib/ledger";
import { directionOf, impliedPrice } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { reasonText, TIERS } from "@/lib/tiers";
import { cn } from "@/lib/utils";

type Spine = "base" | "zg" | "cross";

export function LedgerPage() {
  const status = useAgentStatus();
  const { now } = useChainNow();
  const nowMs = now * 1000;
  const fills = useFills(status.data?.order);
  const loop = useMemo(() => (status.data ? buildLoop(status.data, fills.data?.fills ?? []) : null), [status.data, fills.data?.fills]);
  const econ = useMemo(() => (status.data ? economicsOf(status.data) : null), [status.data]);

  return (
    <>
      <div className="mx-auto max-w-[1312px] px-4 pt-12 sm:px-6 lg:px-12 lg:pt-16">
        <h1 className="max-w-[18ch] text-[40px] sm:text-[52px]">The loop, unrolled</h1>
        <p className="mt-3 max-w-[62ch] text-[16px] text-ink-2" aria-live="polite">
          {loop ? <Tk>{loopSentence(loop)}</Tk> : status.isError ? "The agent is not answering, so the loop cannot be traced right now." : <span aria-hidden className="skeleton block h-5 w-[52ch] max-w-full" />}
        </p>
        {status.data && econ && loop ? <StatStrip status={status.data} econ={econ} loop={loop} nowMs={nowMs} /> : status.isPending ? <div aria-hidden className="skeleton mt-8 h-[76px] w-full" /> : null}
      </div>

      <div className="mt-10">
        <GaugeBand status={status.data} fills={fills.data?.fills ?? []} nowMs={nowMs} loading={status.isPending} error={status.isError && !status.data ? status.error : null} onRetry={() => void status.refetch()} />
      </div>

      <div className="mx-auto max-w-[1312px] px-4 pb-10 pt-14 sm:px-6 lg:px-12 lg:pb-12 lg:pt-20">
        {status.isPending ? <RailSkeleton /> : loop && status.data && econ ? (
          <ol className="relative space-y-16 before:absolute before:bottom-3 before:left-[6px] before:top-3 before:w-0.5 before:bg-rule" aria-label="The money loop in order">
            <Stage spine="base" name="Signed price" lit={status.data.quotes.length > 0} title="The agent shipped its order and signed prices" source={`QuotePosted events and getQuote on the AgentQuoteBoard, Base block ${status.data.readAt ? fmtBlock(status.data.readAt.baseBlock) : "latest"}. Order hash read from the router.`}>
              <PriceRows status={status.data} orderHash={fills.data?.orderHash ?? null} nowMs={nowMs} />
            </Stage>
            <Stage spine="base" name="Aqua pool" lit={loop.fills.length > 0} title="Swaps filled against the strategy" source={fills.data ? `Swapped events of the AquaSwapVMRouter from Base block ${fmtBlock(fills.data.fromBlock)} to ${fmtBlock(fills.data.toBlock)}, matched on maker and order hash.` : `Read from the last ${fmtBlock(FILL_LOOKBACK_BLOCKS)} Base blocks.`}>
              <FillsRows status={status.data} loop={loop} query={fills} nowMs={nowMs} />
            </Stage>
            <Stage spine="base" name="Fees" lit={econ.feesEarnedUsdc > 0} title="What the fills earned, against what the AI cost" source={status.data.strategy ? `Each fill pays ${(status.data.strategy.feeBps / 100).toFixed(2)}% of its input. AI spend is each run's billed cost from the router's x_0g_trace.billing, priced at the Uniswap mid.` : undefined}>
              <FeesBlock econ={econ} status={status.data} />
            </Stage>
            <Stage spine="cross" name="Gas, bridge, unwrap, deposit" lit={loop.funding.length > 0} title={`${loop.funding.length} transactions carried money from Base to the AI account on 0G`} source="LI.FI gas leg, CCIP send of W0G, W0G withdraw on 0G, depositFor on the Payment Layer, and the router drawing on that balance.">
              <FundingRows loop={loop} threshold={econ.fundingThresholdUsdc} nowMs={nowMs} />
            </Stage>
            <Stage spine="zg" name="0G compute" lit={loop.inferences.length > 0} title={`${loop.inferences.length} AI runs billed by the 0G router`} source="Billed cost and currency from each run's x_0g_trace.billing block; USD equivalents at the Uniswap pool mid.">
              <RunTable status={status.data} nowMs={nowMs} />
            </Stage>
          </ol>
        ) : null}
      </div>
    </>
  );
}

function GaugeBand({ status, fills, nowMs, loading, error, onRetry }: { status: AgentStatus | undefined; fills: Fill[]; nowMs: number; loading: boolean; error: Error | null; onRetry: () => void }) {
  return (
    <section aria-label="Every recorded event" className="bg-lane">
      <div className="mx-auto max-w-[1312px] px-4 py-10 sm:px-6 lg:px-12 lg:py-12">
        {loading ? (
          <div aria-busy="true" className="space-y-4"><div className="skeleton h-[172px] w-full" /><div className="skeleton h-4 w-2/3" /></div>
        ) : error ? (
          <div role="alert" className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <p className="text-[20px] font-semibold text-ink">{error instanceof AgentError && error.kind === "unreachable" ? "The agent is not answering." : "The agent's answer could not be read."}</p>
              <p className="mt-2 text-[13px] text-muted">{error.message}</p>
            </div>
            <Button variant="secondary" onClick={onRetry}><RefreshCw className="size-4" aria-hidden />Try again</Button>
          </div>
        ) : status ? <GaugeLive status={status} fills={fills} nowMs={nowMs} /> : null}
      </div>
    </section>
  );
}

function GaugeLive({ status, fills, nowMs }: { status: AgentStatus; fills: Fill[]; nowMs: number }) {
  const meta = TIERS[status.budget.tier];
  return (
    <div>
      <Chronogram status={status} fills={fills} nowMs={nowMs} />
      <ul className="mt-8 flex flex-wrap gap-2 text-[13px]" aria-label="Agent budget">
        <li className={cn("inline-flex items-center gap-2 rounded-control bg-paper px-3 py-1.5 font-semibold text-ink", `tone-${meta.tone}`)}><span className="size-2 rounded-full bg-[var(--tone)]" aria-hidden />{meta.label} tier</li>
        {status.budget.model ? <li className="num rounded-control bg-paper px-3 py-1.5 text-ink-2">model {status.budget.model}</li> : null}
        <li className="rounded-control bg-paper px-3 py-1.5 text-ink-2">fuel <Amount value={fmt0g(toNumber(status.budget.computeBalanceWei, "0G"))} symbol="0G" size={14} className="text-ink" /></li>
        <li className="num rounded-control bg-paper px-3 py-1.5 text-ink-2">spent today {fmt0g(toNumber(status.budget.spentTodayWei, "0G"))} of {fmt0g(toNumber(status.budget.spendCapPerDayWei, "0G"))} <Tk>0G</Tk></li>
        {status.readAt ? <li className="num rounded-control bg-paper px-3 py-1.5 text-muted"><Tk>0G</Tk> block {fmtBlock(status.readAt.zeroGBlock)}</li> : null}
      </ul>
      <p className="mt-3 max-w-[75ch] text-[14px] text-muted">{meta.consequence}</p>
    </div>
  );
}

const SPINE: Record<Spine, string> = {
  base: "chain-base border-[var(--chain)] bg-[var(--chain)]",
  zg: "chain-zg border-[var(--chain)] bg-[var(--chain)]",
  cross: "border-[var(--color-chain-base)] bg-[var(--color-chain-zg)]",
};

function Stage({ spine, name, lit, title, source, children }: { spine: Spine; name: string; lit: boolean; title: string; source?: string; children: ReactNode }) {
  return (
    <li className="relative pl-10">
      <span aria-hidden className={cn("absolute left-0 top-1 size-3.5 rounded-full border-2", lit ? SPINE[spine] : "border-rule-2 bg-paper")} />
      <p className="station flex flex-wrap items-center gap-3 text-muted">
        <Tk>{name}</Tk>
        {source ? <SourceNote className="font-sans normal-case tracking-normal">{source}</SourceNote> : null}
      </p>
      <h2 className="mt-1 text-[28px]"><Tk>{title}</Tk></h2>
      <div className="mt-4">{children}</div>
    </li>
  );
}

const Rows = ({ children }: { children: ReactNode }) => <ul className="divide-y divide-rule overflow-hidden rounded-card bg-panel">{children}</ul>;

function EmptyBlock({ title, next }: { title: string; next: string }) {
  return (
    <div className="rounded-card border border-dashed border-rule-2 px-4 py-5">
      <p className="text-[15px] font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[14px] text-muted">{next}</p>
    </div>
  );
}

function FillsRows({ status, loop, query, nowMs }: { status: AgentStatus; loop: Loop; query: ReturnType<typeof useFills>; nowMs: number }) {
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
    return <EmptyBlock title="The first outside swap lands here." next="Every taker who swaps against a fresh signed price shows up with the transaction and the fee it paid." />;
  }
  const takers = takersOf(status, loop.fills);
  return (
    <div>
      <p className="mb-3 text-[14px] text-ink-2"><span className="num text-ink">{takers.distinct}</span> distinct {takers.distinct === 1 ? "taker" : "takers"}, <span className="num text-ink">{takers.outside}</span> outside the agent</p>
      <Rows>
        {loop.fills.map((f) => {
          const inSym = f.tokenIn.toLowerCase() === TOKENS.W0G.address.toLowerCase() ? "W0G" : "USDC";
          const outSym = inSym === "W0G" ? "USDC" : "W0G";
          const e = fillEconomics(f, status);
          return (
            <EvidenceRow
              key={`${f.txHash}-${f.amountIn}`}
              title={<>{e.seed ? "Seed fill (agent)" : "Outside fill"} <span className="num ml-1 text-[13px] font-normal text-muted">{shortHash(f.taker)}</span></>}
              plain={<>Paid {fmtUnits(f.amountIn, inSym)} <Tk>{inSym}</Tk> for {fmtUnits(f.amountOut, outSym)} <Tk>{outSym}</Tk>{e.decisionsFunded !== null ? `, enough fee for ${significant(e.decisionsFunded, 2)} AI decisions` : ""}.</>}
              amount={e.feeUsdc !== null ? <Amount value={fmtUsdc(e.feeUsdc)} symbol="USDC" size={14} /> : null}
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
    </div>
  );
}

function PriceRows({ status, orderHash, nowMs }: { status: AgentStatus; orderHash: string | null; nowMs: number }) {
  const quotes = [...status.quotes].sort((a, b) => Number(BigInt(b.expiry) - BigInt(a.expiry)));
  const live = quotes.filter((q) => Number(q.expiry) * 1000 > nowMs);
  const old = quotes.filter((q) => Number(q.expiry) * 1000 <= nowMs);
  // With nothing live, the newest pair still leads as the latest price; only the rest fold away as earlier.
  const latest = live.length ? [] : old.filter((q) => q.expiry === old[0]?.expiry);
  const earlier = old.filter((q) => !latest.includes(q));
  return (
    <div>
      <p className="mb-3 text-[14px] text-ink-2"><span className="num text-ink">{quotes.length}</span> signed prices{live.length ? <>, <span className="num text-ink">{live.length}</span> live</> : null}</p>
      <Rows>
        <EvidenceRow
          title="Aqua order on the router"
          plain={<>Maker <span className="num text-[13px]">{shortHash(status.order.maker)}</span> holds <Tk>W0G</Tk> and USDC in this order. It fills only against a fresh price signed by the agent.</>}
          amount={status.strategy ? <span className="flex flex-col items-start gap-0.5 md:items-end"><Amount value={fmtUnits(status.strategy.w0g, "W0G")} symbol="W0G" size={14} /><Amount value={fmtUnits(status.strategy.usdc, "USDC")} symbol="USDC" size={14} /></span> : null}
          hash={orderHash ?? undefined}
          hashLabel="order hash"
          chainId={BASE_CHAIN_ID}
          nowMs={nowMs}
        />
        {quotes.length === 0 ? (
          <li className="px-4 py-4">
            <p className="text-[15px] font-medium text-ink">The next signed price lands here.</p>
            <p className="mt-0.5 text-[14px] text-muted">{reasonText(status.budget.reason)} The agent signs a price for each side after an AI run, and each one lands here with its posting transaction.</p>
          </li>
        ) : (
          <>
            {(live.length ? live : latest).map((q) => <PriceRow key={`${q.inferenceId}-${q.expiry}`} q={q} nowMs={nowMs} />)}
            {earlier.length > 0 ? (
              <li>
                <details className="group">
                  <summary className="cursor-pointer list-none px-4 py-3.5 text-[15px] text-ink-2 transition-colors duration-150 hover:bg-sunken">
                    <span className="num text-ink">{earlier.length}</span> earlier prices, each expired and replaced <span className="text-muted group-open:hidden">(show)</span>
                  </summary>
                  <ul className="divide-y divide-rule border-t border-rule">
                    {earlier.map((q) => <PriceRow key={`${q.inferenceId}-${q.expiry}`} q={q} nowMs={nowMs} />)}
                  </ul>
                </details>
              </li>
            ) : null}
          </>
        )}
      </Rows>
    </div>
  );
}

function PriceRow({ q, nowMs }: { q: AgentStatus["quotes"][number]; nowMs: number }) {
  const postedAt = usePostedAt(q.postedTx);
  const direction = directionOf(q);
  const price = direction ? impliedPrice(direction, BigInt(q.rateE18)) : Number.NaN;
  const left = Math.floor(Number(q.expiry) - nowMs / 1000);
  const side = direction === "buy-w0g" ? { name: "Ask", who: "you buy W0G", cls: "ask" } : direction === "sell-w0g" ? { name: "Bid", who: "you sell W0G", cls: "bid" } : null;
  const source = q.requestId === "price-only" ? "Signed from the Uniswap pool mid, with no AI run behind it." : q.requestId ? <>Signed after AI run <span className="num text-[13px]">{shortHash(q.requestId)}</span>.</> : "Signed by the agent from the pool mid.";
  return (
    <EvidenceRow
      title={side ? <span className={side.cls}><span className="text-[var(--tone)]">{side.name}</span> <span className="font-normal text-ink-2"><Tk>{side.who}</Tk></span> <span className={cn("num ml-1 text-[13px] font-normal", left > 0 ? "text-ok-ink" : "text-muted")}>{countdown(left)}</span></span> : "Price for another pair"}
      plain={source}
      amount={Number.isFinite(price) ? <span className="num">{fmtPrice(price)} <span className="text-[13px] text-muted">USDC</span></span> : null}
      hash={q.postedTx}
      hashLabel="posting transaction"
      href={q.postedTx ? txUrl(BASE_CHAIN_ID, q.postedTx) : null}
      chainId={BASE_CHAIN_ID}
      timeMs={postedAt ? postedAt * 1000 : null}
      nowMs={nowMs}
    />
  );
}

/** Fees as the stage's headline number, then what they cover and how far they are from the next funding run. */
function FeesBlock({ econ, status }: { econ: Economics; status: AgentStatus }) {
  const toThreshold = econ.fundingThresholdUsdc ? Math.min(1, econ.feesEarnedUsdc / econ.fundingThresholdUsdc) : null;
  return (
    <div className="grid grid-cols-1 gap-8 rounded-card bg-panel p-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:gap-12">
      <div>
        <p className="label">Fees earned</p>
        <p className="mt-2 font-display text-[64px] font-semibold leading-none text-ink lg:text-[88px]"><Amount value={fmtUsdc(econ.feesEarnedUsdc)} symbol="USDC" size={28} unitClassName="text-[24px]" /></p>
      </div>
      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-3">
        <div>
          <dt className="label">AI spent</dt>
          <dd className="num mt-1 text-[22px] text-ink">{fmtUsd(econ.aiSpentUsd)}</dd>
          <dd className="text-[13px] text-muted">{status.inferences.length} runs</dd>
        </div>
        <div className="tone-ok">
          <dt className="label">Coverage</dt>
          <dd className="num mt-1 text-[22px] text-ink">{econ.coverage !== null ? fmtPct(econ.coverage * 100) : "n/a"}</dd>
          {econ.coverage !== null ? <dd className="mt-1.5 h-1 overflow-hidden rounded-[2px] bg-sunken"><span className="block h-full origin-left bg-[var(--tone)]" style={{ transform: `scaleX(${Math.min(1, econ.coverage)})` }} /></dd> : null}
        </div>
        <div>
          <dt className="label">Next funding run</dt>
          <dd className="num mt-1 text-[22px] text-ink">{econ.fundingThresholdUsdc !== null ? `${fmtUsdc(econ.fundingThresholdUsdc)} USDC` : "n/a"}</dd>
          {toThreshold !== null ? <dd className="num text-[13px] text-muted">{fmtPct(toThreshold * 100)} of the way there</dd> : null}
        </div>
      </dl>
    </div>
  );
}

function FundingRows({ loop, threshold, nowMs }: { loop: Loop; threshold: number | null; nowMs: number }) {
  if (loop.funding.length === 0) {
    return <EmptyBlock title={`The first funding run starts at ${threshold !== null ? `${fmtUsdc(threshold)} USDC` : "the threshold"} of fees.`} next="Fees swap to 0G on Uniswap, cross to the 0G chain over CCIP, unwrap, and land in the AI account. Each step appears here with its transaction." />;
  }
  return (
    <Rows>
      {loop.funding.map((s) => {
        const info = describeStep(s.step);
        return (
          <EvidenceRow
            key={`${s.txHash}-${s.step}`}
            title={<Tk>{info.title}</Tk>}
            plain={<Tk>{info.plain}</Tk>}
            hash={s.txHash}
            hashLabel="funding transaction"
            href={txUrl(s.chainId, s.txHash)}
            extra={info.kind === "bridge" ? { href: `https://ccip.chain.link/tx/${s.txHash}`, label: "CCIP explorer" } : null}
            chainId={s.chainId}
            timeMs={toMillis(s.time)}
            nowMs={nowMs}
          />
        );
      })}
    </Rows>
  );
}

/** Every billed run in one compact table, cost in 0G with its USD equivalent, under a sparkline of what each run cost. */
function RunTable({ status, nowMs }: { status: AgentStatus; nowMs: number }) {
  const runs = runsOf(status);
  if (runs.length === 0) return <EmptyBlock title="The first billed AI run lands here." next="Each run's request id appears with its cost, so a signed price on the swap page can be matched to the money that paid for it." />;
  const hasDecision = runs.some((r) => r.raw.reason || r.raw.skewBps != null);
  return (
    <div className="overflow-hidden rounded-card bg-panel">
      <CostSpark runs={runs} nowMs={nowMs} />
      <ul className="divide-y divide-rule border-t border-rule md:hidden">
        {runs.map((r) => (
          <li key={r.requestId} className="space-y-1 px-4 py-3 text-[14px]">
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-ink">{r.cost0g !== null ? <Amount value={fmt0g(r.cost0g)} symbol="0G" size={14} /> : "n/a"}</span>
              <span className="num text-ink-2">{r.costUsd !== null ? fmtUsd(r.costUsd) : "n/a"}{r.billedIn === "usd" ? <span className="ml-2 rounded-control bg-sunken px-1.5 py-0.5 text-[12px] text-muted">billed in USD</span> : null}</span>
            </p>
            <p className="num text-[13px] text-muted">{r.atMs ? relativeTime(r.atMs, nowMs) : "time n/a"}{r.model ? `, ${r.model}` : ""}{r.raw.reason ? `, ${r.raw.reason}` : ""}</p>
            <CopyLink value={r.requestId} label="AI request id" />
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full min-w-[640px] border-collapse text-[14px]">
          <thead>
            <tr className="border-y border-rule text-left text-[13px] text-muted">
              <th scope="col" className="px-4 py-2.5 font-medium">When</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Model</th>
              {hasDecision ? <th scope="col" className="px-4 py-2.5 font-medium">Decision</th> : null}
              <th scope="col" className="px-4 py-2.5 text-right font-medium">Cost</th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">USD</th>
              <th scope="col" className="px-4 py-2.5 font-medium">Request id</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {runs.map((r) => (
              <tr key={r.requestId} className="transition-colors duration-150 hover:bg-sunken">
                <td className="num whitespace-nowrap px-4 py-2.5 text-ink-2" title={r.atMs ? utcStamp(r.atMs) : undefined}>{r.atMs ? relativeTime(r.atMs, nowMs) : "n/a"}</td>
                <td className="num px-4 py-2.5 text-ink-2">{r.model ?? <span className="rounded-control bg-sunken px-1.5 py-0.5 text-[12px] text-muted">router default</span>}</td>
                {hasDecision ? <td className="px-4 py-2.5 text-ink-2">{[r.raw.reason, r.raw.skewBps != null ? `skew ${r.raw.skewBps} bps` : null].filter(Boolean).join(", ") || <span className="text-muted">n/a</span>}</td> : null}
                <td className="whitespace-nowrap px-4 py-2.5 text-right text-ink">{r.cost0g !== null ? <Amount value={fmt0g(r.cost0g)} symbol="0G" size={14} /> : "n/a"}</td>
                <td className="num whitespace-nowrap px-4 py-2.5 text-right text-ink-2">
                  {r.costUsd !== null ? fmtUsd(r.costUsd) : "n/a"}
                  {r.billedIn === "usd" ? <span className="ml-2 rounded-control bg-sunken px-1.5 py-0.5 text-[12px] text-muted">billed in USD</span> : null}
                </td>
                <td className="px-4 py-2.5"><CopyLink value={r.requestId} label="AI request id" /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="flex items-center gap-2 border-t border-rule px-4 py-2.5 text-[13px] text-muted"><ChainChip chainId={ZERO_G_CHAIN_ID} /> billed from the Payment Layer balance. Each run is keyed by its router request id.</p>
    </div>
  );
}

/** Cost per run over time; runs close together draw as one point with a count. */
function CostSpark({ runs, nowMs }: { runs: Run[]; nowMs: number }) {
  const pts = runs.filter((r) => r.atMs !== null && r.costUsd !== null);
  if (pts.length < 2) return null;
  const t0 = Math.min(...pts.map((r) => r.atMs!)), t1 = Math.max(nowMs, ...pts.map((r) => r.atMs!));
  const max = Math.max(...pts.map((r) => r.costUsd!));
  const W = 600, H = 72, pad = 10;
  const fx = (r: Run) => (r.atMs! - t0) / Math.max(1, t1 - t0);
  const groups = cluster(pts, fx, 0.03);
  const y = (usd: number) => H - pad - (usd / max) * (H - pad * 2);
  const ordered = [...pts].sort((a, b) => a.atMs! - b.atMs!);
  const line = ordered.map((r, i) => `${i ? "L" : "M"}${(fx(r) * W).toFixed(1)} ${y(r.costUsd!).toFixed(1)}`).join(" ");
  return (
    <figure className="px-4 pb-2 pt-4">
      <figcaption className="label flex justify-between"><span>Cost per run, USD</span><span className="num">max {fmtUsd(max)}</span></figcaption>
      <div className="relative mt-2">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-[72px] w-full overflow-visible" role="img" aria-label={`Cost of ${pts.length} AI runs over time`}>
          <path d={line} fill="none" className="chain-zg stroke-[var(--chain)]" strokeWidth={2} vectorEffect="non-scaling-stroke" />
        </svg>
        <svg viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-[72px] w-full overflow-visible" preserveAspectRatio="none" aria-hidden>
          {groups.map((g, i) => {
            const avg = g.items.reduce((a, r) => a + r.costUsd!, 0) / g.items.length;
            return <circle key={i} cx={g.x * W} cy={y(avg)} r={3.5} className="chain-zg fill-[var(--chain)]" vectorEffect="non-scaling-stroke" />;
          })}
        </svg>
        <svg className="pointer-events-none absolute inset-0 h-[72px] w-full overflow-visible" aria-hidden>
          {groups.map((g, i) => <CountBadge key={i} x={`${g.x * 100}%`} y={8} n={g.items.length} />)}
        </svg>
        <MarkTips clusters={groups} y={36} label={(it) => `${it.length} AI ${it.length === 1 ? "run" : "runs"}, show cost`} render={(r) => (
          <div className="space-y-0.5">
            <p className="num text-ink">{runCost(r)}</p>
            <p className="num text-muted">{r.atMs ? utcStamp(r.atMs) : ""}</p>
            <CopyLink value={r.requestId} label="AI request id" />
          </div>
        )} />
      </div>
    </figure>
  );
}

function RailSkeleton() {
  return (
    <div aria-busy="true" aria-label="Reading the agent's records" className="space-y-10">
      {[0, 1, 2].map((i) => <div key={i} className="pl-10"><div className="skeleton mb-3 h-6 w-64" /><div className="skeleton h-20 w-full" /></div>)}
    </div>
  );
}

/** The ledger's figures at a glance, each labelled, before the rows that prove them. */
function StatStrip({ status, econ, loop, nowMs }: { status: AgentStatus; econ: Economics; loop: Loop; nowMs: number }) {
  const last = econ.lastRun ?? runsOf(status)[0] ?? null;
  const cells: { k: string; v: ReactNode }[] = [
    { k: "Fees earned", v: <Amount value={fmtUsdc(econ.feesEarnedUsdc)} symbol="USDC" size={16} /> },
    { k: "AI spent", v: fmtUsd(econ.aiSpentUsd) },
    { k: "Fees against AI", v: econ.coverage !== null ? fmtPct(econ.coverage * 100) : "n/a" },
    { k: "Funding transactions", v: String(loop.funding.length) },
    { k: "Billed AI runs", v: String(loop.inferences.length) },
    { k: "Last run", v: last?.atMs ? relativeTime(last.atMs, nowMs) : "n/a" },
  ];
  return (
    <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-5 border-y border-rule py-5 sm:grid-cols-3 lg:grid-cols-6">
      {cells.map((c) => (
        <div key={c.k}>
          <dt className="label">{c.k}</dt>
          <dd className="num mt-1 text-[24px] leading-tight text-ink">{c.v}</dd>
        </div>
      ))}
    </dl>
  );
}
