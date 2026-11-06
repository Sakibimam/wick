# Upkeep

**One line.** Upkeep is an AI market maker whose trading fees pay for the inference that sets its prices.

**Description.** Upkeep runs a 1inch Aqua strategy on Base that fills only against prices the agent signed after a 0G Private Computer inference, and every signed quote carries the hash of the 0G request that priced it. A SwapVM Extruction on the deployed, unmodified AquaSwapVMRouter checks freshness, nonce, pair, maker and agent binding on every fill, while the Uniswap v3 W0G/USDC pool anchors every price within 3% of the market. Fees route through Uniswap and Chainlink CCIP into the agent's own 0G Payment Layer vault, and a budget policy reads that vault every tick to choose its model, slow down or pause, so the brain pays for itself.

| Field | Value |
| --- | --- |
| Repository | https://github.com/Sakibimam/upkeep (MIT) |
| Live demo | `<LIVE_URL>` |
| Demo video script | [docs/DEMO-SCRIPT.md](DEMO-SCRIPT.md) |
| Architecture | [ARCHITECTURE.md](../ARCHITECTURE.md), interactive [docs/ARCHITECTURE.html](ARCHITECTURE.html) |
| Uniswap feedback | [FEEDBACK.md](../FEEDBACK.md), form link `https://github.com/Sakibimam/upkeep/blob/main/FEEDBACK.md` |
| Team | [team] |
| Track | Continuity |

## Deployed contracts

