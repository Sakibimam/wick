"use client";

import { useMemo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { DecisionFacts, OutcomeChip } from "@/components/decision";
import { Alert, AlertBody, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyLink, CurlBox } from "@/components/copy-link";
import { EvidenceRow } from "@/components/evidence-row";
import { Chronogram } from "@/components/chronogram";
import { CountBadge, MarkTips } from "@/components/mark-tips";
import { SourceNote } from "@/components/source-note";
import { Amount, ChainChip, ProtocolIcon, Tk } from "@/components/token-mark";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { useFills } from "@/hooks/use-fills";
import { usePostedAt } from "@/hooks/use-posted-at";
import { AgentError } from "@/lib/agent-api";
import { cluster } from "@/lib/cluster";
import { BASE_CHAIN_ID, EXPLORERS, FILL_LOOKBACK_BLOCKS, QUOTES_API, TOKENS, V4_HOOK, ZERO_G_CHAIN_ID } from "@/lib/config";
import { useQuoteStats } from "@/hooks/use-quote-stats";
import { useGasRunway } from "@/hooks/use-post-cost";
import { economicsOf, fillEconomics, fillsToCover, fmtDecisions, presetUsdcUnits, runCost, runsOf, spendWindow, takersOf, type Economics, type Run } from "@/lib/economics";
import { countdown, fmt0g, fmtBlock, fmtPct, fmtPrice, fmtUnits, fmtUsd, fmtUsdc, relativeTime, shortHash, significant, toNumber, utcStamp } from "@/lib/format";
import { describeStep, toMillis, txUrl } from "@/lib/funding";
import { buildLoop, type Fill, type Loop } from "@/lib/ledger";
import { directionOf, impliedPrice, latestByDirection } from "@/lib/quotes";
import type { AgentStatus } from "@/lib/schema";
import { reasonText, TIERS } from "@/lib/tiers";
import { gist, humaniseReason, outcomeOf, type Outcome } from "@/lib/decision";
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
        {status.isError && !status.data ? <p className="mt-3 max-w-[62ch] text-[16px] text-ink-2" role="alert">The agent is not answering, so the loop cannot be traced right now.</p> : <p className="mt-3 max-w-[62ch] text-[16px] text-ink-2">Every transaction and AI run in the loop, in order, each linked to its chain.</p>}
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
              <PaidQuoteRow nowMs={nowMs} />
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
  const lastModel = runsOf(status)[0]?.model ?? status.budget.model;
  const tierModel = status.budget.model;
  const gas = useGasRunway(status);
  return (
    <div>
      <Chronogram status={status} fills={fills} nowMs={nowMs} />
      <ul className="mt-8 flex flex-wrap gap-2 text-[13px]" aria-label="Agent budget">
        <li className={cn("inline-flex items-center gap-2 rounded-control bg-paper px-3 py-1.5 font-semibold text-ink", `tone-${meta.tone}`)}><span className="size-2 rounded-full bg-[var(--tone)]" aria-hidden />{meta.label} tier</li>
        {lastModel ? <li className="num rounded-control bg-paper px-3 py-1.5 text-ink-2" title={tierModel && tierModel !== lastModel ? `The ${status.budget.tier.toLowerCase()} tier asks for ${tierModel}` : undefined}>{tierModel && tierModel !== lastModel ? `router served ${lastModel}` : `model ${lastModel}`}</li> : null}
        <li className="rounded-control bg-paper px-3 py-1.5 text-ink-2">fuel <Amount value={fmt0g(toNumber(status.budget.computeBalanceWei, "0G"))} symbol="0G" size={14} className="text-ink" /></li>
        {gas ? <li className={cn("num rounded-control bg-paper px-3 py-1.5", gas.days < 1 ? "text-warn-ink" : "text-ink-2")}>Base gas {significant(gas.days, 2)} days at {gas.perDay} posts a day</li> : null}
        <li className="num rounded-control bg-paper px-3 py-1.5 text-ink-2">{fmtPct(BigInt(status.budget.spendCapPerDayWei) > 0n ? (Number(status.budget.spentTodayWei) / Number(status.budget.spendCapPerDayWei)) * 100 : 0)} of the daily cap used</li>
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
  const hookAt = usePostedAt(V4_HOOK.poolInitTx);
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
      <p className="mb-3 text-[14px] text-ink-2">{takers.outside > 0 ? <><span className="num text-ink">{takers.outside}</span> outside {takers.outside === 1 ? "taker" : "takers"}{takers.seedFills ? `, after ${takers.seedFills} seed fill (agent)` : ""}</> : "Two doors for takers: the Aqua router and a Uniswap v4 pool. The agent opened the first with a seed fill."}</p>
      <Rows>
        <EvidenceRow
          title={<span className="inline-flex items-center gap-2"><ProtocolIcon protocol="uniswap" size={16} />Uniswap v4 pool routes into Wick</span>}
          plain="A hook on a Uniswap v4 pool sends its swaps to the same signed price, so any Uniswap router can fill against Wick."
          hash={V4_HOOK.poolInitTx}
          hashLabel="pool initialisation transaction"
          href={txUrl(BASE_CHAIN_ID, V4_HOOK.poolInitTx)}
          extra={{ href: EXPLORERS[BASE_CHAIN_ID]!.address(V4_HOOK.address), label: "hook contract" }}
          chainId={BASE_CHAIN_ID}
          timeMs={hookAt ? hookAt * 1000 : null}
          nowMs={nowMs}
        />
        {loop.fills.map((f) => {
          const inSym = f.tokenIn.toLowerCase() === TOKENS.W0G.address.toLowerCase() ? "W0G" : "USDC";
          const outSym = inSym === "W0G" ? "USDC" : "W0G";
          const e = fillEconomics(f, status);
          return (
            <EvidenceRow
              key={`${f.txHash}-${f.amountIn}`}
              title={<>{e.seed ? "Seed fill (agent)" : "Outside fill"} <span className="num ml-1 text-[13px] font-normal text-muted">{shortHash(f.taker)}</span></>}
              plain={<>Paid {fmtUnits(f.amountIn, inSym)} <Tk>{inSym}</Tk> for {fmtUnits(f.amountOut, outSym)} <Tk>{outSym}</Tk>{e.decisionsFunded !== null ? `, enough fee for ${fmtDecisions(e.decisionsFunded)} AI decisions` : ""}.</>}
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
  // Only the newest pair is the price a fill gets; any older pair still inside its window is superseded, so it folds away with the rest.
  const latest = quotes.filter((q) => q.expiry === quotes[0]?.expiry);
  const earlier = quotes.filter((q) => !latest.includes(q));
  const live = latest.filter((q) => Number(q.expiry) * 1000 > nowMs);
  return (
    <div>
      <p className="mb-3 text-[14px] text-ink-2"><span className="num text-ink">{quotes.length}</span> signed prices{live.length ? ", newest pair live" : ", requoting"}</p>
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
            {latest.map((q) => <PriceRow key={`${q.inferenceId}-${q.expiry}`} q={q} nowMs={nowMs} />)}
            {earlier.length > 0 ? (
              <li>
                <details className="group">
                  <summary className="cursor-pointer list-none px-4 py-3.5 text-[15px] text-ink-2 transition-colors duration-150 hover:bg-sunken">
                    <span className="num text-ink">{earlier.length}</span> earlier prices, each replaced by a newer one <span className="text-muted group-open:hidden">(show)</span>
                  </summary>
                  <ul className="divide-y divide-rule border-t border-rule">
                    {earlier.map((q) => <PriceRow key={`${q.inferenceId}-${q.expiry}`} q={q} nowMs={nowMs} superseded />)}
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

function PriceRow({ q, nowMs, superseded }: { q: AgentStatus["quotes"][number]; nowMs: number; superseded?: boolean }) {
  const postedAt = usePostedAt(q.postedTx);
  const direction = directionOf(q);
  const price = direction ? impliedPrice(direction, BigInt(q.rateE18)) : Number.NaN;
  const left = Math.floor(Number(q.expiry) - nowMs / 1000);
  const side = direction === "buy-w0g" ? { name: "Ask", who: "you buy W0G", cls: "ask" } : direction === "sell-w0g" ? { name: "Bid", who: "you sell W0G", cls: "bid" } : null;
  const source = q.requestId === "price-only" ? "Signed from the Uniswap pool mid, with no AI run behind it." : q.requestId ? <>Signed after AI run <span className="num text-[13px]">{shortHash(q.requestId)}</span>.</> : "Signed by the agent from the pool mid.";
  return (
    <EvidenceRow
      title={side ? <span className={side.cls}><span className="text-[var(--tone)]">{side.name}</span> <span className="font-normal text-ink-2"><Tk>{side.who}</Tk></span> <span className={cn("num ml-1 text-[13px] font-normal", left > 0 && !superseded ? "text-ok-ink" : "text-muted")}>{superseded ? "superseded" : left > 0 ? countdown(left) : "requoting"}</span></span> : "Price for another pair"}
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

/** Fees as the stage's headline number, set against everything spent on AI, then how far they are from the next funding run. */
function FeesBlock({ econ, status }: { econ: Economics; status: AgentStatus }) {
  const preset = toNumber(presetUsdcUnits(status, latestByDirection(status.quotes)["buy-w0g"]), "USDC");
  const toCover = fillsToCover(econ, status, preset);
  const toThreshold = econ.fundingThresholdUsdc ? Math.min(1, econ.feesEarnedUsdc / econ.fundingThresholdUsdc) : null;
  const max = Math.max(econ.feesEarnedUsdc, econ.aiSpentUsd) || 1;
  return (
    <div className="grid grid-cols-1 gap-8 rounded-card bg-panel p-6 md:grid-cols-[auto_minmax(0,1fr)] md:items-end md:gap-12">
      <div>
        <p className="label">Fees earned</p>
        <p className="mt-2 font-display text-[64px] font-semibold leading-none text-ink lg:text-[88px]"><Amount value={fmtUsdc(econ.feesEarnedUsdc)} symbol="USDC" size={28} unitClassName="text-[24px]" /></p>
      </div>
      <dl className="grid grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <div>
          <dt className="label">Fees earned vs AI spent, {spendWindow(status)}</dt>
          <dd className="mt-2 space-y-1.5" aria-label={`${fmtUsd(econ.feesEarnedUsdc)} earned against ${fmtUsd(econ.aiSpentUsd)} spent on ${status.inferences.length} AI runs`}>
            {[["earned", econ.feesEarnedUsdc, "tone-ok"], ["AI spent", econ.aiSpentUsd, "chain-zg"]].map(([k, v, cls]) => (
              <span key={k as string} className="grid grid-cols-[64px_minmax(0,1fr)_auto] items-center gap-3 text-[13px]">
                <span className="text-muted">{k as string}</span>
                <span className="h-2 rounded-[2px] bg-sunken"><span className={cn("block h-full rounded-[2px]", cls === "tone-ok" ? "tone-ok bg-[var(--tone)]" : "chain-zg bg-[var(--chain)]")} style={{ width: `${Math.max(2, ((v as number) / max) * 100)}%` }} /></span>
                <span className="num text-ink">{fmtUsd(v as number)}</span>
              </span>
            ))}
          </dd>
          <dd className="num mt-2 text-[13px] text-muted">{status.inferences.length} AI runs{toCover ? `; ${toCover} more ${fmtUsdc(preset)} USDC ${toCover === 1 ? "fill covers" : "fills cover"} all of it` : ", all covered by fees"}</dd>
        </div>
        <div>
          <dt className="label">Next funding run</dt>
          <dd className="num mt-1 text-[22px] text-ink">{econ.fundingThresholdUsdc !== null ? `${fmtUsdc(econ.fundingThresholdUsdc)} USDC` : "n/a"}</dd>
          <dd className="text-[13px] text-muted">{toThreshold !== null && toThreshold >= 0.1 ? <span className="num">{fmtPct(toThreshold * 100)} of the way there</span> : `of fees, ${status.fundingMachine?.lastDecision?.k ?? 3}x the live bridge and gas cost, so a run never spends more than it moves`}</dd>
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

/** Every billed run with what it decided: the price it posted, or the guard that refused it, the full reasoning one click away. */
function RunTable({ status, nowMs }: { status: AgentStatus; nowMs: number }) {
  const runs = runsOf(status);
  if (runs.length === 0) return <EmptyBlock title="The first billed AI run lands here." next="Each run's request id appears with its cost, so a signed price on the swap page can be matched to the money that paid for it." />;
  const outcomes = runs.map((r) => outcomeOf(r.raw));
  const refused = outcomes.filter((o) => o.kind === "refused").length;
  const posted = outcomes.filter((o) => o.kind === "posted").length;
  return (
    <div className="overflow-hidden rounded-card bg-panel">
      <CostSpark runs={runs} nowMs={nowMs} />
      <p className="border-t border-rule px-4 py-3 text-[14px] text-ink-2">
        <span className="num text-ink">{posted}</span> {posted === 1 ? "run" : "runs"} posted a price{refused > 0 ? <>, and the guard refused <span className="num text-ink">{refused}</span> {refused === 1 ? "answer" : "answers"} that broke a rule. A refused answer never reaches the signer; the last good price stays up.</> : "."}
      </p>
      <ul className="divide-y divide-rule border-t border-rule">
        {runs.map((r, i) => <RunRow key={r.requestId} r={r} outcome={outcomes[i]!} nowMs={nowMs} />)}
      </ul>
      <p className="flex items-center gap-2 border-t border-rule px-4 py-2.5 text-[13px] text-muted"><ChainChip chainId={ZERO_G_CHAIN_ID} /> billed from the Payment Layer balance. Each run is keyed by its router request id.</p>
    </div>
  );
}

function RunRow({ r, outcome, nowMs }: { r: Run; outcome: Outcome; nowMs: number }) {
  const raw = r.raw;
  const reason = raw.reason ? humaniseReason(raw.reason) : null;
  const summary = outcome.kind === "refused" ? outcome.why.split(". ")[0]! : reason ? gist(reason) : null;
  return (
    <li className="px-4 py-3">
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-1 gap-x-4 gap-y-1.5 md:grid-cols-[88px_minmax(0,1fr)_auto] md:items-start [&::-webkit-details-marker]:hidden">
          <span className="num text-[13px] text-muted" title={r.atMs ? utcStamp(r.atMs) : undefined}>{r.atMs ? relativeTime(r.atMs, nowMs) : "time n/a"}</span>
          <span className="flex min-w-0 flex-col gap-1">
            <OutcomeChip o={outcome} />
            {summary ? <span className="text-[14px] leading-[1.45] text-ink-2">{summary}. <span className="text-muted underline decoration-rule-2 underline-offset-4 group-open:hidden">Full reasoning</span></span> : null}
          </span>
          <span className="flex flex-wrap items-baseline gap-x-3 text-[14px] md:flex-col md:items-end">
            <span className="text-ink">{r.cost0g !== null ? <Amount value={fmt0g(r.cost0g)} symbol="0G" size={14} /> : "n/a"}</span>
            <span className="num text-[13px] text-muted">{r.costUsd !== null ? fmtUsd(r.costUsd) : ""}{r.billedIn === "usd" ? ", billed in USD" : ""}{r.model ? `, ${r.model}` : ""}</span>
          </span>
        </summary>
        <div className="mt-3 space-y-3 md:ml-[104px]">
          {outcome.kind === "refused" ? <p className="max-w-[72ch] text-[14px] leading-[1.5] text-ink">{outcome.why}</p> : null}
          {raw.reason && outcome.kind !== "posted" ? <p className="num max-w-[72ch] text-[13px] text-muted">Guard check: {raw.reason}</p> : reason ? <p className="max-w-[72ch] text-[14px] leading-[1.5] text-ink-2">{reason}</p> : null}
          <DecisionFacts raw={raw} className="max-w-[720px] sm:grid-cols-2" />
          <CopyLink value={r.requestId} label="AI request id" />
        </div>
      </details>
    </li>
  );
}

/** One bar per billed run, oldest first, height by its cost in USD. */
function CostSpark({ runs }: { runs: Run[]; nowMs: number }) {
  const pts = runs.filter((r) => r.costUsd !== null).sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  if (pts.length < 2) return null;
  const max = Math.max(...pts.map((r) => r.costUsd!));
  return (
    <figure className="px-4 pb-3 pt-4">
      <figcaption className="label flex justify-between"><span>Cost per run, oldest first</span><span className="num">max {fmtUsd(max)}</span></figcaption>
      <ol className="mt-3 flex h-14 items-end gap-1.5" aria-label={`Cost of ${pts.length} AI runs`}>
        {pts.map((r) => (
          <li key={r.requestId} className="group relative flex h-full w-full max-w-[40px] items-end">
            <span className="chain-zg block w-full rounded-t-[2px] bg-[var(--chain)] opacity-80 transition-opacity duration-150 group-hover:opacity-100" style={{ height: `${Math.max(6, (r.costUsd! / max) * 100)}%` }} />
            <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-max -translate-x-1/2 rounded-control border border-rule-2 bg-panel px-2.5 py-1.5 text-[12px] text-ink-2 group-hover:block">{runCost(r)}</span>
          </li>
        ))}
      </ol>
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
    { k: "Refused by guard", v: String(status.inferences.filter((r) => outcomeOf(r).kind === "refused").length) },
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

/** Revenue from the paid quote feed, the agent's second income besides swap fees. */
function PaidQuoteRow({ nowMs }: { nowMs: number }) {
  const q = useQuoteStats();
  if (q.isPending) return <div aria-hidden className="skeleton mt-3 h-16 w-full" />;
  if (!q.data) return null;
  const d = q.data;
  return (
    <ul className="mt-3 overflow-hidden rounded-card bg-panel">
      <EvidenceRow
        title="Paid quote feed"
        plain={d.paidQuotes > 0 ? <>Other agents buy a signed <Tk>W0G</Tk> price for 0.01 USDC over x402: {d.paidQuotes} sold to {d.distinctPayers} {d.distinctPayers === 1 ? "agent" : "agents"}.</> : <>Any agent can buy this signed <Tk>W0G</Tk> price for 0.01 USDC over x402, settled on Base to the maker.</>}
        amount={d.paidQuotes > 0 ? <Amount value={fmtUsdc(d.revenueUsdc)} symbol="USDC" size={14} /> : null}
        hash={d.lastSettlementTx ?? undefined}
        hashLabel="latest settlement"
        href={d.lastSettlementTx ? txUrl(BASE_CHAIN_ID, d.lastSettlementTx) : null}
        extra={d.lastSettlementTx ? null : { href: `${QUOTES_API}/v1/stats`, label: "feed stats" }}
        chainId={BASE_CHAIN_ID}
        nowMs={nowMs}
      />
      <li className="px-4 pb-4"><CurlBox /></li>
    </ul>
  );
}
