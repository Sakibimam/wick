#!/usr/bin/env bash
# Loads the agent's two secrets into the deployed Worker so its cron can sign and post quotes.
# Usage: bash scripts/push-secrets.sh [worker-name]   (default: wick)
# AGENT_PK comes from DEPLOYER_PK in contracts/.env, ZG_API_KEY from agent/.env.
# Each value travels only through a pipe into `wrangler secret put`; nothing is printed or written.
set -euo pipefail
set +x
root="$(cd "$(dirname "$0")/.." && pwd)"
worker="${1:-wick}"
wrangler="$root/web/node_modules/.bin/wrangler"
[ -x "$wrangler" ] || { echo "wrangler missing: run bun install in web/ first" >&2; exit 1; }

read_env() { # file key -> value on stdout, quotes stripped, never echoed to the terminal
  local line
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2=" "$1" | tail -n 1 || true)"
  line="${line#*=}"
  line="${line%$'\r'}"
  line="${line#\"}"; line="${line%\"}"; line="${line#\'}"; line="${line%\'}"
  printf '%s' "$line"
}

put() { # secret-name file key
  local value
  [ -f "$2" ] || { echo "$2 not found" >&2; exit 1; }
  value="$(read_env "$2" "$3")"
  [ -n "$value" ] || { echo "$3 is empty in $2" >&2; exit 1; }
  printf '%s' "$value" | (cd "$root/web" && "$wrangler" secret put "$1" --name "$worker" >/dev/null)
  unset value
  echo "set $1 on $worker from $3 in ${2#$root/}"
}

put AGENT_PK "$root/contracts/.env" DEPLOYER_PK
put ZG_API_KEY "$root/agent/.env" ZG_API_KEY
echo "The next cron run (every 5 minutes) signs and posts both quotes when the budget policy allows."
