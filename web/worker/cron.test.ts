import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { runCron, x402Settlements, type CronDeps } from "./cron";
import type { TickEnv } from "../../agent/src/worker-tick";
import { STRATEGY_HASH_V2 } from "./v2";

test("a worker without the signer secrets leaves the shared KV untouched", async () => {
  const calls: string[] = [];
  const kv = { get: async (k: string) => (calls.push(`get ${k}`), null), put: async (k: string) => void calls.push(`put ${k}`) };
  await runCron({ UPKEEP_KV: kv, ZG_API_KEY: "set" });
  await runCron({ UPKEEP_KV: kv, AGENT_PK: "0x01" });
  expect(calls).toEqual([]);
});

const AGENT = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const memKv = (seed: Record<string, unknown> = {}) => {
  const m = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return { m, kv: { get: async (k: string) => (m.has(k) ? JSON.parse(m.get(k)!) : null), put: async (k: string, v: string) => void m.set(k, v) } };
};
const fill = (orderHash: string, taker: string, n: number) => ({ txHash: `0x${n.toString(16).padStart(64, "0")}`, logIndex: 0, block: String(n), timeMs: n, orderHash, taker, tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", amountIn: "1000000", amountOut: "1" });
const secrets = { AGENT_PK: "0x" + "11".repeat(32), ZG_API_KEY: "k" };

test("the cron hands the tick only this agent's fills: a foreign strategy's fill and the maker's self-fill are dropped", async () => {
  const { kv } = memKv({ "log-index-v2": { cursor: "1", posts: [], fills: [fill("0x" + "ab".repeat(32), "0x00000000000000000000000000000000000000f1", 1), fill(STRATEGY_HASH_V2, AGENT, 2)] } });
  let seen: TickEnv | null = null;
  const deps: CronDeps = { tick: async (prev, env) => { seen = env; return { state: prev, outcome: "x" }; }, x402Revenue: async () => 0n };
  await runCron({ UPKEEP_KV: kv, ...secrets }, deps);
  expect(seen).not.toBeNull();
  expect(seen!.fills).toEqual([]);
  expect(seen!.orderHashes!.map((h: Hex) => h.toLowerCase())).toContain(STRATEGY_HASH_V2);
});

test("a fill by a taker on this agent's strategy still reaches the tick", async () => {
  const { kv } = memKv({ "log-index-v2": { cursor: "1", posts: [], fills: [fill(STRATEGY_HASH_V2, "0x00000000000000000000000000000000000000f1", 3)] } });
  let seen: TickEnv | null = null;
  await runCron({ UPKEEP_KV: kv, ...secrets }, { tick: async (prev, env) => { seen = env; return { state: prev, outcome: "x" }; }, x402Revenue: async () => 0n });
  expect(seen!.fills!.length).toBe(1);
});

test("a failing RPC url is logged and persisted as its host only: the path and query never reach KV", async () => {
  const { m, kv } = memKv();
  const err = Object.assign(new Error("HTTP request failed."), { shortMessage: "HTTP request failed.", url: "https://base.example-rpc.io/v2/KEY123/x?apikey=KEY123", status: 401, details: "unauthorized" });
  const logs: string[] = [];
  const orig = console.error; console.error = (l: string) => void logs.push(l);
  try { await runCron({ UPKEEP_KV: kv, ...secrets }, { tick: async () => { throw err; }, x402Revenue: async () => 0n }); } finally { console.error = orig; }
  const stored = m.get("cron-state")!;
  expect(stored).toContain("url=base.example-rpc.io");
  expect(stored.includes("KEY123")).toBe(false);
  expect(logs.join("\n").includes("KEY123")).toBe(false);
});

test("x402 revenue counts only USDC transfers to the maker whose tx also used the payer's EIP-3009 authorization", () => {
  const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
  const payer = "0x00000000000000000000000000000000000000a1", taker = "0x00000000000000000000000000000000000000b2";
  const transfers = [
    { transactionHash: tx(1), args: { from: payer, to: AGENT, value: 10_000n } },   // x402 settlement
    { transactionHash: tx(2), args: { from: taker, to: AGENT, value: 999_999n } },  // a fill's USDC leg: no authorization
    { transactionHash: tx(3), args: { from: taker, to: AGENT, value: 10_000n } },   // authorization in the tx belongs to someone else
  ];
  const auths = [{ transactionHash: tx(1), args: { authorizer: payer } }, { transactionHash: tx(3), args: { authorizer: payer } }];
  expect(x402Settlements(transfers as never, auths as never)).toEqual([{ tx: tx(1), payer, value: 10_000n }]);
});
