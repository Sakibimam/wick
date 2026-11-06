import { getAddress, type Address, type Hex } from "viem";

// Same origin by default: the Worker serves /api/status and /api/quote next to the pages.
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? "").replace(/\/+$/, "");
export const BASE_RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://base-rpc.publicnode.com";

/** A local anvil fork of Base: explorer links are dropped (the hashes exist only on this machine) and the wallet is the fork's unlocked test account. */
export const LOCAL_FORK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/.test(BASE_RPC_URL);
const devAccount = process.env.NEXT_PUBLIC_DEV_ACCOUNT ?? "";
export const DEV_ACCOUNT: Address | null = LOCAL_FORK && /^0x[0-9a-fA-F]{40}$/.test(devAccount) ? getAddress(devAccount) : null;

const MAX_LOOKBACK = 100_000;
const lookback = Number(process.env.NEXT_PUBLIC_FILL_LOOKBACK_BLOCKS ?? "30000");
export const FILL_LOOKBACK_BLOCKS = Number.isFinite(lookback) && lookback > 0 ? Math.min(Math.floor(lookback), MAX_LOOKBACK) : 30_000;
export const LOG_CHUNK_BLOCKS = 10_000;
/** Block the strategy was shipped in. No fill can predate it, so log scans start here when it is known. */
const fromBlock = process.env.NEXT_PUBLIC_FILL_FROM_BLOCK ?? "";
export const FILL_FROM_BLOCK: bigint | null = /^\d+$/.test(fromBlock) ? BigInt(fromBlock) : null;

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

export const CHAIN_NAMES: Record<number, string> = { [BASE_CHAIN_ID]: LOCAL_FORK ? "Base fork" : "Base", [ZERO_G_CHAIN_ID]: "0G" };

/** Official marks, served from public/tokens. A test fails if any symbol or chain here has no file. */
export const TOKEN_ICON: Record<TokenSymbol | "0G", string> = { USDC: "/tokens/usdc.svg", W0G: "/tokens/w0g.svg", "0G": "/tokens/0g.svg" };
export const CHAIN_ICON: Record<number, string> = { [BASE_CHAIN_ID]: "/tokens/base.svg", [ZERO_G_CHAIN_ID]: "/tokens/0g.svg" };
export const PROTOCOL_ICON = { aqua: "/tokens/1inch.svg", uniswap: "/tokens/uniswap.svg", ccip: "/tokens/ccip.svg" } as const;
export type Protocol = keyof typeof PROTOCOL_ICON;

/** Uniswap v4 pool whose hook routes swaps into the Wick strategy: a second door for takers. Read from hook/broadcast. */
export const V4_HOOK = {
  address: getAddress("0x1a35d13ae02a834e9b35a98ca1b9c87b30d72888"),
  deployTx: "0xa72b0d60b59900f8b89ca96c3c6612a18a04750e16c606fc1a0e68d6bbfb2427",
  setOrderTx: "0xf062d2d5c839fd03ddddea6ff201cfa246c1e221d48b4335a327d201d2a7ec11",
  poolInitTx: "0xee9b8414c77c117231f020d604b684d7766076df89fdfbe816c9f97229649696",
} as const;

/** Paid quote feed: agents buy a signed price over x402. */
export const QUOTES_API = "https://wick-quotes.earn-shield-alerts.workers.dev";
