"use client";

import { useMemo, useState } from "react";
import { BackingPanel } from "@/components/backing-panel";
import { QuoteTape } from "@/components/quote-tape";
import { SwapTicket } from "@/components/swap-ticket";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { latestByDirection, type Direction } from "@/lib/quotes";

export function SwapPage() {
  const status = useAgentStatus();
  const { now, ready } = useChainNow();
  const [direction, setDirection] = useState<Direction>("buy-w0g");
  const priced = useMemo(() => latestByDirection(status.data?.quotes ?? []), [status.data?.quotes]);
  const loading = status.isPending;
  const error = status.isError && !status.data ? status.error : null;

  return (
    <>
      <div className="mx-auto max-w-[1200px] px-4 pt-8 sm:px-6 md:pt-12">
        <h1 className="max-w-[14ch] text-[40px] font-semibold leading-[1.05] sm:max-w-none">Swap at a price that expires.</h1>
        <p className="mt-3 max-w-[62ch] text-[15px]">
          An AI agent signs the W0G and USDC price on Base. The pool fills only while that price is fresh, and the fees you pay buy the agent's next AI run.
        </p>
      </div>
      <div className="mt-8">
        <QuoteTape
          status={status.data}
          loading={loading}
          error={error}
          onRetry={() => void status.refetch()}
          updatedAt={status.dataUpdatedAt}
          priced={priced}
          direction={direction}
          onSelect={setDirection}
          now={now}
          nowReady={ready}
        />
      </div>
      <div className="mx-auto grid max-w-[1200px] grid-cols-1 gap-8 px-4 py-8 sm:px-6 md:grid-cols-[minmax(0,5fr)_minmax(0,4fr)] md:gap-12 md:py-12">
        <SwapTicket status={status.data} priced={priced} direction={direction} setDirection={setDirection} now={now} nowReady={ready} />
        <BackingPanel status={status.data} loading={loading} priced={priced} direction={direction} nowMs={now * 1000} />
      </div>
    </>
  );
}
