// The live v2 deployment, as printed by contracts/script/LaunchV2.s.sol and read back from chain.
import type { Address, Hex } from "viem";
import type { ShippedOrder } from "../../agent/src/taker";
import type { LiveOrder } from "../../agent/src/funding-machine";
import { STRATEGY_HASH as V1_STRATEGY_HASH } from "../lib/evidence";
import live from "./live-order-v2.json";

export const BOARD_V2 = live.board as Address;
export const EXTRUCTION_V2 = live.extruction as Address;
export const STRATEGY_HASH_V2 = live.strategyHash.toLowerCase() as Hex;
export const BOARD_V2_DEPLOY_BLOCK = BigInt(live.deployBlock);
export const FEE_BPS_V2 = live.pair.feeBps;
export const MAX_DEVIATION_BPS_V2 = live.pair.maxDeviationBps;
export const ORDER_V2 = live.order;
export const liveOrderV2: ShippedOrder = { maker: live.order.maker as Address, traits: BigInt(live.order.traits), data: live.order.data as Hex };
export const V2_TXS = live.txs as Record<string, Hex>;
/** Operator capital routed through the agent's funding rail on 2026-11-05: depositFor credited 2.844001190558679712 0G. */
export const SEED_0G_WEI = 2_844_001_190_558_679_712n;
export { live as LIVE_ORDER_V2 };

/** The Uniswap v4 aggregator hook that fills from the live Aqua strategy; its owner (the maker key) points it at each re-ship. */
export { V4_HOOK } from "../lib/config";
/** The order as LaunchV2 shipped it: what the cron starts from until a harvest re-ships and stores its successor in KV. */
export const SHIPPED_LIVE_ORDER: LiveOrder = { order: { maker: live.order.maker as Address, traits: live.order.traits as Hex, data: live.order.data as Hex }, hash: STRATEGY_HASH_V2, amounts: live.amounts, shipTx: live.txs.shipV2 as Hex, shippedAt: null, past: [] };
/** The strategy the maker runs now: the cron's KV record after a harvest, else the launch order. */
export const liveOrderOf = (cron: { funding?: { live?: LiveOrder } } | null): LiveOrder => cron?.funding?.live ?? SHIPPED_LIVE_ORDER;
/** Every strategy hash the maker's fills can carry, oldest first: v1, each re-shipped predecessor, the live one. */
export const orderHashesOf = (l: LiveOrder): Hex[] => [...new Set([V1_STRATEGY_HASH, STRATEGY_HASH_V2, ...l.past, l.hash].map((h) => h.toLowerCase() as Hex))];
