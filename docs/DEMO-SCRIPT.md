# Wick demo script

Runtime 2:50. Every frame is the live app, a real wallet, a terminal or an explorer page. One protagonist: the agent. One trader: the judge's own wallet on `https://wick.earn-shield-alerts.workers.dev`.

**The hook** (said at 0:12 and again at the end): Wick is a trading agent that pays its own AI bill.

**The closing number:** 7. One 10 cent trade pays for 7 of Wick's next decisions (fee 0.0003 USDC, 40 micro-USD per decision, [docs/ECONOMICS.md](ECONOMICS.md)).

## Beats

| Time | On screen | Narration | Live evidence held on screen |
| --- | --- | --- | --- |
| 0:00 to 0:12 | The X post, full frame, the quoted line highlighted | "A builder ran a trading agent in a live league. He wrote: 'the host running my enclave ran out of credits and the agent flatlined for 3 days in the middle of the league.'" | https://x.com/Big14teru/status/2082055357388525631 |
| 0:12 to 0:22 | `/ledger`: the 0G compute balance and the budget tier | "Wick is a trading agent that pays its own AI bill. This is its compute account on 0G. Nobody tops it up. Its trades do." | Payment Layer balance in 0G, tier NORMAL, spend against the 1 0G daily cap |
| 0:22 to 0:40 | `/ledger` inference row, then the agent's `postPair` tx on Basescan with `inferenceId` highlighted | "Every few minutes Wick asks a model on 0G Private Computer for a price. That call has a request id and a bill: about 0.00027 0G. Wick signs both sides of the price in one transaction and stamps it with the request's fingerprint." | 0G request id and billed cost from `/api/status`; the latest `postPair` tx linked from the ledger |
| 0:40 to 1:05 | Swap page. The judge enters 0.10 USDC, the real wallet popup, confirm; the receipt line appears | "A judge swaps ten cents from their own wallet. The 1inch pool checks the agent's signature on chain and pays the signed price minus a 0.30% fee. And the page says it straight: your trade funded about 7 of Wick's next decisions." | Swap page receipt: "Your trade funded about 7 of Wick's next decisions." (fee divided by the last 0G-billed run, `web/components/swap-ticket.tsx`), the fill tx on Basescan |
| 1:05 to 1:30 | Terminal: `bunx wrangler secret put SPEND_CAP_PER_DAY_WEI` with value 0; `/ledger` tier flips to PAUSED; the swap page countdown on the signed price runs out | "Now we cut its AI budget to zero. The tier drops to PAUSED: no more model calls, so no more signed prices. Watch the countdown on the last one." | Ledger tier PAUSED with reason `spend_cap_reached`; countdown at 0:00 |
| 1:30 to 1:48 | Swap page, same 0.10 USDC; the wallet simulation fails; `/api/quote` returns 409 | "Same swap again. The 1inch router on Base mainnet refuses it: StaleQuote. No paid thought, no trade. The chain enforces it, not our server." | Wallet error `StaleQuote` from AquaSwapVMRouter `0x11111133…C0De`; `GET /api/quote` body `StaleQuote, the signed price expired` |
| 1:48 to 2:08 | Terminal: `cd hook && forge test --match-test test_fork_liveWickOrder_fillsFromLiveAgentQuote -vvvv` on a Base mainnet fork; the trace scrolls from the Universal Router through `PoolManager.swap` into the hook and `AquaSwapVMRouter.swap` | "Wick brings its own takers. Its Uniswap v4 hook turns the strategy into a Uniswap pool: a swap through Uniswap's own Universal Router fills from the agent-signed price, under the same checks, or reverts StaleQuote." | Forge trace against the deployed PoolManager `0x498581fF…2b2b` and Universal Router `0xd6145b2D…9c40`, the Aqua `Pulled` and `Pushed` events inside the v4 swap, test PASS; then the live hook `0x1A35d13A…2888` on Basescan with its v4 pool `0xba432fbc…785e` |
| 2:08 to 2:30 | Terminal, a second agent: `cd quotes && bun run pay`. HTTP 402, the USDC authorization, then the quote JSON; `/v1/stats` | "Other agents pay for its prices. This one asks for a quote, gets 402 Payment Required, signs one cent of USDC, and gets back Wick's live signed price and the 0G request behind it. That cent lands in the maker wallet on Base, next to the swap fees." | 402 body with `maxAmountRequired` 10000; settlement tx on Basescan; `/v1/stats` `paidQuotes` and `revenueUsdc` |
| 2:30 to 2:42 | `/ledger` funding run: CCIP send, `W0G.withdraw`, `depositFor`, then the next request billed in 0G | "When fees are worth three times the bridge cost, Wick ships them over Chainlink to the 0G chain and deposits them into its own compute account, and its next thought is billed from there." | CCIP https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e, deposit https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68, request billed `"currency":"0g"` |
| 2:42 to 2:50 | Black frame, one number: **7** | "Ten cents of trading. Seven decisions. Wick, the trading agent that pays its own AI bill." | End card: `https://wick.earn-shield-alerts.workers.dev`, github.com/Sakibimam/wick |

## Recording notes

- Start the 1:05 beat when the swap page countdown reads under 0:30, so the expiry lands on camera without a cut. A signed price lives at most 900 s (`MAX_TTL`).
- Restore the cap after the take: `bunx wrangler secret put SPEND_CAP_PER_DAY_WEI` with `1000000000000000000`. The next cron tick infers and posts a fresh pair.
- The 0:40 swap and the 1:30 swap are the same wallet and the same amount, so the only change between a fill and a refusal is the agent's budget.
- The swap ticket caps the amount at the live pair's signed `maxAmountIn`, which the model sets each tick; record the 0:40 beat on a pair whose USDC `maxAmountIn` is at least 0.10 USDC.

## Capture list

| Asset | Source |
| --- | --- |
| The pain | https://x.com/Big14teru/status/2082055357388525631, verbatim in `gtm/upkeep/DEMAND.md` |
| Ledger and swap page | `https://wick.earn-shield-alerts.workers.dev/ledger` and `/`, 1440 wide, zoom 1.6x on the element the line names |
| Signed pair | the latest `postPair` tx linked from the ledger, `inferenceId` row highlighted |
| Fill and refusal | the judge's fill tx; the `StaleQuote` wallet error and `curl https://wick.earn-shield-alerts.workers.dev/api/quote?...` body |
| Uniswap v4 hook path | `cd hook && forge test --match-test test_fork_liveWickOrder_fillsFromLiveAgentQuote -vvvv` (Base fork, deployed PoolManager and Universal Router) |
| x402 paid quote | `cd quotes && bun run pay`, its settlement tx, then `GET /v1/stats` |
| Funding run | the ledger's funding rows; CCIP and 0G explorer pages above |
| Billed in 0G | the router response with `"currency":"0g"` and `cast call 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32 "balanceOf(address)(uint256)" 0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 --rpc-url https://evmrpc.0g.ai` |

Explorer frames are 2x captures with the named row highlighted, held 3 to 4 seconds while the narration names them. Captions are burned in for every line.
