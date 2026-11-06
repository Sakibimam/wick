import json,collections,sys,statistics
from rpc import rpc
SEL=sys.argv[1]
U={"eth":"https://ethereum-rpc.publicnode.com","base":"https://base-rpc.publicnode.com"}
BLK={"eth":12.0,"base":2.0}
ev=json.load(open("events.json")); meta=json.load(open("tokens.json"))
APP="0x111111338c5091e8440b67b168bae16a668ac0de"; AQ="0x1111113ccf1426a8e30e2bff5e005d929bf6a90a"
L=json.load(open("classified.json")); H=json.load(open("res_holders.json"))
rows_all={}
for n in ev:
    window_days=(json.load(open(n+"_logs.json"))["head"]-json.load(open(n+"_logs.json"))["start"])*BLK[n]/86400
    fillhash={r[0] for r in L[n]}
    st=collections.defaultdict(lambda:{"vol":0.0,"net":0.0,"fills":set(),"tokens":set()})
    for e in ev[n]:
        if e["tx"] not in fillhash: continue   # skip ship deposits
        m=meta[f"{n}:{e['token']}"]; usd=e["amt"]/10**m["dec"]*m["px"]
        k=(e["maker"],e["sh"]); s=st[k]
        s["tokens"].add(e["token"]); s["fills"].add(e["tx"])
        if e["kind"]=="pull": s["vol"]+=usd; s["net"]-=usd
        else: s["net"]+=usd
    out=[]
    for (mk,sh),s in st.items():
        liq=0.0; ok=True
        for t in s["tokens"]:
            try:
                data="0x"+SEL[2:]+mk[2:].rjust(64,"0")+APP[2:].rjust(64,"0")+sh+t[2:].rjust(64,"0")
                r=rpc(U[n],"eth_call",[{"to":AQ,"data":data},"latest"],tries=2)
                bal=int(r[2:66],16); m=meta[f"{n}:{t}"]; liq+=bal/10**m["dec"]*m["px"]
            except Exception as ex: ok=False
        out.append(dict(maker=mk,sh=sh,vol=s["vol"],net=s["net"],nfills=len(s["fills"]),liq=liq if ok else None))
    rows_all[n]=dict(days=window_days,rows=out)
    print("==",n,"window days",round(window_days,2),"strategies filled",len(out))
json.dump(rows_all,open("liq.json","w"))
