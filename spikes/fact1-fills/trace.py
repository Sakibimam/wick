import json,sys,time,concurrent.futures as cf
from rpc import rpc
U={"eth":"https://eth.drpc.org","base":"https://base.drpc.org"}
C=json.load(open("classified.json"))
def one(n,h):
    for i in range(3):
        try: return rpc(U[n],"debug_traceTransaction",[h,{"tracer":"callTracer"}],tries=1)
        except Exception as e: time.sleep(1.5)
    return None
for n in ("eth","base"):
    hs=[r[0] for r in C[n]]; out={}
    with cf.ThreadPoolExecutor(4) as ex:
        for h,t in zip(hs,ex.map(lambda h:one(n,h),hs)):
            out[h]=t
    ok=sum(1 for v in out.values() if v); print(n,"traced",ok,"/",len(hs))
    # strip inputs to save space
    def strip(c):
        return {"from":c["from"],"to":c.get("to"),"sel":c.get("input","")[:10],"type":c.get("type"),"calls":[strip(x) for x in c.get("calls",[])]}
    json.dump({h:(strip(t) if t else None) for h,t in out.items()},open(f"traces_{n}.json","w"))
