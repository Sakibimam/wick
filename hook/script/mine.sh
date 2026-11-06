#!/usr/bin/env bash
# Mines a CREATE2 salt for AquaAggregatorHook: ID byte 0x1A first, permission flags 0x2888 last
# (beforeInitialize | beforeAddLiquidity | beforeSwap | beforeSwapReturnDelta).
# Usage: script/mine.sh <owner/broadcaster address>
set -euo pipefail
cd "$(dirname "$0")/.."
OWNER=${1:?owner address}
PM=0x498581fF718922c3f8e6A244956aF099B2652b2b
ROUTER=0x111111338c5091E8440b67B168bAe16a668AC0De
CREATE2_DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
forge build --silent
CODE=$(forge inspect AquaAggregatorHook bytecode)
ARGS=$(cast abi-encode "constructor(address,address,address)" $PM $ROUTER "$OWNER")
HASH=$(cast keccak "$(cast concat-hex "$CODE" "$ARGS")")
cast create2 --deployer $CREATE2_DEPLOYER --init-code-hash "$HASH" --starts-with 1a --ends-with 2888
