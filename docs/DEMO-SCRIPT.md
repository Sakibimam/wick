# Wick demo script

Runtime 2:55. One protagonist: the agent, from its first thought to its paid bill. One trader: the viewer's own wallet on the live site.

**The one sentence** (said in the first 10 seconds and again at the end): an AI trading agent whose fees pay for its own thinking.

**Two terms, each defined on first use:** *market maker* (0:10) and *signed price* (0:55). Every other protocol name appears only as an on-screen label next to its explorer page.

## Beats

| Time | On screen | Narration | Live evidence held on screen |
| --- | --- | --- | --- |
| 0:00 to 0:10 | `https://wick.earn-shield-alerts.workers.dev/ledger`, zoomed 1.6x on the AI account balance and the budget tier chip | "This number is an AI's bank account. It belongs to a trading agent, the agent pays its own AI bill from it, and nobody tops it up." | Ledger page: vault balance in 0G, tier NORMAL, spend against the daily cap |
| 0:10 to 0:25 | Mechanism scene: a shop counter with two price cards, BUY and SELL; a coin drops into a jar labelled "AI bill" on every trade | "A market maker is a shop that always offers to buy and to sell, and keeps a small fee on every trade. This one is an AI agent: each price it offers comes from one AI call, and the fees pay for the next call." | Caption: "fees in, AI bill paid" |
| 0:25 to 0:40 | Terminal: the agent runtime ticking every 15 seconds; one line highlighted: Uniswap mid, tier, "requote" | "Every 15 seconds the agent reads the market price from a Uniswap pool and checks its own balance. Nobody is pressing a button: when the price moves enough, it decides to think." | Runtime log lines with timestamps 15 s apart |
| 0:40 to 0:55 | `https://wick.earn-shield-alerts.workers.dev/ledger`, inference row zoomed; callout on the request id | "It asks a model on 0G for a price. That request has an id, right here, and that answer cost 29 millionths of a dollar." | 0G request id `5319a0b6-562e-4bbe-a141-dfb94fc20aaa`, model `0gm-1.0-35b-a3b`, 29 micro-USD |
| 0:55 to 1:15 | Basescan tx `0x7b2433ba…daec`, decoded input, `inferenceId` row highlighted; then a terminal running `cast keccak` | "The agent turns the answer into a signed price: a price only its own key could have written. It posts that on Base, stamped with a fingerprint of the AI request. Anyone can check it: same request id in, same fingerprint out." | https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec, `inferenceId 0xa084340d4e3fb5e3328761d25335ad5fcfd25a223be18fba092f95b3afb4e7e7` matching the `cast keccak` output |
| 1:15 to 1:35 | `https://wick.earn-shield-alerts.workers.dev` swap page: the signed price, the countdown to expiry, the "Request id on 0G" line in the backing panel; the trader clicks Swap and the real wallet popup appears | "A trader opens the page. Before trading they see the price, the AI request behind it and how long that price stays good. They swap from their own wallet." | Swap page with request id and countdown; real wallet popup (hover Approve, the recorded fill below stands as the landed proof) |
| 1:35 to 1:50 | Basescan fill tx `0x62f874c5…81a1`, token transfer rows highlighted, held 4 s | "The 1inch pool checks the signature on chain and pays exactly the signed price, minus the fee. Here it is on Base: ten cents of USDC in, 0.64 of the 0G token out, and the fee stays with the agent." | https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1: 0.1 USDC in, 0.642507 W0G out |
| 1:50 to 2:02 | Mechanism scene: the price card's countdown hits zero, the card greys out, the pool's door shuts with the label `StaleQuote` | "And if the price gets old, the pool shuts. No fresh thought, no trade. The chain itself enforces it." | `bun run fork-e2e` output line: expected `StaleQuote` after expiry, green |
| 2:02 to 2:30 | Three explorer pages in sequence, each held 3 to 4 s, each with a one-word label: SHIP, UNWRAP, DEPOSIT | "When fees pile up, the agent pays its bill. It ships its tokens from Base to the 0G chain over Chainlink, unwraps them, and deposits them straight into its own AI account. Zero becomes 2.844." | CCIP: https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e (status Success, 1.0 W0G delivered). Unwrap: https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d. Deposit: https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68 (`depositFor`, `Deposited.user` = agent, 2.844 0G) |
| 2:30 to 2:43 | Terminal: the 0G router response for the next request, `"currency":"0g"` highlighted; then `cast call balanceOf` on the 0G Payment Layer; then the ledger balance | "Its next thought is billed in 0G, out of that account. The balance drops from 2.844 to 2.344 as 0G draws the deposit it bills against. The loop is closed." | 0G request `798fb102-9f06-4bc5-9ec2-1dde3b716628`, `"currency":"0g"`, 0.00004166 0G; `balanceOf(0xeF2E5ba8…d953)` on `0xA3b15Bd2…cE32` reads 2.344 0G |
| 2:43 to 2:55 | `https://wick.earn-shield-alerts.workers.dev/ledger`, the tier meter's four steps, NORMAL, LOW, CRITICAL and PAUSED, with the live tier lit; end card with the repo path | "When money runs low it switches to a cheaper model, then stops thinking, then stops trading, all before it overspends. An AI trading agent whose fees pay for its own thinking. Wick." | Tier meter; end card: `https://wick.earn-shield-alerts.workers.dev` and github.com/Sakibimam/wick |

## Capture list

| Asset | Source |
| --- | --- |
| Ledger page and swap page | `https://wick.earn-shield-alerts.workers.dev/ledger` and `https://wick.earn-shield-alerts.workers.dev`, at 1440 wide, zoom 1.6x on the element the line names |
| Runtime ticks | `cd agent && bun run runtime`, 45 s of log |
| Signed quote | https://basescan.org/tx/0x7b2433ba9b1438cdc23bfd1ff1c8a3cccc4cc309f9ea770e70028a100ca3daec |
| Fingerprint check | `cast keccak "5319a0b6-562e-4bbe-a141-dfb94fc20aaa0x833589fCD6eDb6E08f4c7C32D4f71b54bdA029130x23cd099eB438CcA50349EE2BC809196b1ae00861"` beside `cast call 0x309933CE439Da6A059593d73B8c82E8C8447C3F8 "getQuote(address,address,address)((address,address,address,uint256,uint64,uint64,bytes32))" 0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 0x23cd099eB438CcA50349EE2BC809196b1ae00861 --rpc-url https://base-rpc.publicnode.com` |
| Fill | https://basescan.org/tx/0x62f874c5c240ff107114d745ccf8adbd919fdf97d28ae06ab5d4f10184d0c7a1 |
| Stale price shut | `cd agent && bun run fork-e2e`, the `StaleQuote` line |
| Bridge | https://ccip.chain.link/tx/0xd0b46ef5b745bf9931d3633d41b3e9c124566289753fe1062c7b18e3754c876e |
| Unwrap | https://chainscan.0g.ai/tx/0x6e12d8d0e62f70123c0bbafa7a977cb6e60e556c2c690e4fb4ce47df7b0b5a0d |
| Deposit | https://chainscan.0g.ai/tx/0x8b0b60f8559bb609dcea0338ae86a5b9a546ec011061f673d18db8c072663f68 |
| Billed in 0G | router response for request `798fb102-9f06-4bc5-9ec2-1dde3b716628`, then `cast call 0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32 "balanceOf(address)(uint256)" 0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953 --rpc-url https://evmrpc.0g.ai` |

Explorer frames are crisp 2x captures with the named row highlighted, held 3 to 4 seconds while the narration names them. Captions are burned in for every narration line.
