import json, urllib.request, time, sys
URL={"eth":"https://ethereum-rpc.publicnode.com","base":"https://base-rpc.publicnode.com"}
def batch(url, calls):
    for i in range(4):
        try:
            req=urllib.request.Request(url,json.dumps(calls).encode(),{"content-type":"application/json","user-agent":"Mozilla/5.0"})
            return json.load(urllib.request.urlopen(req,timeout=60))
        except Exception as e: err=e; time.sleep(2)
    raise err
for n in ("eth","base"):
    d=json.load(open(n+"_logs.json"))
    hs=sorted({l["transactionHash"] for l in d["logs"]})
    out={}
    for i in range(0,len(hs),40):
        r=batch(URL[n],[{"jsonrpc":"2.0","id":j,"method":"eth_getTransactionByHash","params":[h]} for j,h in enumerate(hs[i:i+40])])
        for j,x in enumerate(sorted(r,key=lambda x:x["id"])):
            t=x["result"]; out[hs[i+j]]={"from":t["from"].lower(),"to":(t["to"] or "").lower(),"input4":t["input"][:10],"block":int(t["blockNumber"],16)}
    json.dump(out,open(n+"_txs.json","w")); print(n,len(out))
