import { getAddress, type Address, type Hex } from "viem";

export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8787").replace(/\/+$/, "");
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://base-rpc.publicnode.com";

const MAX_LOOKBACK = 100_000;
const lookback = Number(process.env.NEXT_PUBLIC_FILL_LOOKBACK_BLOCKS ?? "30000");
export const FILL_LOOKBACK_BLOCKS = Number.isFinite(lookback) && lookback > 0 ? Math.min(Math.floor(lookback), MAX_LOOKBACK) : 30_000;
export const LOG_CHUNK_BLOCKS = 10_000;

export const BASE_CHAIN_ID = 8453;
export const ZERO_G_CHAIN_ID = 16661;

export const AQUA_ROUTER: Address = getAddress("0x111111338c5091e8440b67b168bae16a668ac0de");
export const W0G: Address = getAddress("0x23cd099eB438CcA50349EE2BC809196b1ae00861");
export const USDC: Address = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

// Exact-input taker traits, the same constant the agent's taker.ts passes to router.swap.
export const TAKER_TRAITS_EXACT_IN: Hex = "0x00000000000000000000000000000000000000000041";

export const TOKENS = {
  W0G: { symbol: "W0G", address: W0G, decimals: 18, gloss: "wrapped 0G" },
  USDC: { symbol: "USDC", address: USDC, decimals: 6, gloss: "dollar stablecoin" },
} as const;
export type TokenSymbol = keyof typeof TOKENS;

export const EXPLORERS: Record<number, { name: string; tx: (h: string) => string; address: (a: string) => string }> = {
  [BASE_CHAIN_ID]: { name: "Basescan", tx: (h) => `https://basescan.org/tx/${h}`, address: (a) => `https://basescan.org/address/${a}` },
  [ZERO_G_CHAIN_ID]: { name: "0G Chainscan", tx: (h) => `https://chainscan.0g.ai/tx/${h}`, address: (a) => `https://chainscan.0g.ai/address/${a}` },
};

export const CHAIN_NAMES: Record<number, string> = { [BASE_CHAIN_ID]: "Base", [ZERO_G_CHAIN_ID]: "0G" };
