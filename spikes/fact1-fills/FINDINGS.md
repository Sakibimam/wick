# Fact 1: outside takers for a new Aqua strategy. Verdict: REFUTED (organic flow)

Claim tested: a newly shipped Aqua strategy gets outside takers within 48 h.
Window: Ethereum blk 26,334,161-26,344,151 (33.3 h), Base blk 53,216,777-53,519,177 (7.0 d). 

Fill = tx containing Aqua Pulled event; 557/595 traced via debug_traceTransaction.

- Ethereum 326 fills $100,922; Base 269 fills $9,418. 98.9% of Ethereum USD and 100% of Base came from EOAs holding 1inch soulbound "Access Token" (RES 0x26ffc7d3...).
- 1inch docs: Pathfinder routes only gated strategies, blocks Classic-Swap routing through Aqua; credential needs resolver onboarding + manual review (csm@1inch.com).
- Fresh strategies: 21 gated Ethereum 0 fills/31 h; 21 ungated Base 0 fills/26-160 h; 5 gated Base 3 fills (1.7 h, 4.4 h, 52.2 h).
- Ungated path open: 11 fills ($1.1k) from 6 non-RES EOAs (MEV bots e.g. 0xc0ffeebabe...).
- Median fill $94 (Eth), $23.6 (Base).
Design change: ship ungated, own taker UI, describe takers as UI users + arbitrageurs; request RES as upside.
Blind spot: one 33 h Ethereum window (public RPC caps getLogs at 10k blocks back).
