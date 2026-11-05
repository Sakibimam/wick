#!/usr/bin/env bash
# Runs the web app against a real agent on a local anvil fork of Base:
# anvil fork -> deploy board and ship the Aqua strategy -> post both signed prices ->
# agent runtime loop (reads the fork and the real 0G Payment Layer balance) -> status API -> next dev.
# Every transaction goes to the local fork. Nothing is sent to Base mainnet.
set -euo pipefail

WEB_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$(cd "$WEB_DIR/../agent" && pwd)"
FORK_URL="${BASE_FORK_URL:-https://base-rpc.publicnode.com}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
STATUS_PORT="${STATUS_PORT:-8787}"
WEB_PORT=3100
RPC="http://127.0.0.1:$ANVIL_PORT"
STATE_DIR="${STATE_DIR:-$AGENT_DIR/state/dev-fork}"
STATE_PATH="$STATE_DIR/fork.json"
export QUOTE_TTL_SECONDS="${QUOTE_TTL_SECONDS:-600}"
export FUNDING_THRESHOLD_USDC="${FUNDING_THRESHOLD_USDC:-10}"
export SPEND_CAP_PER_DAY_WEI="${SPEND_CAP_PER_DAY_WEI:-1000000000000000000}"

for p in "$ANVIL_PORT" "$STATUS_PORT" "$WEB_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $p is already in use:" >&2; lsof -nP -iTCP:"$p" -sTCP:LISTEN >&2
    echo "free it, or set ANVIL_PORT / STATUS_PORT to another port" >&2; exit 1
  fi
done
command -v anvil >/dev/null || { echo "anvil not found (install foundry)" >&2; exit 1; }
[ -d "$AGENT_DIR/node_modules" ] || (cd "$AGENT_DIR" && bun install)
[ -d "$WEB_DIR/node_modules" ] || (cd "$WEB_DIR" && bun install)

PIDS=()
cleanup() { for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done; }
trap cleanup EXIT INT TERM

mkdir -p "$STATE_DIR"
rm -f "$STATE_PATH" "$STATE_DIR/fork.env"
echo "anvil: forking Base from $FORK_URL on $RPC"
anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --block-time 2 --mixed-mining --silent &
PIDS+=($!)

echo "fork-setup: deploy, ship, post signed prices (ttl ${QUOTE_TTL_SECONDS}s)"
(cd "$AGENT_DIR" && RPC_URL="$RPC" STATE_PATH="$STATE_PATH" bun run scripts/fork-setup.ts)
# shellcheck disable=SC1091
source "$STATE_DIR/fork.env"

echo "runtime: agent loop against the fork, log at $STATE_DIR/runtime.log"
(cd "$AGENT_DIR" && BASE_RPC_URL="$RPC" STATE_PATH="$STATE_PATH" bun run src/runtime.ts >"$STATE_DIR/runtime.log" 2>&1) &
PIDS+=($!)
for _ in $(seq 1 60); do
  grep -q '"reason": "not_started"' "$STATE_PATH" || break
  grep -q "runtime failed" "$STATE_DIR/runtime.log" 2>/dev/null && { cat "$STATE_DIR/runtime.log" >&2; exit 1; }
  sleep 1
done
grep -q '"reason": "not_started"' "$STATE_PATH" && { echo "runtime did not finish its first tick in 60s" >&2; cat "$STATE_DIR/runtime.log" >&2; exit 1; }
echo "runtime: first tick done, tier $(grep -o '"tier": "[A-Z]*"' "$STATE_PATH" | head -1)"

echo "status: http://localhost:$STATUS_PORT"
(cd "$AGENT_DIR" && STATE_PATH="$STATE_PATH" PORT="$STATUS_PORT" BASE_RPC_URL="$RPC" WEB_ORIGIN="http://localhost:$WEB_PORT" bun run src/status.ts) &
PIDS+=($!)
for _ in $(seq 1 30); do curl -sf "http://localhost:$STATUS_PORT/api/status" >/dev/null && break; sleep 0.3; done
curl -sf "http://localhost:$STATUS_PORT/api/status" >/dev/null || { echo "status API did not start" >&2; exit 1; }

echo "web: http://localhost:$WEB_PORT (taker account $TAKER_ADDRESS, funded on the fork)"
cd "$WEB_DIR"
NEXT_PUBLIC_AGENT_URL="http://localhost:$STATUS_PORT" \
NEXT_PUBLIC_RPC_URL="$RPC" \
NEXT_PUBLIC_DEV_ACCOUNT="$TAKER_ADDRESS" \
NEXT_PUBLIC_FILL_FROM_BLOCK="$DEPLOY_BLOCK" \
  bun run dev &
PIDS+=($!)
wait "${PIDS[${#PIDS[@]}-1]}"
