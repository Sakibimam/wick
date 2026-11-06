import { expect, test } from "bun:test";
import { createPublicClient, fallback, http } from "viem";

// The cron's Base transport must survive a rate-limited first endpoint (mainnet.base.org and drpc 429 Cloudflare egress).
test("a 429 from the first Base endpoint falls through to the next one", async () => {
  const hits: string[] = [];
  const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    hits.push(u);
    if (u.includes("first")) return new Response("rate limited", { status: 429 });
    const body = JSON.parse(String(init?.body));
    const reply = (r: { id: number }) => ({ jsonrpc: "2.0", id: r.id, result: "0x2a" });
    return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const client = createPublicClient({ transport: fallback(["https://first.example", "https://second.example"].map((u) => http(u, { retryCount: 0, batch: true, fetchFn })), { retryCount: 1 }) });
  expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
  expect(hits.some((h) => h.includes("first"))).toBe(true);
  expect(hits.some((h) => h.includes("second"))).toBe(true);
});
