"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useConnection, useReadContract, useSwitchChain } from "wagmi";
import { base } from "wagmi/chains";
import { ArrowDown } from "lucide-react";
import { Alert, AlertBody, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TokenMark } from "@/components/token-mark";
import { useWalletDialog } from "@/components/wallet";
import { useSwapFlow } from "@/hooks/use-swap";
import { AgentError, fetchRouterQuote } from "@/lib/agent-api";
import { erc20Abi } from "@/lib/abis";
import { formatAmount, parseTyped } from "@/lib/amounts";
import { AQUA_ROUTER, BASE_CHAIN_ID, CHAIN_NAMES, TOKENS, type TokenSymbol } from "@/lib/config";
import { CopyLink } from "@/components/copy-link";
import { ctaFor } from "@/lib/cta";
import { formatPrice, formatUsd } from "@/lib/format";
import { durationLabel, fuseLeft } from "@/lib/machine";
import { clock, CLOSING_SECONDS, freshness, secondsLeft, URGENT_SECONDS, type Direction, type Priced } from "@/lib/quotes";
import { classifyQuoteError } from "@/lib/revert";
import { failureCopy } from "@/lib/swap-errors";
import type { AgentStatus } from "@/lib/schema";
import { txUrl } from "@/lib/funding";
import { cn } from "@/lib/utils";

type Props = { status: AgentStatus | undefined; priced: Record<Direction, Priced | null>; direction: Direction; setDirection: (d: Direction) => void; now: number; nowReady: boolean };

