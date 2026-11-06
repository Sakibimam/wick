# Wick

**Live app: [wick.earn-shield-alerts.workers.dev](https://wick.earn-shield-alerts.workers.dev)**, swap W0G and USDC on Base against the agent's signed quotes, and trace the funding loop on the [brain ledger](https://wick.earn-shield-alerts.workers.dev/ledger).

Wick is a market-making agent that pays for its own brain: its 1inch Aqua strategy on Base fills only against quotes the agent signed after a 0G inference, and the fees it earns route through Uniswap and Chainlink CCIP into the 0G Payment Layer that pays for the next inference.

Architecture: [ARCHITECTURE.md](ARCHITECTURE.md) and the interactive diagram [docs/ARCHITECTURE.html](docs/ARCHITECTURE.html).

## How it works

1. **Read.** Every 15 seconds the runtime reads the W0G/USDC mid from the Uniswap v3 pool on Base and the agent's balance in the 0G Payment Layer.
2. **Budget.** A pure policy turns that balance and today's spend against a daily cap into a tier: NORMAL, LOW, CRITICAL or PAUSED. NORMAL requotes when the mid moves 25 bps on `0gm-1.0-35b-a3b`. LOW switches to the cheaper `qwen3.7-flash` and requotes only on a 100 bps move. CRITICAL stops inference. PAUSED stops posting at the spend cap.
3. **Think.** The brain asks the 0G Private Computer router for a rate and spread, with thinking off. The reply must carry a router request id, a rate within 3% of the Uniswap mid and a spread from 5 to 500 bps, or nothing is signed.
4. **Sign.** The agent signs an EIP-712 quote for each direction and posts it to `AgentQuoteBoard`. Each quote carries `keccak256(requestId ‖ tokenIn ‖ tokenOut)`, binding it to the exact 0G request that priced it.
5. **Fill.** A taker swaps through the deployed, unmodified 1inch AquaSwapVMRouter v1.0.2. The Aqua program runs `AgentQuoteExtruction` at opcode `0x20`, which prices the fill at the signed rate minus the strategy fee. A stale or missing quote reverts `StaleQuote`, in `quote()` and in `swap()`.
6. **Earn.** The runtime decodes SwapVM `Swapped` events for its maker and accrues the fee share of every fill, in USDC and in W0G.
7. **Fund.** When accrued fees reach `FUNDING_THRESHOLD_USDC`, the agent swaps its USDC fees to W0G on Uniswap v3, sends the W0G to 0G chain over Chainlink CCIP, waits for delivery, unwraps with `W0G.withdraw` and calls `depositFor` on the 0G Payment Layer. Every step waits for its receipt.
8. **Repeat.** The router bills the next inference against that balance, and the next tick re-reads it.

Turning thinking off is a measured cost decision: on the live router, `enable_thinking: false` takes reasoning from 274 tokens to 0 and the cost of one pricing decision from 159 to 26 micro-USD.

## Live app on Cloudflare Workers

One Worker serves the Next.js app through OpenNext, its JSON routes, and the agent itself. No separate server.

- `/api/status` reads Base and the 0G chain on every request: both signed quotes from `AgentQuoteBoard` with their posting transactions, the strategy's Aqua `safeBalances`, the agent's 0G Payment Layer balance and Base gas, and the block each figure was read at.
- `/api/quote` runs `router.quote()` against the live strategy, the same view call every swap runs first. An expired signature comes back as `StaleQuote, the signed price expired`.
- `/api/fills` decodes SwapVM `Swapped` events from the board's deploy block, matched on maker and order hash, with a KV block cursor so each read scans only new blocks.
- A Workers cron runs the agent tick every 5 minutes from `agent/src/worker-tick.ts`: the same budget policy as the Bun runtime, a 0G inference only when the mid moves past the tier's threshold or a quote is within 10 minutes of expiry, and a gas floor that records `PAUSED` with reason `gas_low` below 0.00003 ETH. Quotes live 3600 s, and a requote of both directions costs about 0.000002 ETH on Base. Inference records carry the router request id, the model and the billed cost from `x_0g_trace.billing`.

The swap ticket connects a browser wallet on Base mainnet, reads `quote()`, approves the exact input amount, then swaps through AquaSwapVMRouter with explicit EIP-1559 fees and a receipt wait with retries.

```sh
cd web && bun run cf:deploy     # build with OpenNext and deploy the Worker
scripts/push-secrets.sh wick    # pipe AGENT_PK and ZG_API_KEY into wrangler secret put --name wick, nothing printed
```

## Live on Base

Agent, maker and deployer: [`0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953`](https://basescan.org/address/0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953)

| Contract | Address | Deploy tx |
| --- | --- | --- |
| AgentQuoteBoard | [`0x309933CE439Da6A059593d73B8c82E8C8447C3F8`](https://basescan.org/address/0x309933CE439Da6A059593d73B8c82E8C8447C3F8) | [`0x7894c4f2…eb60`](https://basescan.org/tx/0x7894c4f2d67d623cca729a5938d712f0ffbdd64e9435fe40c820e5d6e1a3eb60) |
| AgentQuoteExtruction | [`0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0`](https://basescan.org/address/0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0) | [`0xf042bd0d…2630`](https://basescan.org/tx/0xf042bd0d1d007f741ae282877f0367f1a8e244401401149e90701b0882a52630) |

The full loop, in block order:

| Step | Transaction |
| --- | --- |
| Uniswap v3 swap, 0.40 USDC to 2.582956 W0G, seeding the strategy's W0G side | [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52) |
| `setAgent` registers the signing agent on the board | [`0x177ca949…a04f`](https://basescan.org/tx/0x177ca949be4e6783b212f3339bff7e651e3ee3deba5e3f6831834e39b0b9a04f) |
| Aqua `ship`: one two-sided strategy, 2 W0G and 0.5 USDC, 30 bps fee | [`0xd342a0ff…181d`](https://basescan.org/tx/0xd342a0ff7a74e1a565ac80116af42f6ff00d2be2c97ff1db293b17c0f19b181d) |
| Signed quote posted, USDC to W0G | [`0x7b2433ba…daec`](https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec) |
| Signed quote posted, W0G to USDC | [`0x79598fe4…d97e`](https://basescan.org/tx/0x79598fe4e59c56cbf7dfb7099955030ac52fb4da4d5d1695119bcd2f7bf1d97e) |
| Fill through AquaSwapVMRouter, 0.1 USDC to 0.642507 W0G at the signed rate | [`0x62f874c5…81a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1) |

Strategy hash `0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e`. After the fill, Aqua `safeBalances` reads 1.357492788767429240 W0G and 0.6 USDC: the exact deltas the signed quote set.

Pinned infrastructure on Base: [Aqua](https://basescan.org/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a), [AquaSwapVMRouter](https://basescan.org/address/0x111111338c5091E8440b67B168bAe16a668AC0De), [W0G](https://basescan.org/address/0x23cd099eB438CcA50349EE2BC809196b1ae00861), [USDC](https://basescan.org/address/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), [Uniswap v3 W0G/USDC 0.3%](https://basescan.org/address/0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e).

## One inference, onchain

The two live quotes were priced by 0G router request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa` on `0gm-1.0-35b-a3b`, billed at 29 micro-USD. The board stores its hash with the quote, and anyone can recompute it:

```sh
cast call 0x309933CE439Da6A059593d73B8c82E8C8447C3F8 \
  "getQuote(address,address,address)((address,address,address,uint256,uint64,uint64,bytes32))" \
  0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0x23cd099eB438CcA50349EE2BC809196b1ae00861 \
  --rpc-url https://base-rpc.publicnode.com
# inferenceId 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7

cast keccak "5319a0b6-562e-4bbe-a141-dfb94fc20aaa0x833589fCD6eDb6E08f4c7C32D4f71b54bdA029130x23cd099eB438CcA50349EE2BC809196b1ae00861"
# 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7
```

## The brain pays for itself, onchain

The agent's wallet funds its own 0G compute account through the same path the runtime takes, then its inference bills in 0G against that balance.

| Step | Chain | Transaction |
|---|---|---|
| Native 0G for gas, 0.30 USDC in via LI.FI | Base | [0xa43b...883c](https://basescan.org/tx/0xa43b662266bd967afbeeb4feb17ea67fc3aa4c7804dfc379f47a27e29a44883c) |
| `ccipSend` 1.0 W0G to 0G chain | Base | [0xd0b4...876e](https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e) |
| `W0G.withdraw` | 0G | [0x6e12...5a0d](https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d) |
| `PaymentLayer.depositFor(agent)`, credit 0 to 2.844 0G | 0G | [0x8b0b...3f68](https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68) |

Router request `798fb102-9f06-4bc5-9ec2-1dde3b716628` then billed `"currency":"0g"` for 0.00004166 0G, and the agent's Payment Layer balance moved from 2.844 to 2.344 0G as the router drew its working deposit from that vault:

```sh
cast call 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32 "balanceOf(address)(uint256)" \
  0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 --rpc-url https://evmrpc.0g.ai
```

## What the chain enforces

The board and extruction check, on every fill: quote freshness, strictly increasing nonces per maker, the token pair, the maker, the registered agent and its epoch (any `setAgent` retires every outstanding quote), and a nonzero `inferenceId`. Pricing belongs to the agent by design: the board reads no oracle, and the brain rejects any rate more than 3% from the Uniswap mid before the signer sees it. Details in [ARCHITECTURE.md](ARCHITECTURE.md#trust-boundaries).

## Repository layout

```
contracts/   Foundry. AgentQuoteBoard, AgentQuoteExtruction, Deploy and ShipStrategy scripts,
             fork tests against the deployed Aqua and AquaSwapVMRouter on Ethereum and Base
agent/       Bun and TypeScript runtime
  src/       runtime, brain, budget, price, signer, poster, taker, funding, status
  scripts/   fork-e2e, fork-setup, live-check, live-bootstrap, live-brain, live-quote-fill
  test/      unit tests for policy, parsing, signing and funding plans
web/         Next.js 16, wagmi 3, Tailwind 4: taker swap and brain ledger
  scripts/   dev-fork.sh runs the whole stack on a local Base fork
docs/        architecture.json and the rendered ARCHITECTURE.html
```

## Quick start

Requires [Foundry](https://book.getfoundry.sh) (solc 0.8.30, `anvil`) and [Bun](https://bun.sh). Clone with `--recurse-submodules`.

Contracts, forked against the live Aqua deployments:

```sh
cd contracts
forge test --match-contract AgentQuoteTest -vv   # Ethereum mainnet fork
forge test --match-contract BaseW0GTest -vv      # Base fork, real W0G/USDC pair
```

Agent unit tests and typecheck:

```sh
cd agent
bun install
bun test
bunx tsc --noEmit
```

Agent end to end on a Base fork. Spawns anvil, deploys the board and extruction, ships the strategy, signs and posts a quote, fills 5 USDC, checks both token deltas, proves the `StaleQuote` revert after expiry and reads the status API schema:

```sh
cd agent
bun run fork-e2e
```

Full stack on a Base fork: anvil, deploy and ship, signed prices, the agent runtime loop, the status API on port 8787 and the web app on port 3100 with a funded taker account:

```sh
web/scripts/dev-fork.sh
```

Read-only checks against live Base and 0G chain state, no signing:

```sh
cd agent
bun run live-check
```

## Environment

Names only. Templates: `agent/.env.example` and `web/.env.example`; the Foundry scripts read theirs from the shell.

| Scope | Variables |
| --- | --- |
| Chains | `BASE_RPC_URL`, `ZG_RPC_URL`, `ETH_RPC_URL` |
| 0G router | `ZG_API_KEY`, `ZG_API_BASE` |
| Identity | `AGENT_PK`, `AGENT_ADDRESS`, `MAKER_ADDRESS`, `BOARD_ADDRESS`, `ORDER_JSON` |
| Budget | `SPEND_CAP_PER_DAY_WEI`, `QUOTE_TTL_SECONDS`, `INFERENCE_COST_PER_TOKEN_WEI` |
| Funding | `FUNDING_THRESHOLD_USDC`, `FUNDING_SLIPPAGE_BPS`, `ZG_GAS_RESERVE_WEI`, `CCIP_TIMEOUT_MS`, `PAYMENT_LOG_LOOKBACK_BLOCKS` |
| Status API | `STATE_PATH`, `PORT`, `WEB_ORIGIN` |
| Contracts | `DEPLOYER_PK`, `MAKER_PK`, `BOARD`, `EXTRUCTION`, `W0G_AMOUNT`, `USDC_AMOUNT`, `FEE_BPS` |
| Worker | `BASE_RPC_URL`, `BASE_LOGS_RPC_URL`, `ZG_RPC_URL`, `QUOTE_TTL_SECONDS`, `SPEND_CAP_PER_DAY_WEI`, KV binding `UPKEEP_KV`, secrets `AGENT_PK` and `ZG_API_KEY` |
| Web | `NEXT_PUBLIC_AGENT_URL`, `NEXT_PUBLIC_BASE_RPC_URL`, `NEXT_PUBLIC_RPC_URL`, `NEXT_PUBLIC_DEV_ACCOUNT`, `NEXT_PUBLIC_FILL_FROM_BLOCK`, `NEXT_PUBLIC_FILL_LOOKBACK_BLOCKS` |

Keys are read only from the process environment and are never written or logged.

## Sponsors

| Sponsor | What Wick uses | Where |
| --- | --- | --- |
| 1inch | Aqua holds the two-sided W0G/USDC strategy; SwapVM v1.0.2 Extruction at opcode `0x20` gates every fill on the agent's signed quote, on the deployed, unmodified AquaSwapVMRouter | `contracts/src/AgentQuoteExtruction.sol`, `contracts/script/ShipStrategy.s.sol`, `agent/src/taker.ts` |
| Uniswap | The v3 W0G/USDC 0.3% pool on Base is the reference mid the brain must stay within 3% of, and the venue that converts USDC fees to W0G through QuoterV2 and SwapRouter02 | `agent/src/price.ts`, `agent/src/funding.ts` |
| 0G | Private Computer router for every pricing decision, with request ids bound into onchain quotes and per-call billed cost; the Payment Layer balance drives the budget tier and receives `depositFor` from fee income | `agent/src/brain.ts`, `agent/src/budget.ts`, `agent/src/funding.ts` |

Chainlink CCIP carries W0G from Base to 0G chain inside the funding leg (`agent/src/funding.ts`).

## Built for ETHGlobal Mumbai 2026

Wick is entered in the Continuity track. Development started before the ETHGlobal Mumbai 2026 event window, and the git history records every commit with its date.

## License

[MIT](LICENSE)
