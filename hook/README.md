# AquaAggregatorHook

A Uniswap v4 aggregator hook that turns Wick's agent-signed 1inch Aqua strategy into a Uniswap pool. Any swap on the W0G/USDC pool behind this hook fills from the maker's Aqua balances at the price the Wick agent signed, through 1inch AquaSwapVMRouter v1.0.2. Uniswap's routers and interface see it as one more v4 pool.

It follows the pattern of Uniswap's Aggregator Hooks ([v4-hooks-public, src/aggregator-hooks](https://github.com/Uniswap/v4-hooks-public/tree/main/src/aggregator-hooks)): it extends `BaseAggregatorHook` (pinned at `e354058`) and implements `_conductSwap`, `_rawQuote`, `pseudoTotalValueLocked` and `_beforeInitialize`, so it exposes the same `quote(zeroToOne, amountSpecified, poolId)` and `pseudoTotalValueLocked(poolId)` that routing reads from every other aggregator hook, and it inherits the shared protocol fee accounting.

## How a swap fills

```
swapper ── Universal Router ── PoolManager.swap
                                   │ beforeSwap (returns delta)
                                   ▼
                          AquaAggregatorHook  (SwapVM taker)
                            1. take tokenIn from PoolManager
                            2. AquaSwapVMRouter.swap(order, tokenIn, tokenOut, amount, takerTraits)
                                 ├─ AgentQuoteExtruction prices from the agent's signed quote on AgentQuoteBoard
                                 ├─ Aqua.pull: tokenOut maker ──> hook
                                 └─ Aqua.push: tokenIn  hook  ──> maker
                            3. sync, transfer tokenOut, settle to PoolManager
                                   │
                                   ▼
                     BeforeSwapDelta cancels the v4 curve: the swapper pays tokenIn, receives tokenOut
```

- Exact-in and exact-out, both directions. Exact-out prices the input with `AquaSwapVMRouter.quote`, takes exactly that, and reverts `RouterAmountMismatch` if the fill disagrees by a single wei.
- Flash accounting balances to zero inside the hook: one `take` of the input, one `sync`/`transfer`/`settle` of the output. The hook ends every swap holding nothing.
- The pool takes no v4 liquidity (`beforeAddLiquidity` reverts `LiquidityNotAllowed`), so the Aqua strategy is the only price the pool has.

## Fails closed on a stale price

Wick's SwapVM program is `AgentQuoteExtruction`. It reverts `StaleQuote()` unless the maker's current agent signed an unexpired quote for that exact direction. The hook has no fallback price, so the Uniswap swap reverts with `StaleQuote` carried inside the PoolManager's `WrappedError`, and `hook.quote(...)` reverts with `StaleQuote` directly so routing drops the pool before it builds a route. The fork tests cover an expired quote, a rotated agent, and a direction the agent never signed.

## How Uniswap routing reaches it

1. The pool is a normal v4 `PoolKey` (W0G, USDC, fee 0, tick spacing 1, this hook). The hook address starts with the aggregator ID byte `0x1A` (1inch Aqua) and ends with the permission bits `0x2888`, following the aggregator hook ID convention from v4-hooks-public.
2. A router asks `quote(zeroToOne, amountSpecified, poolId)` and `pseudoTotalValueLocked(poolId)`. Depth per side is the smallest of the Aqua strategy balance, the maker's wallet balance and the maker's allowance to Aqua, because that is what `Aqua.pull` can actually move.
3. The swap goes through the Universal Router `V4_SWAP` command. When the swapper pays USDC, the standard `SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL` plan fills, since the PoolManager already holds USDC for the hook to take. When the swapper pays W0G, the router settles first: `SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL` puts the W0G in the PoolManager before the hook takes it. Both plans are exercised against the deployed Universal Router in the fork suite.

## Contract surface

| Function | Who | What |
|---|---|---|
| `setOrder(Order)` | owner | Points the hook at an Aqua strategy shipped to AquaSwapVMRouter. Wick's next order or board is one call, no redeploy. |
| `order()`, `orderHash()` | anyone | The strategy every pool on this hook fills from. |
| `quote(zeroToOne, amountSpecified, poolId)` | routers | Unspecified amount at the agent's signed rate minus the strategy fee, after protocol fee. |
| `pseudoTotalValueLocked(poolId)` | routers | Fillable depth per token. |

`beforeInitialize` accepts a pool only when both currencies are live balances of the current Aqua strategy (`TokensNotSupported` otherwise) and only after an order is set (`OrderNotSet`).

## Tests

All tests run on a Base mainnet fork pinned to block 53,796,900 against the deployed PoolManager, Universal Router 2.1.2, Permit2, AquaSwapVMRouter, Aqua, and the live Wick AgentQuoteBoard and AgentQuoteExtruction. A fresh maker ships a 50,000 W0G / 50,000 USDC strategy using the live extruction, sets a test agent on the live board, and posts EIP-712 signed quotes at the Uniswap v3 W0G/USDC mid.

```bash
git submodule update --init hook/lib/v4-hooks-public
git -C hook/lib/v4-hooks-public submodule update --init lib/forge-std lib/v4-core lib/v4-periphery lib/openzeppelin-contracts lib/protocol-fees
cd hook
forge test                                  # BASE_RPC_URL overrides the default public RPC
forge test --match-test test_revert -vv     # the must-fail set
forge test --match-test testFuzz -vv        # the fuzz set, 64 runs each
```

| Group | Tests |
|---|---|
| Fills | exact-in USDC to W0G, exact-in W0G to USDC, exact-out both directions, each asserting exact balance deltas for swapper and maker, PoolManager balances unchanged and a flat hook; the shipped Wick order filling from the agent quote that was live on chain at the fork block, with no re-signing; wiring and depth |
| Must fail | expired quote, rotated agent, unsigned direction (all surface `StaleQuote`); unsupported token at initialize; initialize before an order is set; `beforeSwap` and `beforeInitialize` from a non-PoolManager caller; adding liquidity; `setOrder` from a non-owner; min-out above the signed fill; quote beyond Aqua depth; W0G input with swap-before-settle |
| Fuzz | exact-in USDC to W0G and W0G to USDC across the strategy's depth, exact-out USDC to W0G |

## Deploy

```bash
cd hook
script/mine.sh <deployer>              # prints a CREATE2 salt for 0x1A...2888
SALT=<salt> forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --sender <deployer>             # simulation
SALT=<salt> forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --account <keystore> --broadcast
```

The script deploys through the CREATE2 deployer, checks the address carries the ID byte and permission bits, calls `setOrder` with the order in `ORDER_JSON` (default `../.progress/live-order.json`), initializes the pool at the Uniswap v3 W0G/USDC price, and quotes 0.1 USDC through the new pool. The deployer becomes the owner.

## Addresses (Base, chain 8453)

| Contract | Address |
|---|---|
| Uniswap v4 PoolManager | `0x498581fF718922c3f8e6A244956aF099B2652b2b` |
| Universal Router 2.1.2 | `0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| 1inch AquaSwapVMRouter v1.0.2 | `0x111111338c5091E8440b67B168bAe16a668AC0De` |
| 1inch Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` |
| Wick AgentQuoteBoard | `0x309933CE439Da6A059593d73B8c82E8C8447C3F8` |
| Wick AgentQuoteExtruction | `0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0` |

Uniswap addresses come from [docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments); every address above returns code from `cast code` on Base.
