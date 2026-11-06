# Wick

> **Operator fill before submitting.** Team: [team]

**One line.** Wick is a trading agent that pays its own AI bill: a 1inch Aqua market maker whose swap fees fund the 0G inference that sets its prices.

**Description.** Wick runs a two-sided W0G/USDC Aqua strategy on Base that fills only at prices its agent signed after a 0G Private Computer inference. Each tick the model chooses a bid half-spread, an ask half-spread, a size and a lifetime; code places both prices around the Uniswap v3 TWAP and signs them as one EIP-712 pair carrying the 0G request id, provider and TEE verdict. A SwapVM Extruction on the deployed, unmodified AquaSwapVMRouter re-checks on every fill that the quote is from the agent's current epoch, unexpired, inside 800 bps of the 600 second TWAP read from `observe()`, and within its `maxAmountIn`. The agent's 0G Payment Layer vault was seeded once through the agent's own rail (Uniswap, Chainlink CCIP, `depositFor`); from then on the cron bridges fees over that same rail once they are worth three times the live bridge cost. Takers arrive through the Wick swap page and a Uniswap v4 aggregator hook, and other agents buy Wick's signed price over x402.

| Field | Value |
| --- | --- |
| Repository | https://github.com/Sakibimam/wick (MIT) |
| Live app | `https://wick.earn-shield-alerts.workers.dev` |
| Paid quote API (x402) | `https://wick-quotes.earn-shield-alerts.workers.dev/v1/quote`, stats at `/v1/stats` |
| Demo video script | [docs/DEMO-SCRIPT.md](DEMO-SCRIPT.md) |
| Architecture, threat model, parameters | [ARCHITECTURE.md](../ARCHITECTURE.md), interactive [docs/ARCHITECTURE.html](ARCHITECTURE.html) |
| Unit economics | [docs/ECONOMICS.md](ECONOMICS.md) |
| Uniswap feedback | [FEEDBACK.md](../FEEDBACK.md), form link `https://github.com/Sakibimam/wick/blob/main/FEEDBACK.md` |
| Track | Continuity |

## Deployed contracts

