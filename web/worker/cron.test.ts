import { expect, test } from "bun:test";
import { runCron } from "./cron";

test("a worker without the signer secrets leaves the shared KV untouched", async () => {
  const calls: string[] = [];
  const kv = { get: async (k: string) => (calls.push(`get ${k}`), null), put: async (k: string) => void calls.push(`put ${k}`) };
  await runCron({ UPKEEP_KV: kv, ZG_API_KEY: "set" });
  await runCron({ UPKEEP_KV: kv, AGENT_PK: "0x01" });
  expect(calls).toEqual([]);
});
