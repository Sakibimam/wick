# Wick demo script

Runtime 2:50. Every frame is the live app, a real wallet, a terminal or an explorer page. One protagonist: the agent. One trader: the judge's own wallet on `https://wick.earn-shield-alerts.workers.dev`.

**The hook** (said at 0:12 and again at the end): Wick is a trading agent that pays its own AI bill.

**The closing number:** read live from the swap receipt during the take ("Your trade funded N of Wick's next decisions"), never typed into the edit. The receipt divides the fill's fee by the last 0G-billed run, the same source and rounding as the hero's decisions per 1 USDC; at the last run's cost on 2026-11-06 it is about 8 per 10 cents, so a 0.05 USDC swap reads about 4 ([docs/ECONOMICS.md](ECONOMICS.md)).

## Beats

| Time | On screen | Narration | Live evidence held on screen |
| --- | --- | --- | --- |
| 0:00 to 0:12 | The X post, full frame, the quoted line highlighted | "A builder ran a trading agent in a live league. He wrote: 'the host running my enclave ran out of credits and the agent flatlined for 3 days in the middle of the league.'" | https://x.com/Big14teru/status/2082055357388525631 |
| 0:12 to 0:22 | `/ledger`: the 0G compute balance and the budget tier | "Wick is a trading agent that pays its own AI bill. This is its compute account on 0G. It was seeded once, through the agent's own rail. Once seeded, its trades are what refill it." | Payment Layer balance in 0G, tier NORMAL, spend against the 1 0G daily cap |
| 0:22 to 0:40 | `/ledger` inference row, then the agent's `postPair` tx on Basescan with `inferenceId` highlighted | "Every few minutes Wick asks a model on 0G Private Computer for a price. That call has a request id and a bill: about 0.00027 0G. Wick signs both sides of the price in one transaction and stamps it with the request's fingerprint." | 0G request id and billed cost from `/api/status`; the latest `postPair` tx linked from the ledger |
| 0:40 to 1:05 | Swap page. The judge taps "Pay 0.05 USDC", the real wallet popup, confirm; the receipt line appears | "A judge swaps five cents from their own wallet. The 1inch pool checks the agent's signature on chain and pays the signed price minus a 0.30% fee. And the page says it straight: your trade funded" (read the receipt's number as it appears) "of Wick's next decisions." | Swap page receipt: "Your trade funded N of Wick's next decisions." (fee divided by the last 0G-billed run, `web/components/swap-ticket.tsx`), the fill tx on Basescan |
| 1:05 to 1:30 | Editor: `web/wrangler.jsonc`, `vars.SPEND_CAP_PER_DAY_WEI` set to `"0"`, then `cd web && bun run cf:deploy`; `/ledger` tier flips to PAUSED; the swap page countdown on the signed price runs out | "Now we cut its AI budget to zero and redeploy. The tier drops to PAUSED: no more model calls, so no more signed prices. Watch the countdown on the last one." | Ledger tier PAUSED with reason `spend_cap_reached`; countdown at 0:00 |
| 1:30 to 2:00 | Swap page, same 0.05 USDC; the wallet simulation fails; `/api/quote` returns 409; then `/ledger` AI runs with a "Refused" guard chip expanded | "Same swap again. The 1inch router on Base mainnet refuses it: StaleQuote. No paid thought, no trade. The chain enforces it, not our server. And Wick refuses its own model too: here the model leaned the price the wrong way for its inventory, the guard dropped the answer before the signer, and the last good price went back up." | Wallet error `StaleQuote` from AquaSwapVMRouter `0x11111133…C0De`; `GET /api/quote` body `StaleQuote, the signed price expired`; a ledger row "Refused: skew against inventory" with its guard check and request id |
| 2:00 to 2:08 | Terminal: the end of `cd hook && forge test --match-test test_fork_liveWickOrder_fillsFromLiveAgentQuote -vvvv` on a Base mainnet fork, PASS, then the live hook on Basescan | "Any Uniswap router reaches the same signed price through Wick's v4 hook." | The trace's `PoolManager.swap` into `AquaSwapVMRouter.swap` and PASS line; the live hook `0x1A35d13A…2888` |
| 2:08 to 2:30 | Terminal, a second agent: `cd quotes && bun run pay`. HTTP 402, the USDC authorization, then the quote JSON; `/v1/stats` | "Other agents pay for its prices. This one asks for a quote, gets 402 Payment Required, signs one cent of USDC, and gets back Wick's live signed price and the 0G request behind it. That cent lands in the maker wallet on Base, next to the swap fees." | 402 body with `maxAmountRequired` 10000; settlement tx on Basescan; `/v1/stats` `paidQuotes` and `revenueUsdc` |
| 2:30 to 2:42 | `/ledger` funding rows: CCIP send, `W0G.withdraw`, `depositFor`, then the next request billed in 0G; the Fees card's "Next funding run" | "This is the rail that seeded its vault. Once fees reach three times the live bridge cost, Wick ships them the same way, over Chainlink to the 0G chain and into its own compute account, and every thought is billed from there." | CCIP https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e, deposit https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68, request billed `"currency":"0g"` |
| 2:42 to 2:50 | Black frame, one number: the receipt's N from the 0:40 take | "Five cents of trading." (N) "decisions. Wick, the trading agent that pays its own AI bill." | End card: `https://wick.earn-shield-alerts.workers.dev`, github.com/Sakibimam/wick |

## Recording notes

- Start the 1:05 beat when the swap page countdown reads under 0:30, so the expiry lands on camera without a cut. A signed price lives at most 900 s (`MAX_TTL`).
- Restore the cap after the take: set `vars.SPEND_CAP_PER_DAY_WEI` in `web/wrangler.jsonc` back to `"1000000000000000000"` and run `bun run cf:deploy` again. It is a Worker var, not a secret, so `wrangler secret put` does not change it. The next cron tick infers and posts a fresh pair.
- The 0:40 swap and the 1:30 swap are the same wallet and the same amount, so the only change between a fill and a refusal is the agent's budget.
- The swap ticket's "Pay" preset is 0.05 USDC or the live pair's signed `maxAmountIn`, whichever is smaller; record the 0:40 beat on a pair whose USDC `maxAmountIn` is at least 0.05 USDC.
- Pick the refusal row live from the ledger's AI runs; the guard refuses a few answers a day on its own.

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
