import json,collections
from rpc import rpc
URL={"eth":"https://ethereum-rpc.publicnode.com","base":"https://base-rpc.publicnode.com"}
ev=json.load(open("events.json")); meta=json.load(open("tokens.json"))
ROUTER="0x111111338c5091e8440b67b168bae16a668ac0de"
AGG={"0x111111125421ca6dc452d289314280a0f8842a65":"1inch AggRouterV6","0x1111111254eeb25477b68fb85ed929f73a960582":"1inch AggRouterV5","0x1111111254fb6c44bac0bed2854e76f90643097d":"1inch AggRouterV4","0x111111111117dc0aa78b770fa6a738034120c302":"1INCH token"}
out={}
for n in ev:
    X=json.load(open(n+"_txs.json"))
    byTx=collections.defaultdict(lambda:{"pull":0.0,"push":0.0,"makers":set(),"pulls":[],"pushes":[],"pushes_":[]})
    for e in ev[n]:
        m=meta[f"{n}:{e['token']}"]; usd=e["amt"]/10**m["dec"]*m["px"]
        r=byTx[e["tx"]]; r[e["kind"]]+=usd; r["makers"].add(e["maker"]); r["pushes" if e["kind"]=="push" else "pulls"].append((m["sym"],round(usd,2)))
    # only tx with pull = fills
    fills={h:r for h,r in byTx.items() if r["pull"]>0}
    # code size cache
    cs={}
    def iscontract(a):
        if a not in cs: cs[a]=len(rpc(URL[n],"eth_getCode",[a,"latest"]))>2
        return cs[a]
    rows=[]
    for h,r in fills.items():
        t=X[h]; maker_is_from= t["from"] in r["makers"]; maker_is_to= t["to"] in r["makers"]
        if t["to"]==ROUTER: cat="direct to AquaRouter"+(" (from=maker)" if maker_is_from else "")
        elif t["to"] in AGG: cat="1inch aggregation router"
        elif maker_is_from: cat="maker itself (from=maker)"
        elif maker_is_to: cat="maker contract (to=maker)"
        elif iscontract(t["to"]): cat="other contract (solver/bot/app)"
        else: cat="EOA direct"
        rows.append((h,cat,t["to"],t["from"],r["pull"],r["push"],t["input4"]))
    out[n]=rows
    print("=====",n,"fill txs",len(rows),"pull USD",round(sum(x[4] for x in rows)),"push USD",round(sum(x[5] for x in rows)))
    c=collections.defaultdict(lambda:[0,0.0])
    for x in rows: c[x[1]][0]+=1; c[x[1]][1]+=x[4]
    for k,v in sorted(c.items(),key=lambda kv:-kv[1][0]): print(f"  {k:40s} n={v[0]:4d} vol=${v[1]:,.0f}")
    to=collections.defaultdict(lambda:[0,0.0])
    for x in rows: to[x[2]][0]+=1; to[x[2]][1]+=x[4]
    print(" top tx.to:",[(a,v[0],round(v[1])) for a,v in sorted(to.items(),key=lambda kv:-kv[1][0])[:8]])
    fr=collections.defaultdict(lambda:[0,0.0])
    for x in rows: fr[x[3]][0]+=1; fr[x[3]][1]+=x[4]
    print(" unique tx.from",len(fr),"top",[(a,v[0],round(v[1])) for a,v in sorted(fr.items(),key=lambda kv:-kv[1][0])[:6]])
    mk=collections.defaultdict(lambda:[0,0.0])
    for h,r in fills.items():
        for m in r["makers"]: mk[m][0]+=1; mk[m][1]+=r["pull"]/len(r["makers"])
    print(" makers filled:",len(mk),"top",[(a,v[0],round(v[1])) for a,v in sorted(mk.items(),key=lambda kv:-kv[1][0])[:6]])
    vols=sorted(x[4] for x in rows); print(" fill size USD median",round(vols[len(vols)//2],2),"p90",round(vols[int(len(vols)*.9)],2),"max",round(vols[-1]))
json.dump(out,open("classified.json","w"))
