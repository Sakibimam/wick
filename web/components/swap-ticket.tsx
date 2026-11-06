"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { ArrowDown } from "lucide-react";
import { Alert, AlertBody, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyLink } from "@/components/copy-link";
import { Countdown } from "@/components/countdown";
import { ChainChip, TokenIcon, Tk } from "@/components/token-mark";
import { useWalletDialog } from "@/components/wallet";
import { useSwapFlow } from "@/hooks/use-swap";
import { AgentError, fetchRouterQuote } from "@/lib/agent-api";
import { erc20Abi } from "@/lib/abis";
import { parseTyped } from "@/lib/amounts";
import { AQUA_ROUTER, BASE_CHAIN_ID, CHAIN_NAMES, TOKENS, type TokenSymbol } from "@/lib/config";
import { ctaFor } from "@/lib/cta";
import { feeFromAmount, lastPaidRun, maxFillIn } from "@/lib/economics";
import { fmtPrice, fmtUnits, fmtUsd, significant, toNumber } from "@/lib/format";
import { freshness, secondsLeft, type Direction, type Priced } from "@/lib/quotes";
import { classifyQuoteError } from "@/lib/revert";
import { failureCopy } from "@/lib/swap-errors";
import type { AgentStatus } from "@/lib/schema";
import { txUrl } from "@/lib/funding";
import { cn } from "@/lib/utils";

type Props = { status: AgentStatus | undefined; priced: Record<Direction, Priced | null>; direction: Direction; setDirection: (d: Direction) => void; now: number; nowReady: boolean };

const PAIR: Record<Direction, { sell: TokenSymbol; buy: TokenSymbol }> = { "sell-w0g": { sell: "W0G", buy: "USDC" }, "buy-w0g": { sell: "USDC", buy: "W0G" } };
/** The judge preset: a fill small enough to clear on any live depth, large enough to pay a visible fee. */
const PRESET_USDC = 100_000n;

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