Agent, maker and deployer: [`0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953`](https://basescan.org/address/0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953)

| Contract | Chain | Address |
| --- | --- | --- |
| AgentQuoteBoardV2 | Base | [`0x0d87944FFFf253dBbbD07750AceE7898333218A5`](https://basescan.org/address/0x0d87944FFFf253dBbbD07750AceE7898333218A5), deploy [`0xdb552695…d7a9`](https://basescan.org/tx/0xdb55269525f0d82931677f9d5af46d088ccb9eea90d51947125792029092d7a9) |
| AgentQuoteExtructionV2 | Base | [`0xEE1374852327Da76Fd04CA5f681C875E3e8e9cf4`](https://basescan.org/address/0xEE1374852327Da76Fd04CA5f681C875E3e8e9cf4), deploy [`0x85466a39…5212`](https://basescan.org/tx/0x85466a399625dd1cf0597ad88de6729934e3e45734497a80606b026782425212) |
| AgentQuoteBoard (v1) | Base | [`0x309933CE439Da6A059593d73B8c82E8C8447C3F8`](https://basescan.org/address/0x309933CE439Da6A059593d73B8c82E8C8447C3F8), deploy [`0x7894c4f2…eb60`](https://basescan.org/tx/0x7894c4f2d67d623cca729a5938d712f0ffbdd64e9435fe40c820e5d6e1a3eb60) |
| AgentQuoteExtruction (v1) | Base | [`0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0`](https://basescan.org/address/0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0), deploy [`0xf042bd0d…2630`](https://basescan.org/tx/0xf042bd0d1d007f741ae282877f0367f1a8e244401401149e90701b0882a52630) |
| Aqua (1inch, pinned) | Base | [`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`](https://basescan.org/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) |
| AquaSwapVMRouter v1.0.2 (1inch, pinned) | Base | [`0x111111338c5091E8440b67B168bAe16a668AC0De`](https://basescan.org/address/0x111111338c5091E8440b67B168bAe16a668AC0De) |
| Uniswap v3 W0G/USDC 0.3% | Base | [`0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e`](https://basescan.org/address/0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e) |
| AquaAggregatorHook (Uniswap v4) | Base | [`0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888`](https://basescan.org/address/0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888), deploy [`0xa72b0d60…2427`](https://basescan.org/tx/0xa72b0d60b59900f8b89ca96c3c6612a18a04750e16c606fc1a0e68d6bbfb2427) |
| Uniswap v4 PoolManager | Base | [`0x498581fF718922c3f8e6A244956aF099B2652b2b`](https://basescan.org/address/0x498581fF718922c3f8e6A244956aF099B2652b2b) |
| 0G Payment Layer | 0G chain | `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` |

The v2 Aqua strategy `0x05bc438b60860b593d7278d8d64653302a9d314beb0275e9103d5a0c3cbbc035` (program `0x20 | 44 | extruction | 30 bps | pool 0xe03cCe44…0c4e | 800 bps`), shipped by `contracts/script/LaunchV2.s.sol` in one broadcast at Base block 53,810,154: deploy both contracts, dock v1 strategy `0xf2513850…7f5e`, ship v2 with exactly the inventory the maker wallet backs, `setAgent` (epoch 1), and raise the W0G/USDC pool's observation cardinality to 20. Aqua `safeBalances` for v2 reads 1.357492788767429240 W0G and 0.006836 USDC at Base block 53,811,582. The live strategy is that program behind a taker gate, `0x888f4e9134623a949a0a2d62998fd8869a5749dadda509aa63ade7928ca8217e`: SwapVM `_onlyTakerTokenBalanceNonZero` (opcode `0x0e`) admits only holders of [WickGate](https://basescan.org/address/0x159dd4fCdA128070E0f2A50408b936be560FE0E5), the v4 hook and the maker, so Uniswap swappers reach it through the hook and direct router calls from anyone else revert `TakerTokenBalanceIsZero`. Cutover: dock [`0x82672a1d…2e0a`](https://basescan.org/tx/0x82672a1db622c3366ae20fb4e65c312085b1e104a3e456f1fbc207eb3aee2e0a), ship [`0x94b92299…5663`](https://basescan.org/tx/0x94b92299c89aedb1351c80dcc2bc6f1973d9d4e56ec2598bf6bd36f396215663), `setOrder` [`0x0e7e3461…1491`](https://basescan.org/tx/0x0e7e3461164c9bf4fa5eda7b56ce1f9d685a79d577fb0d963470b94caf771491); first Uniswap swap through it [`0x52fbee31…860f`](https://basescan.org/tx/0x52fbee315b79eb533aec4272b22d6d111605ba57312785a0a21342b04c85860f).

## The live loop, in order

| # | Step | Evidence |
| --- | --- | --- |
| 1 | Uniswap v3 swap seeds the strategy's W0G side, 0.40 USDC to 2.582956 W0G | [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52) |
| 2 | `setAgent` registers the signing agent on the board | [`0x177ca949…a04f`](https://basescan.org/tx/0x177ca949be4e6783b212f3339bff7e651e3ee3deba5e3f6831834e39b0b9a04f) |
| 3 | Aqua `ship`: two-sided strategy, 2 W0G and 0.5 USDC, 30 bps fee | [`0xd342a0ff…181d`](https://basescan.org/tx/0xd342a0ff7a74e1a565ac80116af42f6ff00d2be2c97ff1db293b17c0f19b181d) |
| 4 | 0G inference prices both sides on `0gm-1.0-35b-a3b`, 29 micro-USD | router request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa` |
| 5 | Signed quote posted, USDC to W0G, `inferenceId 0xa084340d…e7e7` | [`0x7b2433ba…daec`](https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec) |
| 6 | Signed quote posted, W0G to USDC | [`0x79598fe4…d97e`](https://basescan.org/tx/0x79598fe4e59c56cbf7dfb7099955030ac52fb4da4d5d1695119bcd2f7bf1d97e) |
| 7 | Fill through AquaSwapVMRouter, 0.1 USDC to 0.642507 W0G at the signed rate minus the 30 bps fee | [`0x62f874c5…c7a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1) |
| 8 | Native 0G for gas on 0G chain, 0.30 USDC in through LI.FI | [`0xa43b6622…883c`](https://basescan.org/tx/0xa43b662266bd967afbeeb4feb17ea67fc3aa4c7804dfc379f47a27e29a44883c) |
| 9 | `ccipSend` 1.0 W0G from Base to 0G chain, delivered exactly 1.0 W0G after 1,427 s | [`0xd0b46ef5…876e`](https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e) |
| 10 | `W0G.withdraw` to native 0G | [`0x6e12d8d0…5a0d`](https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d) |
| 11 | `PaymentLayer.depositFor(agent)`, vault credit 0 to 2.844 0G | [`0x8b0b60f8…3f68`](https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68) |
| 12 | Inference billed `"currency":"0g"`, 0.00004166 0G; vault moves 2.844 to 2.344 0G as the router draws its working deposit | router request `798fb102-9f06-4bc5-9ec2-1dde3b716628` |
| 13 | The Worker cron keeps pricing on 0G-billed runs: 0.000243, 0.000281 and 0.000272 0G, each posting both directions | requests `286d605d-7b73-4b09-882c-6605e2bcf64e`, `1002ff0b-2daf-48ae-b697-daa672d2dd47`, `65073141-8324-44a8-b819-c0f421c55ff8`; posts [`0x836477f5…c602`](https://basescan.org/tx/0x836477f516deadb72ad5d03b3bdc8722cf4d9aa2ad6c6360c4b2e54d4c57c602), [`0x5dff60e6…cc23`](https://basescan.org/tx/0x5dff60e69f27d1559d39930f15128f8cd16295597eeceac7502e9b8729adcc23) |
| 14 | v2 cutover: dock v1, ship v2 with the TWAP band program, register the agent at epoch 1, grow the pool's oracle history | dock [`0x5585112e…e593`](https://basescan.org/tx/0x5585112eb78a2af2c8e89785c4709c63a83ca2b82638258b636f5a93f2f3e593), ship [`0x20822085…0ba7`](https://basescan.org/tx/0x20822085a78bc7c75e3123d2c95776d00b96632b625850452cd4de4be51f0ba7), `setAgent` [`0xbcf1a5a6…d75e`](https://basescan.org/tx/0xbcf1a5a6c66c865a74fbacd00ca83367af31921919d9bf40e5bc113b2267d75e), `increaseObservationCardinalityNext(20)` [`0x60dd0188…3729`](https://basescan.org/tx/0x60dd01887cb1c402ebb265d0f3c87b07eee8abf3b00677af19924e289c0d3729) |
| 15 | An agent asks for a quote over x402 and gets HTTP 402 with `exact` scheme requirements, 10000 atomic USDC to the maker on Base | `curl -i "https://wick-quotes.earn-shield-alerts.workers.dev/v1/quote?tokenIn=USDC&amountIn=100000"` |
| 16 | The Worker cron posts a v2 pair: both directions from one signature, model-chosen skew, `maxAmountIn` and TTL with its reason, 88,391 gas | `postPair` [`0xe75b8628…5ef3`](https://basescan.org/tx/0xe75b86286eaff73792f585adf0fee3741a40292c718a415bb83aa697679e5ef3), router request `465f7df7-734f-40c6-929f-e6789df93b9d`, `inferenceId 0xf7dce81f…6eeb` |
| 17 | Uniswap v4 hook live: deploy, `setOrder` to the v2 strategy, v4 pool `0xba432fbc…785e` initialised on the PoolManager | deploy [`0xa72b0d60…2427`](https://basescan.org/tx/0xa72b0d60b59900f8b89ca96c3c6612a18a04750e16c606fc1a0e68d6bbfb2427), `setOrder` [`0xf062d2d5…ec11`](https://basescan.org/tx/0xf062d2d5c839fd03ddddea6ff201cfa246c1e221d48b4335a327d201d2a7ec11), initialize [`0xee9b8414…9696`](https://basescan.org/tx/0xee9b8414c77c117231f020d604b684d7766076df89fdfbe816c9f97229649696) |

After step 7, Aqua `safeBalances` for the strategy reads 1.357492788767429240 W0G and 0.6 USDC: the exact deltas the signed quote set. Anyone can recompute the quote's provenance:

```sh
cast keccak "5319a0b6-562e-4bbe-a141-dfb94fc20aaa0x833589fCD6eDb6E08f4c7C32D4f71b54bdA029130x23cd099eB438CcA50349EE2BC809196b1ae00861"
# 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7, the inferenceId stored on the board
```

## 0G: Agents That Pay for Themselves

Wick earns the two ways the prize text invites: "Other ways of earning count too, such as charging for a service or getting paid by other agents." The service is liquidity, paid at 30 bps per fill. The other agents pay 0.01 USDC per signed quote over x402.

The vault was seeded once through the agent's own rail: steps 8 to 11 above are that seed run, by the agent's wallet, over the exact path the funding machine drives. From then on the machine bridges fees from inside the cron, with no human step, once spendable fees reach 3 times the live bridge cost (0.81 USDC at the 2026-11-06 reads). Every inference since the seed bills in 0G against that vault.

> The full loop: money in, credit landing in the agent's 0G compute account, and inference paid from that balance, with tx hashes and request IDs

| Leg | Code | Evidence |
| --- | --- | --- |
| Money in, swap fees | fee charged inside the extruction at `contracts/src/AgentQuoteExtructionV2.sol:65-73`; accrued per fill by `accruedFees`, `agent/src/worker-tick.ts:53` | fill [`0x62f874c5…c7a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1), 300 atomic USDC fee |
| Money in, paid by other agents | `quotes/src/index.ts:55` (402), `:65` (nonce check), `:73` (quote read before settlement), `:82` (settle) | live 402 at `https://wick-quotes.earn-shield-alerts.workers.dev/v1/quote`; paid count at `/v1/stats` |
| Credit landing, seed run over the funding machine's rail | `decideFunding` (`agent/src/funding-machine.ts:28`) and its step machine: swap, `ccipSend`, await arrival, `W0G.withdraw`, `depositFor`, one step per tick, persisted in KV | [`ccipSend 0xd0b46ef5…876e`](https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e), [`withdraw 0x6e12d8d0…5a0d`](https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d), [`depositFor 0x8b0b60f8…3f68`](https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68); `Deposited.user` is the agent; vault 0 to 2.844 0G |
| Inference paid from that balance | `askDecision` (`agent/src/brain.ts:111`) records `x_0g_trace.billing` per run | requests `798fb102…`, `286d605d…`, `1002ff0b…`, `65073141…` all billed `"currency":"0g"`; `balanceOf(agent)` on the Payment Layer 2.844 to 2.344 0G |

```sh
cast call 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32 "balanceOf(address)(uint256)" \
  0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 --rpc-url https://evmrpc.0g.ai
```

A funding run fires only when unfunded fees are worth `k = 3` times its own cost (CCIP `getFee` plus 482,000 Base gas plus 0G gas), 0.81 USDC at the 2026-11-06 reads and recomputed every tick, and it spends only fees: `min(unfunded fees, wallet balance above the strategy's committed inventory)`. The same machine refills Base gas from fee USDC through the Uniswap v3 USDC/WETH 0.05% pool when the gas wallet falls under 0.0001 ETH. Math in [docs/ECONOMICS.md](ECONOMICS.md).

> The agent running on its own during the demo with no manual top-up

- A Cloudflare Workers cron every 5 minutes (`web/worker/cron.ts`, `agent/src/worker-tick.ts`): read TWAP, spot, vault, gas and board; run the budget policy; infer and post a pair when the policy calls a requote; advance the funding machine by one step. A billed run and a posted pair survive a failed tick in KV state.

> A spend cap, and what the agent does when funds run low (it should degrade gracefully, not crash)

- Spend cap: `SPEND_CAP_PER_DAY_WEI`, 1 0G per UTC day. Spend is the sum of the router's per-request bills (`accountSpend`, `agent/src/budget.ts:27`); the router's 0.5 0G working-deposit pulls move funds into its ledger and never count as spend.
- Degradation, a pure policy in `agent/src/budget.ts` and `agent/src/policy.ts`:

| Tier | Trigger | Behaviour |
| --- | --- | --- |
| NORMAL | healthy balance | `0gm-1.0-35b-a3b` with `tee_verified`, requote on a 25 bps TWAP move, spread floor 30 bps |
| LOW | under 0.5 0G or 75% of cap | `qwen3.7-flash`, requote on a 100 bps move, spread floor 60 bps |
| CRITICAL | under 0.1 0G or 90% of cap | no inference; the last pair rides to its expiry |
| PAUSED | cap reached, under 0.05 0G, or Base gas under 0.00003 ETH | no posting; every fill reverts `StaleQuote` |

- The posted spread is the larger of the model's spread and the tier floor, so a degraded tier always quotes wider. The ledger page shows tier, vault balance, spend against the cap, fees earned against AI spent, and every funding step (`web/components/ledger-page.tsx`).

## 0G: Build with 0G PC

> Inference on 0G Private Computer in your main user flow, with request IDs

- Every signed pair comes from a 0G Private Computer call (`askDecision`, `agent/src/brain.ts`) with `verify_tee: true`. The agent binds the router's verdict, including `null`, into `inferenceId = keccak256(abi.encode(string requestId, string provider, string teeVerified))` and stores it on the board with the pair. A `0gm-1.0-35b-a3b` answer is signed only with `tee_verified: true` (`teeGate`); the TeeML provider is retried with backoff, and when it still answers 5xx the brain asks `qwen3.7-flash` once. The request id is required.
- The swap page shows the 0G request behind the price the taker is about to fill. Live: request `465f7df7-734f-40c6-929f-e6789df93b9d`, provider `0x000000003f486c7198d6203568a98d02b91f8044`, `inferenceId 0xf7dce81fe229967ef230c605407a1cfcbfb16c1db9a63f6c71fc7f9f2df56eeb` in quote tx [`0xe75b8628…5ef3`](https://basescan.org/tx/0xe75b86286eaff73792f585adf0fee3741a40292c718a415bb83aa697679e5ef3). This run's verdict was `null`, and `null` is what the inferenceId binds.
```sh
cast keccak "$(cast abi-encode 'f(string,string,string)' 465f7df7-734f-40c6-929f-e6789df93b9d 0x000000003f486c7198d6203568a98d02b91f8044 null)"
# 0xf7dce81fe229967ef230c605407a1cfcbfb16c1db9a63f6c71fc7f9f2df56eeb, the inferenceId in the v2 quote tx above
```
- A TEE-verified run, live on the TeeML provider `0x15aDd680050Ecd0B25eb7d480e7BB1f48594Eabe` (`0gm-1.0-35b-a3b-sia`, Intel TDX): request `0382461e-4f1b-453d-a52c-bfac9e6df957` answered with `tee_verified: true`, and its `inferenceId 0x35e3a8a65554c60c9208b3057c02ea2cf88e49a77c936e98d95458b9d45ce251` rides in quote tx [`0xe7052369…9a0c`](https://basescan.org/tx/0xe7052369ee4682adc060d8d23e0ddba6ee4194c07617466f4d091927472c9a0c) on the v2 board.

```sh
cast keccak "$(cast abi-encode 'f(string,string,string)' 0382461e-4f1b-453d-a52c-bfac9e6df957 0x15aDd680050Ecd0B25eb7d480e7BB1f48594Eabe true)"
# 0x35e3a8a65554c60c9208b3057c02ea2cf88e49a77c936e98d95458b9d45ce251
```

> A working app a judge can try, with a clear reason someone comes back tomorrow

- `https://wick.earn-shield-alerts.workers.dev`: the swap page fills W0G/USDC through AquaSwapVMRouter from the judge's own wallet at the agent's signed price, with a countdown to the quote's expiry and what the trade funds. The ledger page shows whether the agent is still paying its own way.
- The reason to return: the price moves, the agent re-prices on 0G, and the ledger shows its compute account rising with fills and falling with inference.

> One sentence on what breaks if 0G is removed

Remove 0G and the agent signs no price, so every Aqua fill and every Uniswap v4 swap through the hook reverts `StaleQuote`, and the fees it earns lose the compute bill they exist to pay.

## 1inch: Build an Aqua App (and the Continuity Track prize)

> Create a custom Aqua app that implements a sophisticated DeFi position. If you use SwapVM, you may modify SwapVM opcodes and define your own instructions. The final positions must be demonstrated through tests scripts or a UI.

The position is a two-sided W0G/USDC strategy priced by an AI agent, where SwapVM enforces the agent's signature, freshness, a TWAP band and a size cap on every fill. `AgentQuoteExtructionV2` is a custom SwapVM instruction invoked at Aqua opcode `0x20` (`contracts/script/LaunchV2.s.sol`, program `0x20 | 44 | extruction | feeBps | pool | maxDeviationBps`).

| Check on every fill | Code |
| --- | --- |
| quote from the maker's current epoch, else `StaleQuote` | `contracts/src/AgentQuoteExtructionV2.sol:58` |
| `block.timestamp < expiry`, else `QuoteExpired` | `:61` |
| signed rate within `maxDeviationBps` of the 600 s TWAP, else `PriceOutOfBand` | `:80-90`, TWAP from `observe()` in `contracts/src/TwapPrice.sol:25-28` |
| `amountIn <= maxAmountIn`, else `AmountInTooLarge` | `:74` |
| `amountOut <=` strategy balance, else `InsufficientDepth` | `:75` |
| post: expiry at most 900 s out, epoch current, nonce rising within the epoch, signer is the registered agent (EOA or ERC-1271) | `contracts/src/AgentQuoteBoardV2.sol:13`, `:169-180` |
| both directions in one signature | `postPair`, `contracts/src/AgentQuoteBoardV2.sol:105` |

Positions are demonstrated by tests and live. `cd contracts && forge test` runs 69 tests, among them 34 v2 unit tests with 5 fuzz tests at 1,000 runs, 4 invariants at 256 runs x depth 64 and 8 v2 Base fork tests; the hook adds 20 Base fork tests, the agent 115, the web app and Worker 66, and the x402 API 25, all re-run at commit `1cae758` on 2026-11-06 (full table in the [README](../README.md#tests)).

- `contracts/test/AgentQuoteV2.t.sol`: unit and fuzz tests for leaked-key rotation, epoch replay, TTL edges, band edges, `maxAmountIn` exact-in and exact-out, maker-favouring rounding and quote/swap equality.
- `contracts/test/AgentQuoteV2.invariant.t.sol`: a handler that posts, fills and tries a leaked key.
- `contracts/test/BaseV2Fork.t.sol`: the v2 extruction through the deployed AquaSwapVMRouter on a Base fork, both directions, out-of-band, over-size and expiry reverts, and `testFuzz_quoteEqualsSwap`.
- The taker-gated strategy is live on Base (`0x888f4e91…217e`), a Uniswap swap filled through it at the hook quote ([`0x52fbee31…860f`](https://basescan.org/tx/0x52fbee315b79eb533aec4272b22d6d111605ba57312785a0a21342b04c85860f)), and the v1 strategy filled on Base mainnet at the signed rate: [`0x62f874c5…c7a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1).

> Official Aqua/SwapVM contracts must be used (redeployments of a modified SwapVM contract is allowed)

- The strategy ships to the deployed Aqua [`0x1111113C…a90a`](https://basescan.org/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) and fills through the deployed, unmodified AquaSwapVMRouter v1.0.2 [`0x11111133…C0De`](https://basescan.org/address/0x111111338c5091E8440b67B168bAe16a668AC0De). Ship tx [`0xd342a0ff…181d`](https://basescan.org/tx/0xd342a0ff7a74e1a565ac80116af42f6ff00d2be2c97ff1db293b17c0f19b181d).
- `1inch/swap-vm` `v1.0.2` and `1inch/aqua` `v1.0.1` are pinned as submodules and selector-matched to the deployed bytecode (`contracts/README.md`). `test_aquaOpcode33IsNotExtruction` (`contracts/test/AgentQuote.t.sol`) pins the router's real opcode table.

> Onchain execution of token transfers should be presented during the final demo (local forks are ok)

- Base mainnet fill [`0x62f874c5…c7a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1): 0.1 USDC in, 0.642507 W0G out, Aqua `safeBalances` moving 2 W0G / 0.5 USDC to 1.357492788767429240 W0G / 0.6 USDC.
- The demo fills from the judge's wallet on Base mainnet, then shows the same swap refused with `StaleQuote` once the agent's budget is cut ([docs/DEMO-SCRIPT.md](DEMO-SCRIPT.md)).

> Proper Git commit history (no single-commit entries on the final day)

Small, dated commits from the first one, [`ae1859d`](https://github.com/Sakibimam/wick/commit/ae1859d), through contracts, fork tests, agent runtime, web app, Base mainnet loop, funding leg, v2 contracts, the v4 hook and the x402 API: https://github.com/Sakibimam/wick/commits/main

## Uniswap: Build with Uniswap (and the Continuity Track prize)

> A public GitHub repository with open-source code, a FEEDBACK.md file, and a completed submission to the Uniswap Developer Feedback Form (https://developers.uniswap.org/hackathon-feedback) that includes the link to your FEEDBACK.md file.

- Repository https://github.com/Sakibimam/wick, MIT licensed.
- [FEEDBACK.md](../FEEDBACK.md): concrete feedback from the live integration, each item with what worked, what broke and a suggested fix.
- Feedback form link field: `https://github.com/Sakibimam/wick/blob/main/FEEDBACK.md`.

> Make sure your README clearly points to the relevant contracts and lines of code so we can verify your integration.

| Uniswap piece | Role in Wick | Code |
| --- | --- | --- |
| v4 aggregator hook on `BaseAggregatorHook` (`Uniswap/v4-hooks-public`) | turns the Aqua strategy into a v4 pool: the hook is the SwapVM taker, fills from Aqua, settles to the PoolManager; exposes `quote` and `pseudoTotalValueLocked` for routing | `hook/src/AquaAggregatorHook.sol:106` (`_rawQuote`), `:125-145` (`_conductSwap`, `router.swap`), `:77` (`pseudoTotalValueLocked`); fork tests through the deployed Universal Router 2.1.2 in `hook/test/AquaAggregatorHook.fork.t.sol` |
| v3 W0G/USDC 0.3% pool `0xe03cCe44…0c4e`, `observe()` | onchain TWAP band on every fill, and the mid every signed pair is centred on | `contracts/src/TwapPrice.sol:25-28`, `contracts/src/AgentQuoteExtructionV2.sol:88`; offchain `readTwapMarket`, `agent/src/price.ts:55` |
| SwapRouter02 `0x2626664c…e481` | converts fee USDC to W0G before CCIP, and fee USDC to ETH for gas | `swap-usdc-w0g` and `gas-swap-usdc-eth` steps in `agent/src/funding-machine.ts`; live swap [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52) |
| QuoterV2 `0x3d4e44Eb…B76a` | sizes every funding swap and its slippage floor | `agent/src/price.ts`, `agent/src/worker-tick.ts` |
| v3 USDC/WETH 0.05% pool `0xd0b53D92…F224` | ETH price for gas and bridge cost in the funding threshold | `ethUsdFromSqrt`, `agent/src/worker-tick.ts:51` |

**Live swap through the hook.** On Base mainnet, a taker wallet `0x39ef83fb…ab37` swapped 0.05 USDC for 0.330737688695358517 W0G through Uniswap's Universal Router into the v4 pool `0xba432fbc…785e`: [`0xb5ec571e…b50a`](https://basescan.org/tx/0xb5ec571ef88870176aa5513674f76a465b2c10a960bee05d6b25c2d231aab50a), block 53,995,832, 336,837 gas. The pool holds nothing; the hook filled the swap from Wick's Aqua strategy (SwapVM `Swapped` names maker `0xeF2E…d953`, order hash `0x05bc438b…c035`, taker the hook), Aqua `safeBalances` moved from 1.357492788767429240 W0G / 0.006836 USDC to 1.026755100072070723 W0G / 0.056836 USDC, and the output equals the hook's `quote` to the wei. Script: `agent/scripts/swap-via-hook.ts`.

## Guards in front of the signer

A market maker that signs a bad price loses money to the first arbitrageur, so every guard sits before the signer and every miss means no quote:

- The model never writes a price. It returns a bid and an ask half-spread of 5 to 500 bps each, `maxAmountInUsdc` up to strategy depth and a TTL of 840 to 900 s (`DECISION_BOUNDS` and `validateDecision`, `agent/src/brain.ts`); `composeQuotes` (`agent/src/policy.ts`) builds both rates from the TWAP and refuses anything past 790 bps (`BAND_SAFE_BPS`).
- An answer that leans against the inventory (`skew_against_inventory`) or breaks any bound is refused before the signer, and the last decision that passed every guard is re-posted around the new TWAP. The ledger shows each refusal with its guard.
- A TeeML answer without `tee_verified: true` raises `tee_unverified`, and a router reply without a request id raises `request_id_missing`.
- The tick holds when spot and TWAP differ by more than 150 bps (`MAX_SPOT_TWAP_GAP_BPS`, `agent/src/price.ts:43`).
- At fill time the extruction re-checks epoch, expiry, band, size and depth, so the chain itself turns away an outdated or outsized price.

Full threat model and parameter table: [ARCHITECTURE.md](../ARCHITECTURE.md#threat-model).

## Continuity disclosure

Wick is entered in the Continuity track. Development began on 2026-11-05, before the ETHGlobal Mumbai 2026 event window opened at 2026-11-05 15:30 UTC (21:00 IST). The starting point is the repository's first commit, [`ae1859d`](https://github.com/Sakibimam/wick/commit/ae1859d) (2026-11-05 02:56 IST), and every later commit carries its date in the history.

### Changelog

From `git log --format='%h %ad %s'`, times in IST. 29 commits before kickoff, 87 inside the window as of `fd46327`.

**Before the event window (2026-11-05, 02:56 to 20:18 IST)**

| Commit | Date | Work |
| --- | --- | --- |
| `ae1859d` | 2026-11-05 02:56 | repository initialised |
| `b429ebd` to `537e703` | 2026-11-05 03:45 to 04:09 | pinned Foundry project, the v1 agent-signed Aqua quote extruction, freshness and agent rotation, fork tests |
| `334dc9c` to `29c704f` | 2026-11-05 04:15 to 04:30 | the W0G/USDC market-making agent, Base deploy and ship scripts |
| `4ebad02` to `0b6f804` | 2026-11-05 04:58 to 10:45 | first web app, signed-quote runtime, fork end to end |
| `d149aa9` | 2026-11-05 11:51 | live 0G router shapes: request id, thinking off, cost capture |
| `bbcbffe` | 2026-11-05 15:35 | Base mainnet loop: ship, live 0G quote, fill |
| `aa8f3e5` | 2026-11-05 20:00 | the funding rail: LI.FI gas, CCIP to the 0G chain, `withdraw`, `depositFor` |
| `77bd44a`, `40fa97b` | 2026-11-05 20:18 | architecture diagram, public README |

**Inside the event window (2026-11-05 21:48 IST onward)**

| Commit | Date | Work |
| --- | --- | --- |
| `24a7144` | 2026-11-05 21:48 | the seeded compute vault documented end to end |
| `6453189` to `ad2039a` | 2026-11-06 09:06 to 11:01 | the agent moves into a Cloudflare Workers cron with a gas floor, live chain routes, RPC fallback |
| `193e177` to `15f87ce` | 2026-11-06 11:03 to 12:36 | the money-loop UI, chain hues, the Wick name |
| `c533e47` | 2026-11-06 13:01 | v2 board and extruction: one-signature pairs, epochs, TWAP band, `maxAmountIn` |
| `fad83e1`, `2544580` | 2026-11-06 13:04 to 13:10 | Uniswap v4 aggregator hook and its deploy script |
| `8a3ea3f` | 2026-11-06 13:08 | `wick-quotes`: signed prices sold over x402 |
| `893a385`, `71b3e83` | 2026-11-06 13:30 to 13:39 | v2 cron tick, cutover script, Worker on the v2 board |
| `37b8894` | 2026-11-06 14:14 | the hook live on Base |
| `881006e` | 2026-11-06 14:39 | fee harvest inside the funding machine |
| `4137d08` to `1cae758` | 2026-11-06 15:33 to 15:39 | bid and ask half-spreads, refused answers re-post the last valid decision, depth and per-quote budget caps |
| `ec68bb4` to `7a1cb04` | 2026-11-06 15:43 to 15:47 | cron revenue read from chain, each x402 settlement bound to the payer's `AuthorizationUsed`, hook revert-path tests |
| `a9696de` to `dc7f404` | 2026-11-06 15:48 to 15:55 | the router's TEE verdict, provider and provider identity persisted per request |
| `5debc13` | 2026-11-06 16:13 | `/api/status` serves a 15 s memo and the last good status, marked stale, when chain reads fail |
| `7d6f4d2` | 2026-11-06 16:25 | the sponsor deck at `/deck` |
| `fd46327` | 2026-11-06 16:28 | a refused swap names the cap that bound it |

### What's next

Wick's trajectory is more doors for outside takers and tighter bounds per quote. The Uniswap v4 hook and the x402 feed already open the strategy to any router and any agent; the next step is routing integrations that send real flow through both. On the signing side, a cumulative per-quote cap enforced on chain extends today's off-chain per-quote budget, and a dedicated maker key separates `ship` and `dock` from the agent key, using the `setAgent` separation the board already supports.
