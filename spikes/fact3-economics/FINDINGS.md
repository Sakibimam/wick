# Fact 3: inference cost vs maker fees. Verdict: inference CONFIRMED trivial; gas dominates
- Per decision (600 in / 150 out): qwen3.7-flash $0.000035; 0gm-1.0-35b-a3b $0.00012 (50% promo, $0.00024 full), thinking on ~$0.00077. 0gm is TeeML single-provider.
- Requote (dock+ship) gas: ~$0.0013 Base, ~$0.014 Ethereum (0.04 gwei).
- Turnover (filled strategies): Eth median 0.05x/day, p75 0.17x; Base median 0.02x.
- $500 @30 bps Eth-median turnover = $0.075/day = 625 inference decisions or 53 Base requotes. $2000 @30 bps p75 = $1.02/day = 718 Base requotes. $100 @5 bps = <2 requotes/day.
- Adverse selection: volatile pairs net -48 bps aggregate on Ethereum at mark; stable-stable +2.5 bps (Eth), +12 bps (Base), n=3 each.
Design change: Base only, requote on price-deviation trigger not timer, cheap model with thinking off; quote a stable-ish pair; income is cents/day.
