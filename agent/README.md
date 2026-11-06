# Wick agent

Production Bun and TypeScript service for the Base W0G/USDC market and 0G Payment Layer.

## Modules

- `src/price.ts` reads the Base Uniswap v3 pool, computes USDC per W0G from either token order, and quotes exact USDC input with QuoterV2.
- `src/brain.ts` requests a strictly validated rate and spread from the 0G router and requires a request ID for reconciliation. It never logs the API key.
- `src/budget.ts` applies pure balance and spend policy, spread multipliers, and price-deviation requote thresholds.
- `src/funding.ts` quotes CCIP fees and builds the Base USDC swap, Base CCIP transfer, 0G unwrap, and Payment Layer deposit transactions. The runtime waits for every receipt and for CCIP delivery before advancing.
- `src/signer.ts` signs the board's EIP-712 `Quote` using `AGENT_PK` or an RPC unlocked account. Private keys are read only from the process environment.
- `src/poster.ts` posts quotes and checks the mined receipt, decoding board errors when the RPC provides revert data.
- `src/taker.ts` builds the router's 22-byte exact-in traits encoding, reads `quote()`, approves the input token, and submits the shipped order to AquaSwapVMRouter.
- `src/runtime.ts` reads Base market state and the 0G Payment Layer balance on each tick, applies the budget policy, requests and validates inference only for policy requotes, persists state, and accounts for fills from router events.
- `src/status.ts` serves the persisted state at `/api/status` and the current router quote at `/api/quote`.
- `scripts/fork-e2e.ts` deploys and ships the exact Solidity strategy on a local Base fork, signs and posts a price-only quote, fills 5 USDC, checks both token deltas, verifies stale rejection, and reads the HTTP schema.
- `scripts/live-check.ts` reads live chain state and simulates the Payment Layer deposit success and zero-value failure paths. It is read-only and never makes an inference call.

## Environment

- `BASE_RPC_URL`: Base JSON-RPC endpoint.
- `ZG_RPC_URL`: 0G JSON-RPC endpoint.
- `ZG_API_KEY`: 0G router bearer key. It is never logged or written by this package.
- `ZG_API_BASE`: 0G router API base URL.
- `PAYMENT_LOG_LOOKBACK_BLOCKS`: maximum backward scan window for recent Payment Layer deposits.
- `AGENT_PK`: optional local EIP-712 and transaction signer. When absent, the configured RPC account must be unlocked.
- `AGENT_ADDRESS`, `MAKER_ADDRESS`, `BOARD_ADDRESS`: registered board agent, shipped order maker, and quote board.
- `ORDER_JSON`: the `order` object printed by `ShipStrategy.s.sol`, containing `maker`, `traits`, and `data`.
- `STATE_PATH`: state JSON path, default `./state/upkeep.json`.
- `PORT` and `WEB_ORIGIN`: status server port (8787) and the one allowed browser origin.
- `SPEND_CAP_PER_DAY_WEI`: daily 0G compute balance spend cap.
- `QUOTE_TTL_SECONDS`: signed quote lifetime.
- `INFERENCE_COST_PER_TOKEN_WEI`: optional cost conversion for the inference token usage returned by the 0G router.
- `FUNDING_THRESHOLD_USDC`, `FUNDING_SLIPPAGE_BPS`, `ZG_GAS_RESERVE_WEI`, `CCIP_TIMEOUT_MS`: funding threshold, swap slippage, 0G gas reserve, and CCIP delivery timeout.

## Install and run

```sh
bun install
bun test
bunx tsc --noEmit
bun run scripts/live-check.ts
bun run live-check
bun run src/runtime.ts --once
bun run status
bun run fork-e2e
```

`live-check` performs live reads only, with no signing or sends. It needs no `ZG_API_KEY`. The runtime loops every 15 seconds and quotes only after the budget policy's price-deviation trigger. For fee funding, the signing account must be the maker account because accrued inventory remains under maker ownership.

## Verified contracts

Addresses below returned deployed bytecode from `eth_getCode` on the listed live chains. The live check also reads market and Payment Layer state.

| Chain | Contract | Address or selector |
| --- | --- | --- |
| Base (8453) | USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Base (8453) | W0G | `0x23cd099eB438CcA50349EE2BC809196b1ae00861` |
| Base (8453) | Uniswap v3 pool | `0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e` |
| Base (8453) | QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` |
| Base (8453) | SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` |
| Base (8453) | CCIP Router | `0x881e3A65B4d4a04dD529061dd0071cf975F58bCD` |
| Base (8453) | W0G CCIP token pool | `0x049DF7Ed53037C58BCAB45510c153D5CD5564830` |
| 0G (16661) | Payment Layer | `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` |
| 0G (16661) | CCIP Router | `0x0aA145a62153190B8f0D3cA00c441e451529f755` |
| 0G (16661) | W0G | `0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c` |
| 0G (16661) | W0G CCIP token pool | `0xF6839B313671daE8c1B6AbCaB4eBd0bF41259187` |
| CCIP | 0G destination chain selector | `4426351306075016396` |

## Quote and budget units

`rateE18` is an integer count of USDC per W0G multiplied by `10^18`. `spreadBps` is basis points. NORMAL uses the primary model and a 1x base spread; LOW uses the cheap model and 2x; CRITICAL disables inference and uses 4x while retaining only a quote no older than the configured limit; PAUSED disables inference and quote posting. Requotes are driven by deviation from the previous mid, not a timer. A missing previous quote permits an initial quote.

The configured model ids are `0gm-1.0-35b-a3b` (NORMAL) and `qwen3.7-flash` (LOW). The brain rejects `rateE18` values more than 3% from the supplied mid and requires `spreadBps` from 5 through 500 inclusive.

## Funding flow

The runtime converts accrued USDC fee inventory to W0G on Base, adds accrued W0G inventory, approves and sends the combined amount through CCIP, waits for the 0G wrapped token balance to increase, withdraws it to native 0G, then deposits the amount minus the configured gas reserve into the Payment Layer. Base steps require Base ETH for gas. CCIP requires its separately quoted fee in Base native ETH.
