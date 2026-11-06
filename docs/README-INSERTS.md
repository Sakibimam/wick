# README inserts

Paragraphs ready to paste into README.md. Each block names the README section it belongs under.

## Under the opening line

Wick is a trading agent that pays its own AI bill. It runs a 1inch Aqua market-making strategy on Base whose every fill pays a 30 bps fee, and those fees fund the 0G Private Computer inference that sets its next price. One 10 cent trade pays for about 7 decisions: a fee of 0.0003 USDC against 36 to 41 micro-USD per 0G-billed run ([docs/ECONOMICS.md](docs/ECONOMICS.md)).

## How a price is made

Every 5 minutes a Cloudflare Workers cron reads the Uniswap v3 W0G/USDC spot and 600 second TWAP, the agent's 0G compute balance and its Base gas. When the price has moved 25 bps or the live quote is within 600 s of expiry, one 0G call (`verify_tee: true`) returns spread, skew, size and lifetime with a reason. Code centres both directions on the TWAP, signs them as one EIP-712 pair carrying the 0G request id, provider and TEE verdict, and posts it with a single `postPair`. The model chooses how to quote; it never writes the price.

## What the chain enforces on every fill

`AgentQuoteExtructionV2` runs inside the deployed, unmodified AquaSwapVMRouter v1.0.2 at Aqua opcode `0x20`. A fill succeeds only when the quote comes from the agent's current epoch, is unexpired (at most 900 s from posting), sits within 800 bps of the 600 s TWAP read from `observe()`, and the swap is within the quote's `maxAmountIn` and the strategy's depth. Rotating the agent opens a new epoch, which retires every outstanding quote and resets the nonce space a leaked key could exhaust. Threat model and every parameter with its source: [ARCHITECTURE.md](ARCHITECTURE.md#threat-model).

## Three ways to trade with Wick

| Door | Who uses it | How |
| --- | --- | --- |
| Swap page | a person with a wallet | `https://wick.earn-shield-alerts.workers.dev`, fills through AquaSwapVMRouter at the signed price |
| Uniswap v4 hook | any Uniswap router | `hook/src/AquaAggregatorHook.sol` turns the strategy into a v4 pool on `BaseAggregatorHook`; fork-tested through the deployed Universal Router 2.1.2 |
| x402 quote API | another agent | `GET https://wick-quotes.earn-shield-alerts.workers.dev/v1/quote?tokenIn=USDC&amountIn=100000` answers 402; pay 0.01 USDC with an EIP-3009 authorization and receive the live signed quote and the 0G request behind it |

## How fees reach 0G

Inside the same cron, a resumable funding machine swaps fee USDC to W0G on Uniswap v3, sends it over Chainlink CCIP to the 0G chain, unwraps it, and calls `PaymentLayer.depositFor` on the agent's own compute account, one chain step per tick. A run fires only when the unfunded fees are worth 3 times its own cost (CCIP fee plus gas, about $0.75 today), and it never touches the inventory the strategy has committed. The same machine buys Base gas from fee USDC when the gas wallet falls under 0.0001 ETH.

## When money runs low

Spend is counted from the router's own per-request bill, against a 1 0G daily cap. Under 0.5 0G the agent moves to a cheaper model and doubles its spread floor; under 0.1 0G it stops calling the model; at the cap, under 0.05 0G, or under 0.00003 ETH of gas it stops posting, and the strategy refuses every fill with `StaleQuote` until fees refill it.

## Numbers, with their source

| Number | Value | Source |
| --- | --- | --- |
| 0G cost per decision | 0.000243 to 0.000281 0G | router requests `286d605d…`, `1002ff0b…`, `65073141…`, billed `"currency":"0g"` |
| Gas per requote | $0.00184 | posts `0x5dff60e6…cc23` and `0xb36f6404…863e`, Base blocks 53,784,273 and 53,784,276 |
| CCIP Base to 0G | 0.000109 ETH, delivered in 1,427 s | `ccipSend 0xd0b46ef5…876e` |
| Break-even swap volume per requote | $0.63 | $0.00188 all-in divided by the 30 bps fee |
| Compute vault | 2.344 0G | Payment Layer `balanceOf(agent)`, 0G block 49,436,077 |
