import { expect, test } from "bun:test";
import { createPublicClient } from "viem";
import { BASE_RPCS, baseFallback, type RpcFailures } from "./rpc";

const reply = (body: unknown) => {
  const one = (r: { id: number }) => ({ jsonrpc: "2.0", id: r.id, result: "0x2a" });
  return new Response(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body as { id: number })), { headers: { "content-type": "application/json" } });
};

// The cron's own transport (same factory, same endpoint list) must read through a rate-limited first endpoint.
test("the first Base endpoint returning 429 still yields a successful read, and the 429 is logged against its host", async () => {
  const hits: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url instanceof Request ? url.url : url)).host;
    hits.push(u);
    return u === new URL(BASE_RPCS[0]!).host ? new Response("rate limited", { status: 429 }) : reply(JSON.parse(String(init?.body)));
  }) as typeof fetch;
  const failures: RpcFailures = {};
  const client = createPublicClient({ transport: baseFallback({ fetchFn, failures }) });
  expect(BASE_RPCS.length).toBeGreaterThanOrEqual(3);
  expect(BASE_RPCS.some((u) => u.includes("mainnet.base.org"))).toBe(false);
  expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
  expect(hits.slice(0, 2)).toEqual([new URL(BASE_RPCS[0]!).host, new URL(BASE_RPCS[1]!).host]);
  expect(failures).toEqual({ [new URL(BASE_RPCS[0]!).host]: 1 });
});

test("when every endpoint 429s, the pass is retried twice with backoff, then the read fails", async () => {
  let n = 0;
  const fetchFn = (async () => { n++; return new Response("rate limited", { status: 429 }); }) as unknown as typeof fetch;
  const failures: RpcFailures = {};
  const t = Date.now();
  await expect(createPublicClient({ transport: baseFallback({ fetchFn, failures }) }).getBlockNumber({ cacheTime: 0 })).rejects.toThrow();
  expect(n).toBe(BASE_RPCS.length * 3);
  // viem backoff: retryDelay << attempt, so 300 ms then 600 ms between passes.
  expect(Date.now() - t).toBeGreaterThanOrEqual(300 + 600 - 50);
  expect(Object.values(failures).every((v) => v === 3)).toBe(true);
});
