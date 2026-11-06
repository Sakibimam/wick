# Wick economics

## In plain words

Wick is a market maker. Every swap against its Aqua strategy pays a 0.30% fee. Wick spends that fee on three things: the AI call that sets its next price on 0G, the Base gas to post that price, and, now and then, one bridge trip that refills its 0G compute account.

The AI call is the cheap part. One pricing decision costs about 40 millionths of a dollar. The live app computes decisions per dollar traded from the last 0G-billed run: at the last run's cost on 2026-11-06 ($0.000038) a 10 cent swap pays for about 8 decisions. Gas to post the signed price on Base costs about 28 times the AI call, so gas sets the break-even line. A requote breaks even at about 38 cents of swap volume. Other agents also pay 1 cent in USDC over x402 for each signed quote they read, and one paid quote covers about 9 requotes.

Every number below names the call, transaction or file that produced it.

## Measured unit costs

| Line | Value | Measurement |
| --- | --- | --- |
| Inference, USD-billed account | 29 micro-USD per decision | router request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa`, `x_0g_trace.billing.total_cost_usd_micro`, `0gm-1.0-35b-a3b`; 26 micro-USD with `enable_thinking: false` on the same prompt (thinking on: 159 micro-USD, 274 reasoning tokens) |
| Inference, 0G-billed account (live) | 0.000243 to 0.000281 0G per decision, 36 to 41 micro-USD at the pool mid | requests `286d605d-7b73-4b09-882c-6605e2bcf64e` (243,358,666,666,666 wei), `1002ff0b-2daf-48ae-b697-daa672d2dd47` (281,198,000,000,000 wei), `65073141-8324-44a8-b819-c0f421c55ff8` (272,018,666,666,666 wei); mid 0.14713 USDC per W0G from `/api/status` at Base block 53,796,598 |
| One decision prices both directions | 1 inference per requote | one EIP-712 `Pair` carries both rates and one `inferenceId = keccak256(abi.encode(requestId, provider, teeVerified))` (`agent/src/worker-tick.ts`) |
| Gas per requote, v2 `postPair` | 82,443 gas, about 496,000,000,000 wei, $0.00110 | three `postPair` calls against the deployed AgentQuoteBoardV2 `0x0d87944F…18A5` on an anvil fork of Base at block 53,813,705: 244,743 gas for the first write, 82,443 gas for each one after; 0.006 gwei plus the L1 fee measured on the live v1 posts below |
| Gas per requote, v2 `postPair` live | 88,391 gas, 535,835,276,836 wei with the L1 fee, $0.00119 | cron `postPair` [`0xe75b8628…5ef3`](https://basescan.org/tx/0xe75b86286eaff73792f585adf0fee3741a40292c718a415bb83aa697679e5ef3) on the live AgentQuoteBoardV2, Base block 53,818,900: 88,391 gas at 0.006 gwei plus L1 fee 5,489,276,836 wei; the epoch's first `postPair` [`0x992d1b3d…1d27`](https://basescan.org/tx/0x992d1b3d3f8b5718aa233bcd31a2e2dd2d2ae924245c3c39b95f2e50fc771d27) wrote fresh storage at 245,079 gas; ETH $2,216.67 as below |
| Gas per requote, v1 (two quote posts) | 829,501,116,200 wei, $0.00184 | posts `0x5dff60e6…cc23` (69,007 gas, L1 fee 1,095,219,553 wei) and `0xb36f6404…863e` (68,887 gas, L1 fee 1,041,896,647 wei), Base blocks 53,784,273 and 53,784,276, 0.006 gwei; ETH $2,216.67 from Chainlink ETH/USD `latestRoundData` on Base at block 53,797,130 |
| Gas per requote, historical sample | $0.0013 to $0.0014 | `spikes/fact3-economics/gas.txt` and `base_l1fee.txt`: Base dock plus ship median 91,397 gas, L1 part median under $0.00001 |
| Fill fee at 30 bps | 0.0003 USDC on a 0.10 USDC swap | fill `0x62f874c5…c7a1`, `fees.accruedUsdc` 300 atomic in `/api/status` |
| CCIP Base to 0G chain | 0.000109 ETH flat, $0.24 | `ccipSend` `0xd0b46ef5…876e`, fee 109,248,091,917,380 wei; delivered 1.0 W0G in 1,427 s; `spikes/fact2-funding/FINDINGS.md` measured 0.000108 ETH (about $0.26 at that day's ETH) |
| Funding leg gas on Base | 482,000 gas budget | `FUEL_GAS_UNITS` in `agent/src/funding-machine.ts` (approve, swap, approve, ccipSend) |
| x402 paid quote | 0.01 USDC per signed quote | `PRICE_ATOMIC` 10,000 in `quotes/wrangler.jsonc`; settled by `transferWithAuthorization` to the maker, facilitator pays gas (`quotes/src/chain.ts`) |

Planning figures used below: inference 40 micro-USD (the top of the 0G-billed range), gas $0.00110 per v2 requote, so one requote costs **$0.00114 all-in**. One `postPair` replaces the two v1 posts and uses 40% less gas (82,443 against 137,894).

## Break-even

A swap of volume V pays `V x 0.0030` in fees.

| Covers | Cost | Swap volume to break even | Math |
| --- | --- | --- | --- |
| one decision, inference only | $0.000040 | $0.013 | 0.000040 / 0.003 |
| one requote, inference plus gas | $0.00114 | $0.38 | 0.00114 / 0.003 |
| one funding run (k = 3) | $0.75 threshold | $250 | 3 x ($0.242 CCIP + $0.0064 Base gas) / 0.003 |

**What a 0.10 USDC swap funds.** Fee 0.0003 USDC. Divided by the last 0G-billed run on 2026-11-06, 0.0002547 0G or $0.000038 at the pool mid, that is 7.9, so one 10 cent trade funds about 8 of Wick's next decisions and 1 USDC traded funds about 80. The hero, the swap receipt, the ledger's fill rows and the share card all divide by that same last run and round to the nearest decision, so the figure moves with the live cost. At the planning figure of 40 micro-USD it is 7.5. Against the all-in requote cost it is 0.26 requotes.

**Per day.** Wick requotes on a 25 bps TWAP move or when its live pair is within 600 s of expiry. v2 pairs live 840 to 900 s and renew inside a 360 s window, so a steady pair renews every second 5 minute tick: 144 requotes a day, the `requotesPerDay` the status route reports. The ceiling is one pair per tick, 288 a day, and the tables below use that ceiling. Daily cost is `requotes/day x $0.00114`.

| Cadence | Requotes/day | Cost/day | Swap volume/day to break even |
| --- | --- | --- | --- |
| v1, measured on 2026-11-06 (decisions at 05:10, 05:45 and 06:40 UTC in `/api/status`) | about 29 | $0.033 | $11 |
| v2, live: a pair every second cron tick | 144 | $0.164 | $55 |
| v2 ceiling, one pair per 5 minute cron tick | 288 | $0.328 | $109 |

## Funding threshold

Fees reach the 0G account in one resumable run: swap the USDC share to W0G on Uniswap v3, `ccipSend` to the 0G chain, `W0G.withdraw`, then `PaymentLayer.depositFor`. The run fires only when the unfunded fees are worth `k` times what the run itself costs:

```
cost      = ccipFee + FUEL_GAS_UNITS x baseGasPrice + zeroGGas
threshold = k x cost            (k = 3, agent/src/funding-machine.ts decideFunding)
fire      = unfunded fee value >= threshold
```

At today's reads that is `3 x (0.000109 ETH + 482,000 x 0.006 gwei) = 0.000336 ETH`, about $0.75; the live threshold the status route reported on 2026-11-06 is 0.81 USDC (`fundingThresholdUsdc`). With k = 3 the bridge fee is at most a third of every run, and the threshold follows the live CCIP `getFee` and Base gas price instead of a fixed dollar figure. Only fees fund a run: `spendable = min(unfunded fees, wallet balance above the strategy's committed inventory)`, so seed inventory never leaves the strategy.

Gas pays for itself the same way. When the Base balance falls under the gas top-up line, the run of kind `gas` swaps a share of fee USDC to ETH on the Uniswap v3 USDC/WETH 0.05% pool and unwraps it to the agent, again only once the share is worth `k` times the 206,000 gas the leg uses.

## Runway

Read at 0G block 49,436,077 and Base block 53,796,598 (`/api/status`):

| Account | Balance | Burns per requote | Requotes funded |
| --- | --- | --- | --- |
| 0G Payment Layer vault | 2.343959530558679712 0G | 0.000272 0G (median of the three 0G-billed requests) | about 8,600 |
| Base gas wallet, above the 0.00003 ETH gas floor | 0.000194 ETH (0.000224 minus floor) | 0.000000496 ETH | about 391 |

At the v2 cadence of 288 requotes a day the vault covers about 30 days of decisions and the gas wallet about 1.4 days, which is why the funding machine tops gas up from fee USDC whenever the wallet falls under 0.0001 ETH. The 1 0G daily spend cap bounds the vault at 3,676 decisions a day whatever the cadence.

## Revenue lines

1. **Swap fees.** 30 bps of every fill through the Aqua strategy, from three taker doors: the Wick swap page, the Uniswap v4 Aqua aggregator hook, and direct `AquaSwapVMRouter.swap` calls.
2. **x402 paid quotes.** Another agent calls `GET /v1/quote?tokenIn=USDC&amountIn=...`, receives HTTP 402 with the payment requirements, signs a USDC `transferWithAuthorization` for 0.01 USDC, and gets back the live signed quote, the 0G request behind it, and the router's `amountOut` capped at strategy depth. Payment settles to the maker wallet on Base, the wallet the swap fees accrue to, and only when a live signed quote exists; the quote is read before any money moves. One paid quote equals the fee on $3.33 of swap volume, covers 8.8 requotes all-in, or 250 decisions.

## Worked examples

Turnover is the share of a strategy's depth that trades per day, measured over every filled Aqua strategy on Base for 7 days (Base blocks 53,216,777 to 53,519,177, `spikes/fact1-fills/stats.txt`): median 0.02x, p75 0.05x, p90 0.11x.

**Small maker: $100 of depth at Base p90 turnover (0.11x/day).**

```
volume/day  = 100 x 0.11            = $11.00
fees/day    = 11.00 x 0.0030        = $0.033
bill/day    = 288 x 0.00114         = $0.328 at the v2 cadence
covered     = 0.033 / 0.328         = 10% from fees, the rest from the 2.34 0G vault and the gas wallet
```

**Break-even depth.** At Base p90 turnover and the v2 cadence the bill is covered once `depth x 0.11 x 0.003 >= 0.328`, at **$994 of depth**. At the Base p75 turnover of 0.05x it is $2,187.

**Realistic maker: $2,000 of depth at Base p90 turnover (0.11x/day), requoting on every 5 minute tick.**

```
volume/day  = 2,000 x 0.11          = $220.00
fees/day    = 220 x 0.0030          = $0.660
gas         = 288 x 0.00110         = $0.317 per day, paid by the fee-funded gas leg
inference   = 288 x 0.000040        = $0.0115 per day
bridge      = (0.660 - 0.317) / day reaches the $0.75 threshold every 2.2 days
            = 0.248 / 2.2           = $0.113 per day
surplus     = 0.660 - 0.317 - 0.0115 - 0.113 = $0.219 per day
```

At this size every tick can requote and the strategy keeps a surplus after its gas, its 0G bill and its bridge trips. Ten paid x402 quotes a day add another $0.10.

## Price risk the parameters price in

Fees are only half of a maker's P&L; the other half is the price it fills at. Over the same Aqua sample, stable-stable strategies netted +2.5 bps (Ethereum) and +12 bps (Base), and volatile pairs netted -48 bps aggregate on Ethereum at mark (`spikes/fact1-fills/stats.txt`). That is why every Wick fill is held inside a band around the 10 minute Uniswap v3 TWAP and capped at the quote's `maxAmountIn`, and why a signed price lives at most 900 seconds: the parameters in [ARCHITECTURE.md](../ARCHITECTURE.md#parameters) bound how far a fill can sit from the market, so the fee line above is not given back on the price line.
