// Mainnet transactions and router request ids from the agent's funding run on 2026-11-05.
// Every hash was read back from chain (receipt status 1); times are the block timestamps.
import type { Address } from "viem";

export const BOARD: Address = "0x309933CE439Da6A059593d73B8c82E8C8447C3F8";
export const EXTRUCTION: Address = "0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0";
export const AQUA: Address = "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a";
export const AGENT: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
export const PAYMENT_LAYER: Address = "0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32";
/** AgentQuoteBoard deploy block (tx 0x7894c4f2...eb60). No quote or fill of this strategy predates it. */
export const BOARD_DEPLOY_BLOCK = 53_535_233n;
export const STRATEGY_HASH = "0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e" as const;

export const FUNDING_EVIDENCE = [
  { step: "lifi-approve-usdc", chainId: 8453, txHash: "0x8563b85e0bf8e5674a0791b31e0fff5a747ba9214d24249d0044d173a1926ab5", time: "2026-11-05T14:24:39Z" },
  { step: "lifi-gas-to-0g", chainId: 8453, txHash: "0xa43b662266bd967afbeeb4feb17ea67fc3aa4c7804dfc379f47a27e29a44883c", time: "2026-11-05T14:24:43Z" },
  { step: "approve-w0g-ccip", chainId: 8453, txHash: "0x44ec06af25de3f1ea94fe6c77fc6fd094b5e8be19ecf087c064c9d230c9b423b", time: "2026-11-05T14:27:19Z" },
  { step: "ccip-send-w0g", chainId: 8453, txHash: "0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e", time: "2026-11-05T14:27:23Z" },
  { step: "withdraw-w0g-0g", chainId: 16661, txHash: "0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d", time: "2026-11-05T14:52:10Z" },
  { step: "deposit-payment-layer", chainId: 16661, txHash: "0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68", time: "2026-11-05T14:52:12Z" },
  { step: "router-pull-vault", chainId: 16661, txHash: "0xfad8772126b57f54fc503f643423038097175b67e6de886e019b7a59a32f6958", time: "2026-11-05T16:15:47Z" },
] as const;

/** Router-billed AI runs recorded before the Worker cron existed. Costs are x_0g_trace.billing.total_cost in its own currency. */
export const INFERENCE_EVIDENCE = [
  { requestId: "5319a0b6-562e-4bbe-a141-dfb94fc20aaa", model: "0gm-1.0-35b-a3b", currency: "usd", totalCost: "29", time: "2026-11-05T06:35:33Z" },
  { requestId: "798fb102-9f06-4bc5-9ec2-1dde3b716628", model: null, currency: "0g", totalCost: "41660000000000", time: "2026-11-05T16:15:47Z" },
] as const;
