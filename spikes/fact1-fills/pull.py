import json, sys
from rpc import rpc
AQ="0x1111113ccf1426a8e30e2bff5e005d929bf6a90a"
name,url,span,chunk=sys.argv[1],sys.argv[2],int(sys.argv[3]),int(sys.argv[4])
head=int(rpc(url,"eth_blockNumber",[]),16)
start=head-span
out=[]
b=start
while b<=head:
    e=min(b+chunk-1,head)
    out+=rpc(url,"eth_getLogs",[{"address":AQ,"fromBlock":hex(b),"toBlock":hex(e)}])
    b=e+1
json.dump({"head":head,"start":start,"logs":out},open(f"{name}_logs.json","w"))
print(name,"head",head,"start",start,"logs",len(out))
