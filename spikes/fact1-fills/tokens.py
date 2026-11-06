import json,urllib.request,time
from rpc import rpc
ev=json.load(open("events.json"))
CH={"eth":"ethereum","base":"base"}
URL={"eth":"https://ethereum-rpc.publicnode.com","base":"https://base-rpc.publicnode.com"}
meta={}
def dec_str(h):
    b=bytes.fromhex(h[2:])
    if len(b)==32: return b.rstrip(b"\0").decode(errors="ignore")
    ln=int.from_bytes(b[32:64],"big"); return b[64:64+ln].decode(errors="ignore")
for n in ev:
    toks=sorted({e["token"] for e in ev[n]})
    for t in toks:
        try:
            d=int(rpc(URL[n],"eth_call",[{"to":t,"data":"0x313ce567"},"latest"]),16)
            s=dec_str(rpc(URL[n],"eth_call",[{"to":t,"data":"0x95d89b41"},"latest"]))
        except Exception as e: d,s=18,"?"
        meta[f"{n}:{t}"]={"dec":d,"sym":s}
    keys=",".join(f"{CH[n]}:{t}" for t in toks)
    r=json.load(urllib.request.urlopen(urllib.request.Request("https://coins.llama.fi/prices/current/"+keys,headers={"user-agent":"Mozilla/5.0"}),timeout=60))["coins"]
    for t in toks:
        c=r.get(f"{CH[n]}:{t}"); meta[f"{n}:{t}"]["px"]=c["price"] if c else None
json.dump(meta,open("tokens.json","w"),indent=1)
for k,v in meta.items(): print(k[:12],v)