export function SwapTicket({ status, priced, direction, setDirection, now, nowReady }: Props) {
  const { sell, buy } = PAIR[direction];
  const sellTok = TOKENS[sell];
  const buyTok = TOKENS[buy];
  const [typed, setTyped] = useState("");
  const amount = useMemo(() => parseTyped(typed, sellTok.decimals), [typed, sellTok.decimals]);
  const debouncedAmount = useDebounced(amount, 350);

  const { address, chainId, isConnected } = useConnection();
  const { open: openOrConnect } = useWalletDialog();
  const { mutate: switchChain, isPending: switching } = useSwitchChain();
  const queryClient = useQueryClient();

  const price = priced[direction];
  const expired = Boolean(price) && nowReady && freshness(price!.expiry, now) === "expired";
  const left = price && nowReady ? secondsLeft(price.expiry, now) : null;

  const onBase = isConnected && chainId === BASE_CHAIN_ID;
  const balance = useReadContract({ address: sellTok.address, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: base.id, query: { enabled: Boolean(address) && onBase, refetchInterval: 15_000 } });
  const allowance = useReadContract({ address: sellTok.address, abi: erc20Abi, functionName: "allowance", args: address ? [address, AQUA_ROUTER] : undefined, chainId: base.id, query: { enabled: Boolean(address) && onBase, refetchInterval: 15_000 } });

  // No wallet needed: the router quote is a public read, so anyone can price any amount.
  const quoteEnabled = Boolean(status && price && debouncedAmount !== null && !expired);
  const quote = useQuery({
    queryKey: ["router-quote", debouncedAmount?.toString(), sellTok.address],
    enabled: quoteEnabled,
    retry: 0,
    refetchInterval: 8_000,
    queryFn: ({ signal }) => fetchRouterQuote(debouncedAmount!, sellTok.address, signal),
  });
  const quoteState = !quoteEnabled ? "idle" : amount !== debouncedAmount || quote.isPending ? "loading" : quote.isError ? (quote.error instanceof AgentError && quote.error.kind === "http" && classifyQuoteError(quote.error.message) === "stale-quote" ? "stale" : "error") : "ready";

  const reportedMax = quote.data?.maxAmountIn != null ? BigInt(quote.data.maxAmountIn) : null;
  const maxIn = reportedMax ?? (status ? maxFillIn(direction, status, price) : null);
  const overDepth = amount !== null && maxIn !== null && amount > maxIn;

  const refreshChain = () => { void balance.refetch(); void allowance.refetch(); void queryClient.invalidateQueries({ queryKey: ["fills"] }); void queryClient.invalidateQueries({ queryKey: ["agent-status"] }); };
  const flow = useSwapFlow({ account: address, order: status?.order, tokenIn: sell, tokenOut: buy, amount, quoteExpired: () => expired, onSettled: refreshChain });

  const cta = ctaFor({ connected: isConnected, chainId, baseChainId: BASE_CHAIN_ID, hasPrice: Boolean(price), priceExpired: expired, amount, balance: balance.data, quote: quoteState, allowance: allowance.data, phase: flow.phase, sellSymbol: sell, maxIn });
  const amountOut = quoteState === "ready" && quote.data ? BigInt(quote.data.amountOut) : null;
  const effective = amountOut && amount ? (direction === "buy-w0g" ? toNumber(amount, "USDC") / toNumber(amountOut, "W0G") : toNumber(amountOut, "USDC") / toNumber(amount, "W0G")) : null;
  const mid = status?.mid ?? null;
  const usd = (units: bigint, tok: TokenSymbol) => (tok === "USDC" ? toNumber(units, "USDC") : mid === null ? null : toNumber(units, "W0G") * mid);

  const label = cta.kind === "swap" && amount ? `Swap ${fmtUnits(amount, sell)} ${sell} for ${buy}` : cta.kind === "approve" && amount ? `Approve ${fmtUnits(amount, sell)} ${sell}` : cta.label;
  const onClick = () => {
    if (cta.kind === "connect") return openOrConnect();
    if (cta.kind === "switch") return switchChain({ chainId: base.id });
    if (cta.kind === "approve") return flow.approve();
    if (cta.kind === "swap") return flow.swap();
  };

  const fill = (units: bigint, decimals: number) => setTyped(units <= 0n ? "" : trimTyped(units, decimals));
  const setFraction = (num: bigint, den: bigint) => {
    if (balance.data === undefined) return;
    const part = (balance.data * num) / den;
    fill(maxIn !== null && part > maxIn ? maxIn : part, sellTok.decimals);
  };
  const pick = (d: Direction) => { if (d !== direction) { setDirection(d); setTyped(""); } };
  const preset = () => {
    const buyMax = status ? maxFillIn("buy-w0g", status, priced["buy-w0g"]) : null;
    if (direction !== "buy-w0g") setDirection("buy-w0g");
    fill(buyMax !== null && buyMax < PRESET_USDC ? buyMax : PRESET_USDC, 6);
  };
  const failure = flow.problem ? failureCopy(flow.problem.kind, sell, flow.problem.detail) : null;
  const staleCopy = quoteState === "stale" ? failureCopy("stale-quote", sell) : null;
  const sellUsd = amount ? usd(amount, sell) : null;
  const buyUsd = amountOut !== null ? usd(amountOut, buy) : null;
  const fee = status?.strategy ? status.strategy.feeBps / 100 : null;
  const ttl = status?.quoteTtlSeconds ?? 3600;
  const receipt = flow.result && status ? swapReceipt(flow.result.amountIn, flow.result.tokenIn, status) : null;

  return (
    <section data-ui aria-label="Swap" className="rounded-card bg-panel p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1 pb-3">
        <div role="group" aria-label="Direction" className="flex rounded-control bg-paper p-1">
          {(["buy-w0g", "sell-w0g"] as const).map((d) => (
            <button key={d} type="button" aria-pressed={direction === d} onClick={() => pick(d)} className={cn("h-8 rounded-[3px] px-3 text-[13px] font-semibold transition-colors duration-150", direction === d ? cn("bg-sunken", d === "buy-w0g" ? "text-danger-ink" : "text-ok-ink") : "text-ink-2 hover:text-ink")}>
              {d === "buy-w0g" ? <>Buy <Tk>W0G</Tk></> : <>Sell <Tk>W0G</Tk></>}
            </button>
          ))}
        </div>
        <ChainChip chainId={BASE_CHAIN_ID} />
      </div>

      <div className="rounded-control bg-sunken p-4 focus-within:ring-1 focus-within:ring-rule-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="sell-amount" className="label">You pay</label>
          <span className="num text-[13px] text-muted">
            {isConnected && onBase ? (balance.data !== undefined ? `Balance ${fmtUnits(balance.data, sell)}` : balance.isError ? "Balance unavailable" : <span aria-hidden className="skeleton inline-block h-3.5 w-24 align-middle" />) : "No wallet needed to quote"}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <input
            id="sell-amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0"
            value={typed}
            onChange={(e) => { if (/^\d*\.?\d*$/.test(e.target.value)) setTyped(e.target.value); }}
            aria-describedby="sell-hint depth-hint"
            className="num w-full min-w-0 flex-1 bg-transparent text-[40px] font-medium leading-[48px] text-ink outline-none placeholder:text-rule-2"
          />
          <TokenChip symbol={sell} />
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p id="sell-hint" className="num text-[13px] text-muted">{sellUsd !== null ? `${sell === "W0G" ? "about " : ""}${fmtUsd(sellUsd)}` : typed && amount === null ? `Up to ${sellTok.decimals} decimals for ${sell}` : "$0.00"}</p>
          <div className="flex gap-1.5" role="group" aria-label="Quick amounts">
            {([["25%", 1n, 4n], ["50%", 1n, 2n]] as const).map(([name, n, d]) => (
              <Button key={name} type="button" size="chip" disabled={balance.data === undefined || balance.data === 0n} onClick={() => setFraction(n, d)}>{name}</Button>
            ))}
            <Button type="button" size="chip" disabled={maxIn === null || (isConnected && balance.data === 0n)} onClick={() => (isConnected && balance.data !== undefined ? setFraction(1n, 1n) : maxIn !== null && fill(maxIn, sellTok.decimals))}>Max</Button>
          </div>
        </div>
      </div>

      <div className="relative z-10 -my-[18px] flex justify-center">
        <button type="button" onClick={() => pick(direction === "sell-w0g" ? "buy-w0g" : "sell-w0g")} aria-label="Swap the direction" className="grid size-10 place-items-center rounded-control border-4 border-panel bg-sunken text-ink-2 transition-[color,transform] duration-150 hover:text-ink active:scale-[0.97]">
          <ArrowDown className="size-4" aria-hidden />
        </button>
      </div>

      <div className="rounded-control bg-sunken p-4">
        <p className="label">You receive, from the router quote</p>
        <div className="mt-1 flex items-center gap-3">
          <p className={cn("num min-w-0 flex-1 truncate text-[40px] font-medium leading-[48px]", amountOut === null ? "text-rule-2" : overDepth ? "text-muted line-through decoration-danger decoration-2" : "text-ink")} aria-live="polite">
            {amountOut !== null ? fmtUnits(amountOut, buy) : quoteState === "loading" ? <span className="skeleton inline-block h-9 w-40 align-middle" aria-label="Getting the router quote" /> : "0"}
          </p>
          <TokenChip symbol={buy} />
        </div>
        <p className="num mt-1 text-[13px] text-muted">{buyUsd !== null ? `${buy === "W0G" ? "about " : ""}${fmtUsd(buyUsd)}` : "$0.00"}</p>
      </div>

      <p id="depth-hint" className="num mt-3 flex flex-wrap items-center justify-between gap-2 px-1 text-[13px] text-muted">
        <span>
          Max fill right now{" "}
          {maxIn !== null ? <span className={cn(overDepth ? "text-danger-ink" : "text-ink")}>{fmtUnits(maxIn, sell)} {sell}</span> : status ? "unknown" : <span aria-hidden className="skeleton inline-block h-3.5 w-20 align-middle" />}
        </span>
        <button type="button" onClick={preset} className="rounded-control border border-rule-2 px-2 py-1 text-[13px] font-medium text-ink transition-colors duration-150 hover:border-ink active:scale-[0.97]">
          Fill {maxIn !== null && direction === "buy-w0g" && maxIn < PRESET_USDC ? fmtUnits(maxIn, "USDC") : "0.10"} USDC
        </button>
      </p>

      <dl className="mt-3 space-y-2.5 px-1 text-[13px]">
        <Row k="Signed price" v={status ? (price ? `1 W0G = ${fmtPrice(price.priceUsdcPerW0g)} USDC` : "no price signed") : null} strike={expired} />
        <Row k={fee !== null ? `After the ${fee.toFixed(2)}% maker fee` : "After the maker fee"} v={status ? (effective !== null ? `1 W0G = ${fmtPrice(effective)} USDC` : "shown once you enter an amount") : null} muted={effective === null} />
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">Price</dt>
          <dd>{price ? <Countdown expiry={price.expiry} now={now} ttl={ttl} ready={nowReady} className="w-40 text-right" /> : status ? <span className="text-ink">no price signed</span> : <span aria-hidden className="skeleton inline-block h-4 w-32" />}</dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">AI run behind it</dt>
          <dd className="min-w-0">{price?.quote.requestId && price.quote.requestId !== "price-only" ? <CopyLink value={price.quote.requestId} label="AI request id" /> : status ? <span className="text-ink">{price ? "signed from the pool mid" : "no price signed"}</span> : <span aria-hidden className="skeleton inline-block h-4 w-28" />}</dd>
        </div>
      </dl>

      <div className="mt-4 space-y-3">
        {overDepth && maxIn !== null ? (
          <Alert tone="warn"><AlertTitle>The pool cannot fill that much right now.</AlertTitle><AlertBody>The strategy holds {status?.strategy ? `${fmtUnits(status.strategy.w0g, "W0G")} W0G and ${fmtUnits(status.strategy.usdc, "USDC")} USDC` : "a small balance"}, so the largest {sell} it can take is {fmtUnits(maxIn, sell)}. A bigger swap reverts on chain.</AlertBody></Alert>
        ) : null}
        {isConnected && onBase && cta.kind === "balance" ? (
          <Alert tone="warn"><AlertTitle>Not enough {sell} in this wallet.</AlertTitle><AlertBody>You hold {balance.data !== undefined ? fmtUnits(balance.data, sell) : "0"} {sell} on Base and tried to pay {amount ? fmtUnits(amount, sell) : "0"}.</AlertBody></Alert>
        ) : null}
        {isConnected && !onBase ? (
          <Alert tone="warn"><AlertTitle>Your wallet is on another network.</AlertTitle><AlertBody>This swap runs on Base. Switch networks to see your balance and swap.</AlertBody></Alert>
        ) : null}
        {staleCopy ? <Alert tone="danger"><AlertTitle>{staleCopy.title}</AlertTitle><AlertBody>{staleCopy.body}</AlertBody></Alert> : null}
        {quoteState === "error" && quote.error ? (
          <Alert tone="danger"><AlertTitle>The router quote is unavailable.</AlertTitle><AlertBody>{quote.error instanceof AgentError && quote.error.kind === "unreachable" ? "The agent is not answering, so there is no quote to trust." : quote.error.message}</AlertBody></Alert>
        ) : null}
        {failure ? <Alert tone="danger"><AlertTitle>{failure.title}</AlertTitle><AlertBody>{failure.body}</AlertBody></Alert> : null}
        {flow.result ? (
          <Alert tone="ok">
            <AlertTitle>{receipt?.decisions != null ? `Your trade funded about ${significant(receipt.decisions, 2)} of Wick's next decisions.` : `Swapped ${fmtUnits(flow.result.amountIn, flow.result.tokenIn)} ${flow.result.tokenIn}.`}</AlertTitle>
            <AlertBody>
              You paid {fmtUnits(flow.result.amountIn, flow.result.tokenIn)} {flow.result.tokenIn} for {fmtUnits(flow.result.amountOut, flow.result.tokenOut)} {flow.result.tokenOut}
              {receipt?.feeUsd != null ? <>, and the {fee?.toFixed(2)}% fee of {fmtUsd(receipt.feeUsd)} goes to the agent{receipt.runUsd ? <>, whose last AI run cost {fmtUsd(receipt.runUsd)}</> : null}</> : null}.{" "}
              <CopyLink value={flow.result.hash} href={txUrl(BASE_CHAIN_ID, flow.result.hash)} label="swap transaction" /> confirmed on {CHAIN_NAMES[BASE_CHAIN_ID]}.
            </AlertBody>
          </Alert>
        ) : null}
        <Button size="lg" className="w-full" disabled={!cta.enabled} loading={cta.kind === "busy" || switching} onClick={onClick} aria-disabled={!cta.enabled}>{label}</Button>
        <p className="px-1 text-[13px] leading-[1.5] text-muted">
          You pay exactly the amount above. If the agent signs a newer price before your swap lands, you get that price. If the price runs out first, the pool refuses and you pay only gas.
        </p>
      </div>
    </section>
  );
}

/** The fee a confirmed swap paid, from the amount in its Swapped event, over what the agent's last AI run cost. */
function swapReceipt(amountIn: bigint, tokenIn: TokenSymbol, status: AgentStatus) {
  const feeUsd = feeFromAmount(amountIn, TOKENS[tokenIn].address, status);
  const runUsd = lastPaidRun(status)?.costUsd ?? null;
  return { feeUsd, runUsd, decisions: feeUsd !== null && runUsd ? feeUsd / runUsd : null };
}

function TokenChip({ symbol }: { symbol: TokenSymbol }) {
  return (
    <span className="flex shrink-0 items-center gap-2 rounded-control bg-panel py-1.5 pl-1.5 pr-3 text-[16px] font-semibold text-ink">
      <TokenIcon symbol={symbol} size={28} />
      <Tk>{symbol}</Tk>
    </span>
  );
}

function Row({ k, v, strike, muted }: { k: string; v: string | null; strike?: boolean; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className={cn("num text-right", muted ? "text-muted" : "text-ink", strike && "text-muted line-through decoration-danger")}>{v ?? <span aria-hidden className="skeleton inline-block h-4 w-36 align-middle" />}</dd>
    </div>
  );
}

function trimTyped(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
