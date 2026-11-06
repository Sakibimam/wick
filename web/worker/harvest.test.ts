import { expect, test } from "bun:test";
import type { Hex } from "viem";
import { saltedOrder, strategyHashOf, type LiveOrder } from "../../agent/src/funding-machine";
import { fillsOfOrders, type FillRow } from "./chain";
import { liveOrderOf, orderHashesOf, SHIPPED_LIVE_ORDER, STRATEGY_HASH_V2 } from "./v2";
import { STRATEGY_HASH } from "../lib/evidence";

const fill = (orderHash: string, n: number): FillRow => ({ txHash: `0x${n.toString(16).padStart(64, "0")}` as Hex, logIndex: 0, block: String(n), timeMs: n, orderHash: orderHash as Hex, taker: "0x0000000000000000000000000000000000000001", tokenIn: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", tokenOut: "0x23cd099eB438CcA50349EE2BC809196b1ae00861", amountIn: "100000", amountOut: "1" });

test("fill history survives two re-ships: v1, the launch hash and each harvested hash stay, a foreign strategy is dropped", () => {
  const o1 = saltedOrder(SHIPPED_LIVE_ORDER.order, 1n), h1 = strategyHashOf(o1);
  const o2 = saltedOrder(o1, 2n), h2 = strategyHashOf(o2);
  const live: LiveOrder = { order: o2, hash: h2, amounts: { w0g: "1", usdc: "1" }, shipTx: null, shippedAt: null, past: [STRATEGY_HASH_V2, h1] };
  const foreign = "0x" + "ab".repeat(32);
  const all = [fill(STRATEGY_HASH, 1), fill(STRATEGY_HASH_V2.toUpperCase().replace("0X", "0x"), 2), fill(h1, 3), fill(h2, 4), fill(foreign, 5)];
  expect(fillsOfOrders(all, live).map((f) => Number(f.block))).toEqual([1, 2, 3, 4]);
  expect(orderHashesOf(live)).toEqual([STRATEGY_HASH, STRATEGY_HASH_V2, h1.toLowerCase(), h2.toLowerCase()].map((h) => h.toLowerCase()) as Hex[]);
  // Before any harvest, the KV record is absent and the launch order is live.
  expect(liveOrderOf(null).hash).toBe(STRATEGY_HASH_V2);
  expect(liveOrderOf({ funding: { live } }).hash).toBe(h2);
  expect(fillsOfOrders(all, liveOrderOf(null)).map((f) => Number(f.block))).toEqual([1, 2]);
});

test("the launch order JSON hashes to the strategy hash it claims", () => {
  expect(strategyHashOf(SHIPPED_LIVE_ORDER.order).toLowerCase()).toBe(STRATEGY_HASH_V2);
});
