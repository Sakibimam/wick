# Uniswap developer feedback

Upkeep is a market-making agent on Base that pays for its own AI inference on 0G. Uniswap v3 is load-bearing in three places: the W0G/USDC 0.3% pool is the reference mid every signed price must stay within 3% of, QuoterV2 sizes the fee conversion, and SwapRouter02 converts the agent's USDC fees into W0G before they bridge to 0G chain.

Live on Base: `exactInputSingle` on SwapRouter02, 0.40 USDC to 2.582956 W0G, tx [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52).

| What | Address on Base | Our code |
| --- | --- | --- |
| v3 W0G/USDC 0.3% pool | `0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e` | `agent/src/price.ts:6`, `slot0` read at `agent/src/price.ts:29` |
| QuoterV2 | `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a` | `agent/src/price.ts:7`, `agent/src/price.ts:36`, `agent/scripts/live-bootstrap.ts:41` |
| SwapRouter02 | `0x2626664c2603336E57B271c5C0b26F421741e481` | `agent/src/funding.ts:3`, `agent/src/funding.ts:29`, `agent/scripts/live-bootstrap.ts:50` |

Time to first success: live `slot0` reads and QuoterV2 quotes against Base mainnet landed in the agent's first service commit (`334dc9c`, 2026-11-05, 80 minutes after the repo's first commit). The first live swap landed on the second mainnet attempt; item 4 explains the first.

The one improvement with the greatest impact: flag fee outliers wherever pools are listed or routed (item 2). It is the difference between a 0.3% conversion and a 15% to 29% one for the same token, and an agent picks pools without a human looking at the fee column.

## 1. v3 pool and QuoterV2 on Base: worked

**What worked.** The W0G/USDC 0.3% pool on Base holds about $168k of liquidity. QuoterV2 priced a USDC to W0G conversion at 0.31% total cost for $5, 0.32% for $20, 0.42% for $100 and 1.47% for $1,000, and the live swap landed at the quoted amount. Reading `slot0().sqrtPriceX96` and handling either token order took one function (`agent/src/price.ts:28`).

**Friction.** `quoteExactInputSingle` is declared nonpayable, because it computes the result by reverting inside the swap callback. Typed clients split reads (view or pure) from writes, so the call that matches the ABI is a simulation: we use viem `simulateContract` (`agent/scripts/live-bootstrap.ts:41`), with the ABI declared without `view` (`agent/src/price.ts:9`). Many community snippets declare the quoter as `view` to make it fit a read helper, which hides the revert-based mechanics and confuses the next reader.

**Suggested fix.** On the QuoterV2 docs page, state up front that the function is not view and show one viem `simulateContract` snippet and one ethers `staticCall` snippet. A short "why it is nonpayable" note saves every new integrator the same detour.

## 2. v4 pools for the 0G OFT token: a fee footgun

**What we hit.** The Ethereum 0G token (a LayerZero OFT) has 27 Uniswap v4 pools. Their fees run from 9.9% to 88%. The best of them holds about $7.9k of liquidity and trades about $99 a day. Buying through them costs 15.2% against market at $5 and 28.7% at $1,000. Meanwhile the Chainlink CCIP wrapped 0G (W0G) has deep v3 0.3% USDC pools on Base and Ethereum at about $168k each.

**Why it matters.** v4 allows any fee, so a token search, a pool list or a naive router that picks "a pool for this token" can land a user or an agent in a pool that takes a quarter of the trade. Autonomous agents are the most exposed: they select pools by token address and liquidity, never by eye.

**What we did.** Upkeep pins the v3 pool address (`agent/src/price.ts:6`) and the 3000 fee tier on every conversion (`agent/src/funding.ts:29`), and never discovers pools at runtime.

**Suggested fix.**
- Return a fee-outlier flag (for example, fee above 1%) in the Trading API quote response and in any pool discovery endpoint, next to liquidity and 24h volume.
- In the interface, show a warning before routing through a pool whose fee exceeds the fee of the next best route by a wide margin.
- On token pages, surface the deepest pool for the asset family (W0G v3 here) when the searched token's own pools are fee traps.

## 3. Trading API: 401 without a key

**What we hit.** Calling the Trading API quote endpoint without an API key returns 401. There is no keyless path to a single quote, so a prototype cannot compare the API's route against an onchain quote before signing up.

**What we did.** Upkeep quotes onchain through QuoterV2 (`agent/src/price.ts:35-38`) and swaps directly on SwapRouter02 (`agent/src/funding.ts:29`), which keeps the agent free of a key it would need to store and rotate.

**Suggested fix.** Offer a keyless, IP rate-limited quote tier (quote only, no swap calldata), or publish a shared demo key for hackathon use. At minimum, make the 401 body name the dashboard URL where a key is issued, so the error itself is the onboarding step.

## 4. "STF" on SwapRouter02 after a stale allowance read

**What we hit.** On our first mainnet swap, the approve receipt was confirmed, then the swap reverted with `STF`. The cause was the public Base RPC: it is load-balanced, and the node that served the swap's simulation was behind the approval block, so it saw an allowance of zero. `STF` (`TransferHelper.safeTransferFrom` failed) covers a missing allowance, a short balance and a non-standard token alike, so the error gives no hint that the allowance was the problem.

**What we did.** After every approve, the agent polls `allowance` on the same RPC until it reads the approved amount, with a 30 second ceiling, before it simulates or sends the swap: `agent/scripts/live-bootstrap.ts:45-49`, the same guard on the Aqua taker path at `agent/src/taker.ts:17-22`, and on the LI.FI and CCIP approvals at `agent/scripts/live-fund.ts:61` and `agent/scripts/live-fund.ts:72`.

**Suggested fix.** SwapRouter02 is immutable, so the fix belongs in the layers around it:
- In the SDK, the Trading API simulation and the interface, decode `STF` into "transferFrom of <token> to <spender> failed: check the allowance and balance", and include the allowance and balance read at the simulated block.
- In the docs for direct router integrations, add a note that a load-balanced RPC can serve an allowance from before the approval block, with the poll-until-visible pattern above.

## 5. v4 Aggregator Hooks could route to 1inch Aqua

**The idea.** Upkeep's liquidity lives in a 1inch Aqua strategy whose price is an AI-signed quote, enforced onchain: `AgentQuoteExtruction` fills only at the current signed rate and reverts `StaleQuote` otherwise, in `quote()` and `swap()` alike (`contracts/src/AgentQuoteExtruction.sol:44`). Because quote and fill agree by construction, this liquidity is a clean source for a v4 Aggregator Hook: a W0G/USDC v4 pool whose hook asks AquaSwapVMRouter `quote()` and fills through `swap()` would let Uniswap routing reach agent-quoted Aqua liquidity, and give the strategy outside takers through the Uniswap interface.

**Suggested fix.** Publish a reference Aggregator Hook adapter interface (a quote function and a fill function, exact-in and exact-out) with one external venue wired as the example, so RFQ and Aqua makers can plug in without writing hook accounting from scratch. We would build the Aqua adapter against it.