const PAIR: Record<Direction, { sell: TokenSymbol; buy: TokenSymbol }> = { "sell-w0g": { sell: "W0G", buy: "USDC" }, "buy-w0g": { sell: "USDC", buy: "W0G" } };

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

  const quoteEnabled = Boolean(status && price && debouncedAmount !== null && !expired);
  const quote = useQuery({
    queryKey: ["router-quote", debouncedAmount?.toString(), sellTok.address],
    enabled: quoteEnabled,
    retry: 0,
    refetchInterval: 8_000,
    queryFn: ({ signal }) => fetchRouterQuote(debouncedAmount!, sellTok.address, signal),
  });
  const quoteState = !quoteEnabled ? "idle" : amount !== debouncedAmount || quote.isPending ? "loading" : quote.isError ? (quote.error instanceof AgentError && quote.error.kind === "http" && classifyQuoteError(quote.error.message) === "stale-quote" ? "stale" : "error") : "ready";

  const refreshChain = () => { void balance.refetch(); void allowance.refetch(); void queryClient.invalidateQueries({ queryKey: ["fills"] }); };
  const flow = useSwapFlow({ account: address, order: status?.order, tokenIn: sell, tokenOut: buy, amount, quoteExpired: () => expired, onSettled: refreshChain });

  const cta = ctaFor({ connected: isConnected, chainId, baseChainId: BASE_CHAIN_ID, hasPrice: Boolean(price), priceExpired: expired, amount, balance: balance.data, quote: quoteState, allowance: allowance.data, phase: flow.phase, sellSymbol: sell });
  const amountOut = quoteState === "ready" && quote.data ? BigInt(quote.data.amountOut) : null;
  const effective = amountOut && amount ? (direction === "buy-w0g" ? Number(amount) / 1e6 / (Number(amountOut) / 1e18) : Number(amountOut) / 1e6 / (Number(amount) / 1e18)) : null;
  const mid = status?.mid ?? null;
  const usd = (units: bigint, tok: TokenSymbol) => (tok === "USDC" ? Number(units) / 1e6 : mid === null ? null : (Number(units) / 1e18) * mid);

  const label = cta.kind === "swap" && amount ? `Swap ${formatAmount(amount, sellTok.decimals, 6)} ${sell} for ${buy}` : cta.kind === "approve" && amount ? `Approve ${formatAmount(amount, sellTok.decimals, 6)} ${sell}` : cta.label;
  const onClick = () => {
    if (cta.kind === "connect") return openOrConnect();
    if (cta.kind === "switch") return switchChain({ chainId: base.id });
    if (cta.kind === "approve") return flow.approve();
    if (cta.kind === "swap") return flow.swap();
  };

  const setFraction = (num: bigint, den: bigint) => {
    if (balance.data === undefined) return;
    const part = (balance.data * num) / den;
    setTyped(part === 0n ? "" : trimTyped(part, sellTok.decimals));
  };
  const pick = (d: Direction) => { if (d !== direction) { setDirection(d); setTyped(""); } };
  const failure = flow.problem ? failureCopy(flow.problem.kind, sell, flow.problem.detail) : null;
  const staleCopy = quoteState === "stale" ? failureCopy("stale-quote", sell) : null;
  const sellUsd = amount ? usd(amount, sell) : null;
  const buyUsd = amountOut !== null ? usd(amountOut, buy) : null;
  const fee = status?.strategy ? status.strategy.feeBps / 100 : null;
  const ttl = status?.quoteTtlSeconds ?? 3600;
  const fuseTone = left === null ? "quiet" : left <= URGENT_SECONDS ? "danger" : left <= CLOSING_SECONDS ? "warn" : "ok";

  return (
    <section data-ui aria-label="Swap" className="rounded-card bg-panel p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3 px-1 pb-3">
        <div role="group" aria-label="Direction" className="flex rounded-control bg-paper p-1">
          {(["buy-w0g", "sell-w0g"] as const).map((d) => (
            <button key={d} type="button" aria-pressed={direction === d} onClick={() => pick(d)} className={cn("h-8 rounded-[3px] px-3 text-[13px] font-semibold transition-colors duration-150", direction === d ? "bg-sunken text-ink" : "text-muted hover:text-ink")}>
              {d === "buy-w0g" ? "Buy W0G" : "Sell W0G"}
            </button>
          ))}
        </div>
        <span className="text-[13px] text-muted" title="Network this swap runs on">on {CHAIN_NAMES[BASE_CHAIN_ID]}</span>
      </div>

      <div className="rounded-control bg-sunken p-4 focus-within:ring-1 focus-within:ring-rule-2">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="sell-amount" className="label">You pay</label>
          <span className="num text-[13px] text-muted">
            {isConnected && onBase ? (balance.data !== undefined ? `Balance ${formatAmount(balance.data, sellTok.decimals, 4)}` : balance.isError ? "Balance unavailable" : "Reading balance") : "Connect to see your balance"}
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
            aria-describedby="sell-hint"
            className="num w-full min-w-0 flex-1 bg-transparent text-[40px] font-medium leading-[48px] text-ink outline-none placeholder:text-rule-2"
          />
          <span className="flex shrink-0 items-center gap-2 rounded-control bg-panel py-1.5 pl-1.5 pr-3 text-[16px] font-semibold text-ink"><TokenMark symbol={sell} />{sell}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <p id="sell-hint" className="num text-[13px] text-muted">{sellUsd !== null ? `${sell === "W0G" ? "about " : ""}${formatUsd(sellUsd)}` : typed && amount === null ? `Up to ${sellTok.decimals} decimals for ${sell}` : "$0.00"}</p>
          <div className="flex gap-1.5" role="group" aria-label="Quick amounts">
            {([["25%", 1n, 4n], ["50%", 1n, 2n], ["Max", 1n, 1n]] as const).map(([name, n, d]) => (
              <Button key={name} type="button" size="chip" disabled={balance.data === undefined || balance.data === 0n} onClick={() => setFraction(n, d)}>{name}</Button>
            ))}
          </div>
        </div>
      </div>

      <div className="relative z-10 -my-[18px] flex justify-center">
        <button type="button" onClick={() => pick(direction === "sell-w0g" ? "buy-w0g" : "sell-w0g")} aria-label="Swap the direction" className="grid size-10 place-items-center rounded-control border-4 border-panel bg-sunken text-ink-2 transition-[color,transform] duration-150 hover:text-ink active:scale-[0.97]">
          <ArrowDown className="size-4" aria-hidden />
        </button>
      </div>

      <div className="rounded-control bg-sunken p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="label">You receive, from the router quote</p>
        </div>
        <div className="mt-1 flex items-center gap-3">
          <p className={cn("num min-w-0 flex-1 truncate text-[40px] font-medium leading-[48px]", amountOut === null ? "text-rule-2" : "text-ink")} aria-live="polite">
            {amountOut !== null ? formatAmount(amountOut, buyTok.decimals, 6) : quoteState === "loading" ? <span className="skeleton inline-block h-9 w-40 align-middle" aria-label="Getting the router quote" /> : "0"}
          </p>
          <span className="flex shrink-0 items-center gap-2 rounded-control bg-panel py-1.5 pl-1.5 pr-3 text-[16px] font-semibold text-ink"><TokenMark symbol={buy} />{buy}</span>
        </div>
        <p className="num mt-1 text-[13px] text-muted">{buyUsd !== null ? `${buy === "W0G" ? "about " : ""}${formatUsd(buyUsd)}` : "$0.00"}</p>
      </div>

      <dl className="mt-3 space-y-2 px-1 text-[13px]">
        <Row k="Signed price" v={price ? `1 W0G = ${formatPrice(price.priceUsdcPerW0g)} USDC` : "none yet"} strike={expired} />
        <Row k={fee !== null ? `After the ${fee.toFixed(2)}% maker fee` : "After the maker fee"} v={effective !== null ? `1 W0G = ${formatPrice(effective)} USDC` : "shown once you enter an amount"} />
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">Price expires</dt>
          <dd className={cn("flex items-center gap-2", `tone-${fuseTone}`)}>
            {price && left !== null ? <span className="h-1 w-16 overflow-hidden rounded-[2px] bg-sunken" aria-hidden><span className="block h-full origin-left bg-[var(--tone)]" style={{ transform: `scaleX(${fuseLeft(price.expiry, now, ttl)})` }} /></span> : null}
            <span className={cn("mono text-[13px]", expired ? "text-danger-ink" : "text-ink")}>{left === null ? "reading the chain clock" : expired ? `expired ${durationLabel((now - price!.expiry) * 1000)} ago` : `T-${clock(left)}`}</span>
          </dd>
        </div>
        <div className="flex items-center justify-between gap-4">
          <dt className="text-muted">AI run behind it</dt>
          <dd className="min-w-0">{price?.quote.requestId && price.quote.requestId !== "price-only" ? <CopyLink value={price.quote.requestId} label="AI request id" head={8} tail={4} /> : <span className="text-ink">{price ? "signed from the pool mid" : "none yet"}</span>}</dd>
        </div>
      </dl>

      <div className="mt-4 space-y-3">
        {isConnected && onBase && cta.kind === "balance" ? (
          <Alert tone="warn"><AlertTitle>Not enough {sell} in this wallet.</AlertTitle><AlertBody>You hold {balance.data !== undefined ? formatAmount(balance.data, sellTok.decimals, 6) : "0"} {sell} on Base and tried to pay {amount ? formatAmount(amount, sellTok.decimals, 6) : "0"}.</AlertBody></Alert>
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
            <AlertTitle>Swapped {formatAmount(flow.result.amountIn, TOKENS[flow.result.tokenIn].decimals, 6)} {flow.result.tokenIn} for {formatAmount(flow.result.amountOut, TOKENS[flow.result.tokenOut].decimals, 6)} {flow.result.tokenOut}.</AlertTitle>
            <AlertBody>
              <CopyLink value={flow.result.hash} href={txUrl(BASE_CHAIN_ID, flow.result.hash)} label="swap transaction" head={10} tail={8} />
              {" "}confirmed on {CHAIN_NAMES[BASE_CHAIN_ID]}. Your fee now feeds the agent's next AI run; see it on the ledger.
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

function Row({ k, v, strike }: { k: string; v: string; strike?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{k}</dt>
      <dd className={cn("num text-right text-ink", strike && "text-muted line-through decoration-danger")}>{v}</dd>
    </div>
  );
}

function trimTyped(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
