# Wick economics

## In plain words

Wick is a market maker. Every swap against its Aqua strategy pays a 0.30% fee. Wick spends that fee on three things: the AI call that sets its next price on 0G, the Base gas to post that price, and, now and then, one bridge trip that refills its 0G compute account.

The AI call is the cheap part. One pricing decision costs about 40 millionths of a dollar, so a 10 cent swap pays for about 7 decisions. Gas to post the signed price on Base costs about 50 times the AI call, so gas sets the break-even line. A requote breaks even at about 63 cents of swap volume. Other agents also pay 1 cent in USDC over x402 for each signed quote they read, and one paid quote covers about 5 requotes.

Every number below names the call, transaction or file that produced it.

## Measured unit costs

| Line | Value | Measurement |
| --- | --- | --- |
| Inference, USD-billed account | 29 micro-USD per decision | router request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa`, `x_0g_trace.billing.total_cost_usd_micro`, `0gm-1.0-35b-a3b`; 26 micro-USD with `enable_thinking: false` on the same prompt (thinking on: 159 micro-USD, 274 reasoning tokens) |
| Inference, 0G-billed account (live) | 0.000243 to 0.000281 0G per decision, 36 to 41 micro-USD at the pool mid | requests `286d605d-7b73-4b09-882c-6605e2bcf64e` (243,358,666,666,666 wei), `1002ff0b-2daf-48ae-b697-daa672d2dd47` (281,198,000,000,000 wei), `65073141-8324-44a8-b819-c0f421c55ff8` (272,018,666,666,666 wei); mid 0.14713 USDC per W0G from `/api/status` at Base block 53,796,598 |
| One decision prices both directions | 1 inference per requote | one EIP-712 `Pair` carries both rates and one `inferenceId = keccak256(abi.encode(requestId, provider, teeVerified))` (`agent/src/worker-tick.ts`) |
| Gas per requote (two quote posts) | 829,501,116,200 wei, $0.00184 | posts `0x5dff60e6…cc23` (69,007 gas, L1 fee 1,095,219,553 wei) and `0xb36f6404…863e` (68,887 gas, L1 fee 1,041,896,647 wei), Base blocks 53,784,273 and 53,784,276, 0.006 gwei; ETH $2,216.67 from Chainlink ETH/USD `latestRoundData` on Base at block 53,797,130 |
| Gas per requote, historical sample | $0.0013 to $0.0014 | `spikes/fact3-economics/gas.txt` and `base_l1fee.txt`: Base dock plus ship median 91,397 gas, L1 part median under $0.00001 |
| Fill fee at 30 bps | 0.0003 USDC on a 0.10 USDC swap | fill `0x62f874c5…c7a1`, `fees.accruedUsdc` 300 atomic in `/api/status` |
| CCIP Base to 0G chain | 0.000109 ETH flat, $0.24 | `ccipSend` `0xd0b46ef5…876e`, fee 109,248,091,917,380 wei; delivered 1.0 W0G in 1,427 s; `spikes/fact2-funding/FINDINGS.md` measured 0.000108 ETH (about $0.26 at that day's ETH) |
| Funding leg gas on Base | 482,000 gas budget | `FUEL_GAS_UNITS` in `agent/src/funding-machine.ts` (approve, swap, approve, ccipSend) |
| x402 paid quote | 0.01 USDC per signed quote | `PRICE_ATOMIC` 10,000 in `quotes/wrangler.jsonc`; settled by `transferWithAuthorization` to the maker, facilitator pays gas (`quotes/src/chain.ts`) |

Planning figures used below: inference 40 micro-USD (the top of the 0G-billed range), gas $0.00184 per requote, so one requote costs **$0.00188 all-in**.

## Break-even

A swap of volume V pays `V x 0.0030` in fees.

| Covers | Cost | Swap volume to break even | Math |
| --- | --- | --- | --- |
| one decision, inference only | $0.000040 | $0.013 | 0.000040 / 0.003 |
| one requote, inference plus gas | $0.00188 | $0.63 | 0.00188 / 0.003 |
| one funding run (k = 3) | $0.75 threshold | $250 | 3 x ($0.242 CCIP + $0.0064 Base gas) / 0.003 |

**What a 0.10 USDC swap funds.** Fee 0.0003 USDC. Divided by 40 micro-USD that is 7.5 decisions, so one 10 cent trade funds about 7 of Wick's next decisions. Against the all-in requote cost it is 0.16 requotes.

**Per day.** Wick requotes on a 25 bps mid move or before its quote expires, never on a fixed clock. Daily cost is `requotes/day x $0.00188`.

| Cadence | Requotes/day | Cost/day | Swap volume/day to break even |
| --- | --- | --- | --- |
| measured on 2026-11-06 (decisions at 05:10, 05:45 and 06:40 UTC in `/api/status`) | about 29 | $0.055 | $18 |
| one requote per 900 s TTL | 96 | $0.18 | $60 |
| one requote every 5 minute cron tick, the ceiling | 288 | $0.54 | $181 |

## Funding threshold

Fees reach the 0G account in one resumable run: swap the USDC share to W0G on Uniswap v3, `ccipSend` to the 0G chain, `W0G.withdraw`, then `PaymentLayer.depositFor`. The run fires only when the unfunded fees are worth `k` times what the run itself costs:

```
cost      = ccipFee + FUEL_GAS_UNITS x baseGasPrice + zeroGGas
threshold = k x cost            (k = 3, agent/src/funding-machine.ts decideFunding)
fire      = unfunded fee value >= threshold
```

At today's reads that is `3 x (0.000109 ETH + 482,000 x 0.006 gwei) = 0.000336 ETH`, about $0.75. With k = 3 the bridge fee is at most a third of every run, and the threshold follows the live CCIP `getFee` and Base gas price instead of a fixed dollar figure. Only fees fund a run: `spendable = min(unfunded fees, wallet balance above the strategy's committed inventory)`, so seed inventory never leaves the strategy.

Gas pays for itself the same way. When the Base balance falls under the gas top-up line, the run of kind `gas` swaps a share of fee USDC to ETH on the Uniswap v3 USDC/WETH 0.05% pool and unwraps it to the agent, again only once the share is worth `k` times the 206,000 gas the leg uses.

## Runway

Read at 0G block 49,436,077 and Base block 53,796,598 (`/api/status`):

| Account | Balance | Burns per requote | Requotes funded |
| --- | --- | --- | --- |
| 0G Payment Layer vault | 2.343959530558679712 0G | 0.000272 0G (median of the three 0G-billed requests) | about 8,600 |
| Base gas wallet, above the 0.00003 ETH gas floor | 0.000194 ETH (0.000224 minus floor) | 0.00000083 ETH | about 233 |

At the measured 29 requotes a day the vault covers about 297 days of decisions and the gas wallet about 8 days, and the 1 0G daily spend cap bounds the vault at 3,676 decisions a day whatever the cadence. Gas is the line the fee-funded gas leg refills first.

## Revenue lines

1. **Swap fees.** 30 bps of every fill through the Aqua strategy, from three taker doors: the Wick swap page, the Uniswap v4 Aqua aggregator hook, and direct `AquaSwapVMRouter.swap` calls.
2. **x402 paid quotes.** Another agent calls `GET /v1/quote?tokenIn=USDC&amountIn=...`, receives HTTP 402 with the payment requirements, signs a USDC `transferWithAuthorization` for 0.01 USDC, and gets back the live signed quote, the 0G request behind it, and the router's `amountOut` capped at strategy depth. Payment settles to the maker wallet on Base, the wallet the swap fees accrue to, and only when a live signed quote exists; the quote is read before any money moves. One paid quote equals the fee on $3.33 of swap volume, covers 5.3 requotes all-in, or 250 decisions.

## Worked examples

Turnover is the share of a strategy's depth that trades per day, measured over every filled Aqua strategy on Base for 7 days (Base blocks 53,216,777 to 53,519,177, `spikes/fact1-fills/stats.txt`): median 0.02x, p75 0.05x, p90 0.11x.

**Small maker: $100 of depth at Base p90 turnover (0.11x/day).**

```
volume/day  = 100 x 0.11            = $11.00
fees/day    = 11.00 x 0.0030        = $0.033
requotes    = 0.033 / 0.00188       = 17.5 per day, gas and inference both paid from fees
inference   = 17.5 x 0.000040       = $0.0007 per day
```

Fees pay for a requote every 82 minutes, so this maker quotes on 25 bps price moves rather than on every tick. The 2.34 0G vault carries the inference side (8,600 decisions) while fees build toward the $0.75 funding run.

**Realistic maker: $2,000 of depth at Base p90 turnover (0.11x/day), requoting on every 5 minute tick.**

```
volume/day  = 2,000 x 0.11          = $220.00
fees/day    = 220 x 0.0030          = $0.660
gas         = 288 x 0.00184         = $0.530 per day, paid by the fee-funded gas leg
inference   = 288 x 0.000040        = $0.0115 per day
bridge      = (0.660 - 0.530) / day reaches the $0.75 threshold every 5.8 days
            = 0.248 / 5.8           = $0.043 per day
surplus     = 0.660 - 0.530 - 0.0115 - 0.043 = $0.076 per day
```

At this size every tick can requote and the strategy keeps a surplus after its gas, its 0G bill and its bridge trips. Ten paid x402 quotes a day add $0.10, more than the whole surplus.

## Price risk the parameters price in

Fees are only half of a maker's P&L; the other half is the price it fills at. Over the same Aqua sample, stable-stable strategies netted +2.5 bps (Ethereum) and +12 bps (Base), and volatile pairs netted -48 bps aggregate on Ethereum at mark (`spikes/fact1-fills/stats.txt`). That is why every Wick fill is held inside a band around the 10 minute Uniswap v3 TWAP and capped at the quote's `maxAmountIn`, and why a signed price lives at most 900 seconds: the parameters in [ARCHITECTURE.md](../ARCHITECTURE.md#parameters) bound how far a fill can sit from the market, so the fee line above is not given back on the price line.
