# Fact 2: fee income to 0G Compute. Verdict: Uniswap v4 0G path REFUTED; W0G v3 + CCIP + Payment Layer CONFIRMED
- 27 v4 pools for Ethereum 0G (LayerZero OFT) carry 9.9%-88% fees; best ~$7.9k liquidity, ~$99/day. Buy cost vs market 15.2% ($5) to 28.7% ($1000). Trading API keyless -> 401.
- W0G (Chainlink CCIP wrapped 0G) Uniswap v3 0.3% USDC pools: Base 0xe03cCe44..., Ethereum 0x51025A99..., ~$168k liquidity each. Quoter cost 0.31% ($5), 0.32% ($20), 0.42% ($100), 1.47% ($1000).
- CCIP W0G Base->0G chain: flat 0.000108 ETH (~$0.26); then W0G.withdraw(uint256) -> native 0G on 16661. Unwrap eth_call OK for 4/4 EOA holders, reverts for contract holders => agent wallet must be an EOA. CCIP Base finality ~18 min (docs say 5-15).
- LI.FI keyless: Base USDC -> native 0G one tx, ~4% loss, includes gas; ETA 10-20 s (estimate).
- Payment Layer 0xA3b15Bd2... beacon proxy (impl 0x0487f33F...): depositFor(address) payable, anyone may fund any address (eth_call from random sender OK; value 0 reverts ZeroAmount()). Router key spends owner vault via backend spendFrom. No x402/USDC payment path.
Design change: bootstrap via LI.FI, steady state Uniswap v3 W0G/USDC on Base + CCIP + unwrap, settle weekly; never the v4 0G pool.
