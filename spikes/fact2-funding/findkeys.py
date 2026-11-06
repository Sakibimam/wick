import json,sys
from keccak import keccak256
Z="4b948d64de1f71fcd12fb586f4c776421a35b3ee"
USDT="dac17f958d2ee523a2206206994597c13d831ec7"; ETH="0"*40
pools=json.load(open("pools.json"))
def pid(c0,c1,fee,ts,hooks="0"*40):
    return keccak256(bytes.fromhex(c0.rjust(64,"0")+c1.rjust(64,"0")+hex(fee)[2:].rjust(64,"0")+hex(ts if ts>=0 else (1<<256)+ts)[2:].rjust(64,"0")+hooks.rjust(64,"0"))).hex()
found={}
for liq,name,addr,vol,_,_ in pools[:10]:
    target=addr[2:]
    pct=float(name.split()[-1].rstrip("%"))
    c0,c1=(Z,USDT) if "USDT" in name else (ETH,Z)  # ETH(0) < 0G
    fees=set([round(pct*10000)]+[round(pct*10000)+d for d in(-1,1)]+[100,500,3000,10000,0x800000])
    hit=None
    for fee in fees:
        for ts in range(1,16384):
            if pid(c0,c1,fee,ts)==target: hit=(c0,c1,fee,ts,"0"*40); break
        if hit: break
    found[addr]=hit; print(name,addr[:14],"->",hit and (hit[2],hit[3]),flush=True)
json.dump(found,open("poolkeys.json","w"))
