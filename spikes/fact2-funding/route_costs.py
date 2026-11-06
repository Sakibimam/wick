# all inputs are measured values copied from the eth_call / API outputs in this directory
ETHPX=2420.98
# v4 0G/USDT pool 0xb6b8.. (Ethereum), Quoter eth_call, spot from StateView.getSlot0
sp=32617482462132810147464; spot=(sp/2**96)**2*10**(18-6)
v4={5:26531392067317418598,20:105824467757578255318,100:521235120452639321800,1000:4463794829658863220063}
# Uniswap v3 W0G/USDC 0.3% pool on Base, QuoterV2 eth_call
sp3=31675063919769202650270; spot3=(sp3/2**96)**2*10**(18-6)
v3={5:31186280992784508797,20:124722945952271104094,100:623023981215517039030,1000:6164543687195019407447,5000:29442866273880101371231}
ccip_fee_usd=108007899353172/1e18*ETHPX
lifi={5:4.15,20:4.14,100:3.76,1000:None,2000:4.14}   # loss % = 1 - toAmountUSD/fromAmountUSD from li.quest keyless quotes
print("v4 spot USDT/0G %.5f ; v3 spot USDC/W0G %.5f"%(spot,spot3))
print("CCIP Base->0G flat fee $%.3f"%ccip_fee_usd)
print("%6s | %-34s | %-30s | %-18s"%("USD","A: Uniswap v4 0G/USDT (ETH)","B: v3 W0G/USDC + CCIP (Base)","C: LI.FI USDC->0G"))
for usd in (5,20,100,1000):
    a=(1-(v4[usd]/1e18*spot)/usd)*100
    b_swap=(1-(v3[usd]/1e18*spot3)/usd)*100
    b=b_swap+ccip_fee_usd/usd*100
    c=lifi.get(usd)
    print("%6d | %5.2f%% vs spot (fee 9.89%%+impact) | %5.2f%% swap +%5.2f%% CCIP = %5.2f%% | %s"%(usd,a,b_swap,ccip_fee_usd/usd*100,b,"%.2f%%"%c if c is not None else "n/a"))
