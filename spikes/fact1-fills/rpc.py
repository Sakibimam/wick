import json, urllib.request, sys, time
def rpc(url, method, params, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params}).encode(), {"content-type":"application/json","user-agent":"Mozilla/5.0"})
            r = json.load(urllib.request.urlopen(req, timeout=60))
            if "error" in r: raise Exception(r["error"])
            return r["result"]
        except Exception as e:
            err = e; time.sleep(2)
    raise err
