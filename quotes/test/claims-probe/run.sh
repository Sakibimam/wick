#!/bin/bash
# Real workerd: exactly one of 5 concurrent claims on one key wins, and a different key wins too.
cd "$(dirname "$0")/../.."
bunx wrangler dev -c test/claims-probe/wrangler.jsonc -c wrangler.jsonc --local --port 8799 >/tmp/claims-probe.log 2>&1 &
pid=$!; trap 'kill $pid 2>/dev/null' EXIT
for i in $(seq 1 40); do curl -sf -m 2 localhost:8799/ >/dev/null 2>&1 && break; sleep 1; done
out=$(curl -s -m 10 localhost:8799/); echo "$out"
[ "$out" = '{"concurrent":[200,409,409,409,409],"other":200}' ]