Agent, maker and deployer: [`0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953`](https://basescan.org/address/0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953)

| Contract | Chain | Address |
| --- | --- | --- |
| AgentQuoteBoard | Base | [`0x309933CE439Da6A059593d73B8c82E8C8447C3F8`](https://basescan.org/address/0x309933CE439Da6A059593d73B8c82E8C8447C3F8), deploy [`0x7894c4f2…eb60`](https://basescan.org/tx/0x7894c4f2d67d623cca729a5938d712f0ffbdd64e9435fe40c820e5d6e1a3eb60) |
| AgentQuoteExtruction | Base | [`0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0`](https://basescan.org/address/0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0), deploy [`0xf042bd0d…2630`](https://basescan.org/tx/0xf042bd0d1d007f741ae282877f0367f1a8e244401401149e90701b0882a52630) |
| Aqua (1inch, pinned) | Base | [`0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`](https://basescan.org/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) |
| AquaSwapVMRouter v1.0.2 (1inch, pinned) | Base | [`0x111111338c5091E8440b67B168bAe16a668AC0De`](https://basescan.org/address/0x111111338c5091E8440b67B168bAe16a668AC0De) |
| Uniswap v3 W0G/USDC 0.3% | Base | [`0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e`](https://basescan.org/address/0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e) |
| 0G Payment Layer | 0G chain | `0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32` |

Aqua strategy hash `0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e`.

## The live loop, in order

| # | Step | Evidence |
| --- | --- | --- |
| 1 | Uniswap v3 swap seeds the strategy's W0G side, 0.40 USDC to 2.582956 W0G | [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52) |
| 2 | `setAgent` registers the signing agent on the board | [`0x177ca949…a04f`](https://basescan.org/tx/0x177ca949be4e6783b212f3339bff7e651e3ee3deba5e3f6831834e39b0b9a04f) |
| 3 | Aqua `ship`: two-sided strategy, 2 W0G and 0.5 USDC, 30 bps fee | [`0xd342a0ff…181d`](https://basescan.org/tx/0xd342a0ff7a74e1a565ac80116af42f6ff00d2be2c97ff1db293b17c0f19b181d) |
| 4 | 0G inference prices both sides on `0gm-1.0-35b-a3b`, 29 micro-USD | router request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa` |
| 5 | Signed quote posted, USDC to W0G, `inferenceId 0xa084340d…e7e7` | [`0x7b2433ba…daec`](https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec) |
| 6 | Signed quote posted, W0G to USDC | [`0x79598fe4…d97e`](https://basescan.org/tx/0x79598fe4e59c56cbf7dfb7099955030ac52fb4da4d5d1695119bcd2f7bf1d97e) |
| 7 | Fill through AquaSwapVMRouter, 0.1 USDC to 0.642507 W0G at the signed rate minus the 30 bps fee | [`0x62f874c5…81a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1) |
| 8 | Native 0G for gas on 0G chain, 0.30 USDC in through LI.FI | [`0xa43b6622…883c`](https://basescan.org/tx/0xa43b662266bd967afbeeb4feb17ea67fc3aa4c7804dfc379f47a27e29a44883c) |
| 9 | `ccipSend` 1.0 W0G from Base to 0G chain, delivered exactly 1.0 W0G | [`0xd0b46ef5…876e`](https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e) |
| 10 | `W0G.withdraw` to native 0G | [`0x6e12d8d0…5a0d`](https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d) |
| 11 | `PaymentLayer.depositFor(agent)`, vault credit 0 to 2.844 0G | [`0x8b0b60f8…3f68`](https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68) |
| 12 | Inference billed `"currency":"0g"`, 0.00004166 0G; vault moves 2.844 to 2.344 0G as the router draws its working deposit | router request `798fb102-9f06-4bc5-9ec2-1dde3b716628` |

After step 7, Aqua `safeBalances` for the strategy reads 1.357492788767429240 W0G and 0.6 USDC: the exact deltas the signed quote set. Anyone can recompute the quote's provenance:

```sh
cast keccak "5319a0b6-562e-4bbe-a141-dfb94fc20aaa0x833589fCD6eDb6E08f4c7C32D4f71b54bdA029130x23cd099eB438CcA50349EE2BC809196b1ae00861"
# 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7, the inferenceId stored on the board
```

## 0G: Agents That Pay for Themselves

Upkeep earns the way the prize text invites: "Other ways of earning count too, such as charging for a service or getting paid by other agents." The service is liquidity. Every fill pays the strategy fee, the runtime accrues the agent's share from SwapVM `Swapped` events (`agent/src/runtime.ts:48`), and the funding leg moves value into the agent's 0G compute vault with no human step.

> The full loop: money in, credit landing in the agent's 0G compute account, and inference paid from that balance, with tx hashes and request IDs

- Money in: the fill [`0x62f874c5…81a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1) pays the 30 bps strategy fee; fee accrual at `agent/src/runtime.ts:48`.
- Credit landing: the funding leg built at `agent/src/funding.ts:29-34` and driven at `agent/src/runtime.ts:66`, live on mainnet as [`ccipSend 0xd0b46ef5…876e`](https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e), [`withdraw 0x6e12d8d0…5a0d`](https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d) and [`depositFor 0x8b0b60f8…3f68`](https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68). `Deposited.user` is the agent; vault credit moves 0 to 2.844 0G.
- Inference paid from that balance: router request `798fb102-9f06-4bc5-9ec2-1dde3b716628` bills `"currency":"0g"`, and `balanceOf(agent)` on the Payment Layer moves 2.844 to 2.344 0G:

```sh
cast call 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32 "balanceOf(address)(uint256)" \
  0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 --rpc-url https://evmrpc.0g.ai
```

> The agent running on its own during the demo with no manual top-up

- One Bun process on a 15 second tick (`agent/src/runtime.ts:161`). Each tick reads the Uniswap mid and the vault balance, accrues fills, runs the budget policy, requotes when the policy calls for it, and starts the funding leg when accrued fees reach `FUNDING_THRESHOLD_USDC` (`agent/src/runtime.ts:68`).
- Funding state persists after every step; a sent CCIP message is saved as `pendingFunding` (`agent/src/runtime.ts:34`), so a restart resumes the 0G side of the funding leg.

> A spend cap, and what the agent does when funds run low (it should degrade gracefully, not crash)

- Spend cap: `SPEND_CAP_PER_DAY_WEI` (`agent/src/runtime.ts:132`). Spend is measured from the onchain vault balance (`agent/src/runtime.ts:123-126`), so the cap counts what the router actually drew.
- Degradation, a pure policy in `agent/src/budget.ts:14-17`:

| Tier | Trigger | Behaviour |
| --- | --- | --- |
| NORMAL | healthy balance | `0gm-1.0-35b-a3b`, requote on a 25 bps move |
| LOW | under 0.5 0G or 75% of cap | switches to `qwen3.7-flash`, requotes only on a 100 bps move, widens the spread |
| CRITICAL | under 0.1 0G or 90% of cap | stops inference, keeps a fresh last quote alive |
| PAUSED | cap reached or under 0.05 0G | stops posting; the strategy then fails closed with `StaleQuote` |

- CRITICAL and PAUSED are enforced inside the brain as well as the policy (`agent/src/brain.ts:12-13`), so no code path spends past the cap. The ledger page in the web app shows the tier, the vault balance and spend against the cap live (`web/components/ledger-page.tsx`).

Measured unit economics: `enable_thinking: false` takes one pricing decision from 274 reasoning tokens to 0 and from 159 to 26 micro-USD (`agent/src/brain.ts:21`).

## 0G: Build with 0G PC

> Inference on 0G Private Computer in your main user flow, with request IDs

- Every price the runtime signs comes from a 0G Private Computer call (`agent/src/brain.ts:21`). The router request id is required (`agent/src/brain.ts:26-27`) and hashed into the onchain quote as `keccak256(requestId ‖ tokenIn ‖ tokenOut)` (`agent/src/runtime.ts:148`).
- The swap page shows the 0G request id beside the price the taker is about to fill (`web/components/backing-panel.tsx:51`). Live: request `5319a0b6-562e-4bbe-a141-dfb94fc20aaa`, onchain `inferenceId 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7` in quote tx [`0x7b2433ba…daec`](https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec).

> A working app a judge can try, with a clear reason someone comes back tomorrow

- `<LIVE_URL>`: the swap page fills W0G/USDC through AquaSwapVMRouter from the judge's own wallet at the agent's signed price, with a countdown to the quote's expiry. The ledger page shows whether the agent is still paying its own way: vault balance, spend against the cap, budget tier, fees accrued and the latest funding step.
- The reason to return: the price moves, the agent re-prices on 0G, and the ledger shows its compute account rising with fills and falling with inference.

> One sentence on what breaks if 0G is removed

Remove 0G and the agent signs no price, so every Aqua fill reverts `StaleQuote`, and the fees it earns lose the compute bill they exist to pay.

> For the iAI bonus: a user signing in with their 0G account and their credit balance going down as they use your app

The agent's own wallet owns its 0G router account in 0G settlement, and its Payment Layer balance falls as the router draws its working deposit to bill inference: 2.844 to 2.344 0G with request `798fb102-9f06-4bc5-9ec2-1dde3b716628`.

## 1inch: Build an Aqua App (and the Continuity Track prize)

> Create a custom Aqua app that implements a sophisticated DeFi position. If you use SwapVM, you may modify SwapVM opcodes and define your own instructions. The final positions must be demonstrated through tests scripts or a UI.

The position is a two-sided W0G/USDC strategy priced by an AI agent, where SwapVM enforces the agent's signature on every fill. `AgentQuoteExtruction` is a custom SwapVM instruction invoked at Aqua opcode `0x20` (`contracts/script/ShipStrategy.s.sol:50`); it prices exact-in and exact-out at the signed rate minus the strategy fee and reverts `StaleQuote` in both `quote()` and `swap()` (`contracts/src/AgentQuoteExtruction.sol:44`). Positions are demonstrated by fork tests (`contracts/test/AgentQuote.t.sol`, `contracts/test/BaseW0G.t.sol`), by `bun run fork-e2e`, by the web swap page, and live on Base.

> Official Aqua/SwapVM contracts must be used (redeployments of a modified SwapVM contract is allowed)

- The strategy is shipped to the deployed Aqua [`0x1111113C…a90a`](https://basescan.org/address/0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a) and fills through the deployed, unmodified AquaSwapVMRouter v1.0.2 [`0x11111133…C0De`](https://basescan.org/address/0x111111338c5091E8440b67B168bAe16a668AC0De). Ship tx [`0xd342a0ff…181d`](https://basescan.org/tx/0xd342a0ff7a74e1a565ac80116af42f6ff00d2be2c97ff1db293b17c0f19b181d).
- `1inch/swap-vm` `v1.0.2` and `1inch/aqua` `v1.0.1` are pinned as submodules and selector-matched to the deployed bytecode (`contracts/README.md:38-44`). `test_aquaOpcode33IsNotExtruction` (`contracts/test/AgentQuote.t.sol:247`) pins the router's real opcode table.

> Onchain execution of token transfers should be presented during the final demo (local forks are ok)

- Base mainnet fill [`0x62f874c5…81a1`](https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1): 0.1 USDC in, 0.642507 W0G out, Aqua `safeBalances` moving 2 W0G / 0.5 USDC to 1.357492788767429240 W0G / 0.6 USDC.
- Fork proof with both token deltas and the `StaleQuote` revert after expiry: `contracts/test/BaseW0G.t.sol:145`, `:172`, `:199`, and `agent/scripts/fork-e2e.ts:57-59`.

> Proper Git commit history (no single-commit entries on the final day)

Small, dated commits from the first one, [`ae1859d`](https://github.com/Sakibimam/upkeep/commit/ae1859d), through contracts, fork tests, agent runtime, web app, Base mainnet loop and funding leg: https://github.com/Sakibimam/upkeep/commits/main

## Uniswap: Build with Uniswap (and the Continuity Track prize)

> A public GitHub repository with open-source code, a FEEDBACK.md file, and a completed submission to the Uniswap Developer Feedback Form (https://developers.uniswap.org/hackathon-feedback) that includes the link to your FEEDBACK.md file.

- Repository https://github.com/Sakibimam/upkeep, MIT licensed.
- [FEEDBACK.md](../FEEDBACK.md): concrete feedback from the live integration, each item with what worked, what broke and a suggested fix.
- Feedback form link field: `https://github.com/Sakibimam/upkeep/blob/main/FEEDBACK.md`.

> Make sure your README clearly points to the relevant contracts and lines of code so we can verify your integration.

| Uniswap piece | Role in Upkeep | Code |
| --- | --- | --- |
| v3 W0G/USDC 0.3% pool `0xe03cCe44…0c4e` | reference mid every signed price must sit within 3% of | `agent/src/price.ts:6`, `agent/src/price.ts:28`, band check `agent/src/brain.ts:44` |
| QuoterV2 `0x3d4e44Eb…B76a` | sizes the USDC fee conversion and its slippage floor | `agent/src/price.ts:36`, `agent/scripts/live-bootstrap.ts:41` |
| SwapRouter02 `0x2626664c…e481` | converts USDC fees to W0G before CCIP | `agent/src/funding.ts:29`, live swap [`0x3aea85c4…1e52`](https://basescan.org/tx/0x3aea85c4ccc887384a64ad74db859029507c214a6a0d1d2fe3e1bb86ea8f1e52) |

## Guards in front of the signer

A market maker that signs a bad price loses money to the first arbitrageur, so every guard sits before the signer and every miss means no quote:

- A router reply without a request id raises `request_id_missing` (`agent/src/brain.ts:26-27`), because a quote with no provenance breaks the onchain link to 0G.
- A rate more than 3% from the Uniswap mid raises `rate_out_of_range` (`agent/src/brain.ts:44`), and a spread outside 5 to 500 bps raises `spread_out_of_range` (`agent/src/brain.ts:33`).
- The board rejects a zero `inferenceId`, an expired quote, a non-increasing nonce, a same-token pair and any signer other than the registered agent (`contracts/src/AgentQuoteBoard.sol:58-69`). Any `setAgent` retires every outstanding quote.
- At fill time the Extruction re-checks freshness and reverts `StaleQuote` (`contracts/src/AgentQuoteExtruction.sol:44`), so the chain itself turns away an outdated price.

## Continuity disclosure

Upkeep is entered in the Continuity track. Development began on 2026-11-05, before the ETHGlobal Mumbai 2026 event window. The starting point is the repository's first commit, [`ae1859d`](https://github.com/Sakibimam/upkeep/commit/ae1859d) (2026-11-05 02:56 IST), and every later commit carries its date in the history.
