// Keyless Base RPCs that answered eth_blockNumber + eth_call 3/3 from a Cloudflare Worker (wrangler dev --remote, colo DEL,
// 2026-11-06 ~09:15Z). Dropped after the same probe: mainnet.base.org 429 (25/s limit), base.llamarpc.com 525, 1rpc.io/base
// usage limit, base.meowrpc.com 429, base.drpc.org 429, tenderly 429, onfinality 429, omniatech 429, zan 429, blockpi 503,
// lava 410, therpc 403, developer-access-mainnet.base.org and subquery 530.
import { fallback, http } from "viem";

export const BASE_RPCS = ["https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io", "https://base-public.nodies.app", "https://base-pokt.nodies.app"];

/** Per-endpoint failure counts for one invocation, keyed by host: HTTP status >= 400 or a fetch that threw. */
export type RpcFailures = Record<string, number>;

/** viem fallback over every endpoint in order (rank off, so a probe never spends subrequests), each tried once per pass, the
 *  whole pass retried twice with exponential backoff. Every failure is counted against its host for the tick log. */
export function baseFallback(opts: { fetchFn?: typeof fetch; urls?: string[]; failures?: RpcFailures; batch?: boolean; timeout?: number } = {}) {
  const inner = opts.fetchFn ?? fetch, failures = opts.failures;
  const tracked = (url: string) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = new URL(url).host;
    try {
      const r = await inner(input, init);
      if (r.status >= 400 && failures) failures[host] = (failures[host] ?? 0) + 1;
      return r;
    } catch (e) { if (failures) failures[host] = (failures[host] ?? 0) + 1; throw e; }
  }) as typeof fetch;
  return fallback((opts.urls ?? BASE_RPCS).map((u) => http(u, { retryCount: 0, batch: opts.batch ?? true, timeout: opts.timeout ?? 8_000, fetchFn: tracked(u) })), { rank: false, retryCount: 2, retryDelay: 300 });
}
