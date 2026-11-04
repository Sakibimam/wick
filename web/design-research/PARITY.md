# Parity: elements direct competitors show on the swap screen

Competitors: Aerodrome, Uniswap, Matcha, CoW Swap, 1inch (all captured in refs/).

| Element | Aerodrome | Uniswap | Matcha | CoW | 1inch | Upkeep |
| --- | --- | --- | --- | --- | --- | --- |
| Sell and buy stacked fields, flip control | yes | yes | yes | yes | yes | build (flip swaps direction between W0G and USDC) |
| Fiat value line under amount | yes | yes | yes | no | yes | build (USDC side is already dollars, W0G side uses agent mid) |
| Token symbol selector | yes | yes | yes | yes | yes | skip: the pair is fixed to W0G and USDC because the Aqua strategy holds exactly this pair |
| Token logos | yes | yes | yes | yes | yes | build (drawn marks for W0G and USDC, no remote images) |
| Max and percentage chips | no | no | yes | no | no | build (25, 50, Max chips on the sell balance) |
| Wallet balance of the sell token | yes | yes | yes | yes | yes | build |
| Persistent primary action with state label (Connect, Wrong network, Approve, Swap) | yes | yes | yes | yes | yes | build |
| Network badge | no | no | yes | yes | yes | build (Base badge, wrong network is a state) |
| Rate line (1 W0G = x USDC) | yes | yes | yes | no | yes | build, with the quote expiry beside it |
| Slippage tolerance | yes | yes | yes | yes | yes | skip: the fill price is the signed quote, there is no price movement between sign and fill; stale quotes revert instead |
| Price impact and fees line | no | yes | yes | yes | yes | build (fee and amount out come from the router quote) |
| Live price ticker or market strip | no | no | yes | no | no | build (agent mid, quote age, tier as a three-cell strip) |
| Chart | no | no | yes | no | no | skip: chart does not help the decision, the question is whether the quote is fresh |
| Settings gear | yes | yes | yes | yes | no | skip: no user-tunable setting exists |
| Explorer links to the contract | no | no | no | yes | no | build (router, maker, board and every tx link out) |
| Empty or not connected state | yes | yes | yes | yes | yes | build |
| Error state with cause | yes | yes | yes | yes | yes | build (stale quote, balance, network, rejected, reverted, agent offline) |
