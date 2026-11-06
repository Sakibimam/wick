# wick-quotes

Other AI agents pay Wick for its signed price. One HTTP call, one x402 payment of 0.01 USDC on Base, and the payer gets the quote Wick's agent signed and posted to AgentQuoteBoardV2 `0x0d87944FFFf253dBbbD07750AceE7898333218A5`, the 0G Compute request that produced it, and the size the Aqua strategy can actually fill.

The USDC lands on the Wick maker `0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953`, the same address the funding leg sweeps to top up 0G Compute. Agents buying prices pay for the inference that makes the prices. No human in the loop.

Live: https://wick-quotes.earn-shield-alerts.workers.dev

## Routes

| Route | Answer |
|---|---|
| `GET /v1/quote?tokenIn=USDC\|W0G&amountIn=<atomic>` | `402 Payment Required` with an x402 requirement; with a valid `X-PAYMENT` header, `200` with the quote after the settlement receipt is confirmed |
| `GET /v1/stats` | `{ paidQuotes, revenueUsdc, distinctPayers, lastSettlementTx }` |
| `GET /v1/health` | `{ board, orderHash, quoteFresh, expiry, readAtBlock }`, read from the board for both directions of the pair |

The 402 body is the x402 v1 `PaymentRequirementsResponse`:

```json
{
  "x402Version": 1,
  "error": "X-PAYMENT header is required",
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "10000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953",
    "resource": "https://wick-quotes.earn-shield-alerts.workers.dev/v1/quote?tokenIn=USDC&amountIn=1000000",
    "mimeType": "application/json",
    "maxTimeoutSeconds": 120,
    "extra": { "name": "USD Coin", "version": "2" }
  }]
}
```

A paid answer carries `quote` (board, maker, pair, `rateE18`, `maxAmountIn`, `expiry`, `epoch`, `nonce`, `inferenceId`, the 0G `requestId`, the `postedTx`, `requestedAmountIn`, the fillable `amountIn`, `depthLimited`, `routerAmountOut`, `strategyDepthOut`, `amountOut = min(router, depth)`, `orderHash`, `readAtBlock`) and `payment` (payer, amount, settlement tx, block), plus the `X-PAYMENT-RESPONSE` header.

## How a paid call runs

1. Decode `X-PAYMENT` and check it the way the exact scheme defines: EIP-712 `TransferWithAuthorization` signature recovers to `from` under the Base USDC domain, `to` is the maker, `value` is exactly the price, `validAfter` has passed, `validBefore` leaves room to settle.
2. Read `USDC.authorizationState(from, nonce)` on Base. A spent nonce is refused before anything else happens.
3. Read the v2 board's `Posted` quote and `isQuoteCurrent`, and the strategy's Aqua balance. The fill size is the ask capped at the quote's `maxAmountIn` and at the input whose output fits the strategy's tokenOut balance, the same limits the extruction enforces on a swap; `router.quote()` prices that size. A quote counts as live while it is current in the maker's epoch, unexpired, and inside the board's 900 s `MAX_TTL`. Settlement starts only once a live board quote is in hand, so every payment buys a real price; a board between quotes answers `503` and the authorization stays unspent.
4. Settle through the PayAI x402 facilitator, which submits `transferWithAuthorization` and pays the gas.
5. Wait for the receipt on Base and require a successful status plus the exact USDC `Transfer` from payer to maker in its logs. Only then is the payment recorded in KV and the quote returned.

Settlement goes through [PayAI](https://facilitator.payai.network), a public facilitator that settles Base mainnet `exact` payments with no API key. Its `/supported` lists `x402Version 1, exact, base`, and it verified this Worker's payload end to end against a live unfunded payer (`invalid_exact_evm_insufficient_balance`, the answer that only comes after the signature checks out). The Coinbase CDP facilitator needs CDP API keys, and `x402.org/facilitator` serves testnets only. `SETTLE_MODE=relayer` with a `RELAYER_PK` secret settles directly from the Worker instead, the path the fork run below exercises.

## Pay for a quote

```bash
cd quotes
PAYER_PK=... bun run client/pay-and-quote.ts      # TOKEN_IN, AMOUNT_IN, QUOTES_URL optional
```

The client reads the 402, signs the EIP-3009 authorization it asks for with a viem account, retries with `X-PAYMENT`, and prints the quote and the settlement tx. The payer needs 0.01 USDC on Base and no ETH: the facilitator pays the gas.

## Proof

```bash
bun test                 # x402 shape, paid path, every rejection, stats
bun run fork-e2e         # anvil fork of Base, real HTTP, real settlement
```

`bun test` covers the 402 shape against the v1 spec, a valid payment returning the quote, and refusals for a forged signature, a tampered signature, fields changed after signing, a wrong amount, a wrong `payTo`, an expired `validBefore`, a future `validAfter`, the wrong network, a garbage header and a replayed nonce. `test/board.test.ts` decodes a `getQuote` return encoded by the compiled AgentQuoteBoardV2 ABI (`test/fixtures`), pins `wrangler.jsonc` to the v2 board in `web/worker/live-order-v2.json`, and checks the `maxAmountIn` and depth caps; the v1 tuple, swapped struct fields, a v1 `BOARD_ADDRESS` or a dropped `maxAmountIn` cap each turn it red. Stats move only when a settlement is confirmed. Removing the signature comparison in `src/x402.ts` turns the forged-signature test red; removing the nonce check turns the replay test red.

`fork-e2e` finds board v2's latest `QuotePosted`, forks Base with anvil at the next block, funds a fresh payer from an impersonated USDC holder, serves this Worker's handler over HTTP, runs the reference client against it, and settles with `transferWithAuthorization` on the fork. It asserts `/v1/health` reads board v2 and a fresh quote, the paid quote is that post with its 0G `requestId` and an `amountIn` inside `maxAmountIn`, receipt status 1, the payer down exactly 0.01 USDC, the maker up exactly 0.01 USDC, stats at one paid quote, and the same `X-PAYMENT` refused on replay.

## Deploy

```bash
cd quotes
bun install
bunx wrangler deploy       # name wick-quotes, KV binding QUOTES_KV, no cron
```

`BOARD_ADDRESS`, `MAKER`, `PRICE_ATOMIC`, `FACILITATOR_URL`, `SETTLE_MODE`, `BASE_RPC_URL` and `STATUS_URL` are plain vars in `wrangler.jsonc`. Moving to a new board is a one-line change. The live order and strategy hash come from `web/worker/live-order-v2.json`, bundled at build time from the same file the site reads.
