# inputs measured: models_live.json (router /v1/models), ../fact1-fills/stats.txt (turnover), gas.txt (dock+ship gas)
IN,OUT=600,150
cost_0gm=IN*0.08e-6+OUT*0.48e-6            # 0gm-1.0-35b-a3b live price (50% promo)
cost_0gm_full=cost_0gm*2                   # promo ends: 2x
cost_0gm_think=IN*0.08e-6+1500*0.48e-6     # thinking-on default: 10x output tokens
cost_cheap=IN*0.029e-6+OUT*0.117e-6        # qwen3.7-flash, cheapest chat with tools
gas_base=0.0013; gas_eth=0.0139            # dock+ship at current gas, fact3 gas.txt
OG=0.1598
print("per decision: 0gm %.6f (%.5f 0G)  0gm_fullprice %.6f  0gm_thinking1500out %.6f  qwen3.7-flash %.6f"%(cost_0gm,cost_0gm/OG,cost_0gm_full,cost_0gm_think,cost_cheap))
print("per requote all-in: Base %.5f  Eth %.5f (inference 0gm + dock/ship gas)"%(cost_0gm+gas_base,cost_0gm+gas_eth))
# turnover/day of vol/liquidity observed for strategies that WERE filled: ETH median .05 p75 .17 p90 .40 max .82 ; BASE .02 .05 .11 .19
scen={"ETH median":0.05,"ETH p75":0.17,"ETH p90":0.40,"BASE median":0.02,"BASE p90":0.11}
print("\nfee income USD/day = L * turnover * bps; requotes/day the fee can pay (inference-only 0gm | Base all-in | Eth all-in)")
print("%7s %5s %-12s %9s %9s %9s %9s"%("L","bps","turnover","fee$/day","inf-only","base","eth"))
for L in (100,500,2000):
    for bps in (5,30):
        for k,t in scen.items():
            f=L*t*bps/1e4
            print("%7d %5d %-12s %9.4f %9.0f %9.1f %9.1f"%(L,bps,k+" %.2fx"%t,f,f/cost_0gm,f/(cost_0gm+gas_base),f/(cost_0gm+gas_eth)))
