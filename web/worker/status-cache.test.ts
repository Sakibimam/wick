import { expect, test } from "bun:test";
import { __resetStatusCache, cachedStatus } from "./api";
import type { Kv } from "./chain";

const fakeKv = (initial: unknown = null, failPut = false) => {
  const values = new Map<string, unknown>();
  if (initial !== null) values.set("status-snapshot", initial);
  const writes: string[] = [];
  const kv: Kv = {
    async get(key) { return values.get(key) ?? null; },
    async put(key, value) {
      if (failPut) throw new Error("write failed");
      writes.push(value);
      values.set(key, JSON.parse(value));
    },
  };
  return { kv, writes };
};

test("memo serves within 15 seconds and rebuilds after expiry", async () => {
  __resetStatusCache();
  let time = 1_000_000, calls = 0;
  const build = async () => ({ version: ++calls });
  expect(await cachedStatus(null, build, () => time)).toEqual({ body: { version: 1 }, status: 200 });
  time += 14_999;
  expect(await cachedStatus(null, build, () => time)).toEqual({ body: { version: 1 }, status: 200 });
  expect(calls).toBe(1);
  time += 1;
  expect(await cachedStatus(null, build, () => time)).toEqual({ body: { version: 2 }, status: 200 });
  expect(calls).toBe(2);
});

test("build failure returns memoized body with stale metadata", async () => {
  __resetStatusCache();
  const { kv } = fakeKv();
  let time = 1_000_000;
  await cachedStatus(kv, async () => ({ healthy: true }), () => time);
  time += 15_000;
  expect(await cachedStatus(kv, async () => { throw new Error("rpc down\nextra"); }, () => time)).toEqual({
    body: { healthy: true, stale: { since: new Date(1_000_000).toISOString(), error: "rpc down" } }, status: 200,
  });
});

test("build failure uses a KV snapshot when memo is empty", async () => {
  __resetStatusCache();
  const at = 900_000;
  const { kv } = fakeKv({ at, body: { healthy: false } });
  expect(await cachedStatus(kv, async () => { throw new Error("unavailable"); }, () => 1_000_000)).toEqual({
    body: { healthy: false, stale: { since: new Date(at).toISOString(), error: "unavailable" } }, status: 200,
  });
});

test("build failure without a cache keeps the 502 response", async () => {
  __resetStatusCache();
  const result = await cachedStatus(null, async () => { throw new Error("rpc down"); }, () => 1_000_000);
  expect(result.status).toBe(502);
  expect(result.body).toEqual({ error: "chain read failed: rpc down" });
});

test("KV snapshot writes on first success and every ten minutes", async () => {
  __resetStatusCache();
  const { kv, writes } = fakeKv();
  let time = 1_000_000;
  const build = async () => ({ at: time });
  await cachedStatus(kv, build, () => time);
  time += 60_000;
  await cachedStatus(kv, build, () => time);
  expect(writes).toHaveLength(1);
  time += 540_000;
  await cachedStatus(kv, build, () => time);
  expect(writes).toHaveLength(2);
});

test("KV write failure does not fail a successful build", async () => {
  __resetStatusCache();
  const { kv } = fakeKv(null, true);
  expect(await cachedStatus(kv, async () => ({ healthy: true }), () => 1_000_000)).toEqual({ body: { healthy: true }, status: 200 });
});
