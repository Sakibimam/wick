"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient } from "wagmi";
import { base } from "wagmi/chains";

const REFRESH_MS = 15_000;

/**
 * Seconds since epoch on the Base chain clock. Quotes expire against block.timestamp, so a device clock
 * that runs fast or slow would show a fresh price that the pool already refuses. The offset between the
 * latest block and this device is re-read every 15 seconds; if the RPC is unreachable the device clock is used.
 */
export function useChainNow(): { now: number; source: "chain" | "device"; ready: boolean } {
  const client = usePublicClient({ chainId: base.id });
  const { data: offset } = useQuery({
    queryKey: ["chain-clock-offset"],
    queryFn: async () => {
      const block = await client!.getBlock({ blockTag: "latest" });
      return Number(block.timestamp) - Date.now() / 1000;
    },
    enabled: Boolean(client),
    refetchInterval: REFRESH_MS,
    retry: 1,
  });
  const [tick, setTick] = useState<number | null>(null);
  useEffect(() => {
    setTick(Date.now());
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const device = (tick ?? 0) / 1000;
  const ready = tick !== null;
  return offset === undefined ? { now: device, source: "device", ready } : { now: device + offset, source: "chain", ready };
}
