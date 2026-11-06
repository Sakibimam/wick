#!/bin/bash
export FOUNDRY_DISABLE_NIGHTLY_WARNING=1
# args: label rpc pool quoter usdc w0g
L=$1; R=$2; P=$3; Q=$4; USDC=$5; W=$6
echo "=== $L pool $P"
echo -n "token0 "; cast call $P "token0()(address)" --rpc-url $R
echo -n "token1 "; cast call $P "token1()(address)" --rpc-url $R
FEE=$(cast call $P "fee()(uint24)" --rpc-url $R | awk '{print $1}'); echo "fee $FEE"
echo -n "liquidity "; cast call $P "liquidity()(uint128)" --rpc-url $R
echo -n "slot0 "; cast call $P "slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)" --rpc-url $R | head -2 | tr '\n' ' '; echo
echo -n "USDC in pool: "; cast call $USDC "balanceOf(address)(uint256)" $P --rpc-url $R
echo -n "W0G in pool: "; cast call $W "balanceOf(address)(uint256)" $P --rpc-url $R
for usd in 5 20 100 1000 5000; do
  amt=$((usd*1000000))
  out=$(cast call $Q "quoteExactInputSingle((address,address,uint256,uint24,uint160))(uint256,uint160,uint32,uint256)" "($USDC,$W,$amt,$FEE,0)" --rpc-url $R 2>&1 | head -1 | awk '{print $1}')
  echo "USDC \$$usd -> W0G $out"
done
