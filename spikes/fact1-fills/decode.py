import json,collections,urllib.request
PULL="0x3ad6";PUSH="0x3f18"
CH={"eth":"ethereum","base":"base"}
URL={"eth":"https://ethereum-rpc.publicnode.com","base":"https://base-rpc.publicnode.com"}
def w(d,i): return d[2+64*i:2+64*(i+1)]
def addr(x): return "0x"+x[-40:]
data={}
for n in ("eth","base"):
    L=json.load(open(n+"_logs.json"))["logs"]
    ev=[]
    for l in L:
        t=l["topics"][0][:6]
        if t in(PULL,PUSH):
            d=l["data"]
            ev.append(dict(kind="pull" if t==PULL else "push",tx=l["transactionHash"],block=int(l["blockNumber"],16),ts=int(l["blockTimestamp"],16),maker=addr(w(d,0)),app=addr(w(d,1)),sh=w(d,2),token=addr(w(d,3)),amt=int(w(d,4),16)))
    data[n]=ev
json.dump(data,open("events.json","w"))
print({n:len(v) for n,v in data.items()})
# apps
for n in data: print(n,collections.Counter(e["app"] for e in data[n]).most_common(5))
