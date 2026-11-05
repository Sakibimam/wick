# Upkeep contracts

Upkeep's Aqua strategy executes only when the maker's registered agent has posted a signed quote for the same maker and token pair, and the quote has not expired.

Each accepted quote stores the 0G Compute `inferenceId` used to produce it.

## Build and test

Requires Foundry with solc 0.8.30. From this directory:

```sh
forge fmt --check
forge build --sizes
forge test --match-contract AgentQuoteTest -vv
forge test --match-contract BaseW0GTest -vv
```

Ethereum fork tests use `https://ethereum-rpc.publicnode.com` by default. Set `ETH_RPC_URL` to use another Ethereum mainnet RPC:

```sh
export ETH_RPC_URL=https://your-mainnet-rpc
forge test --match-contract AgentQuoteTest -vv
```

Base fork tests use `https://base-rpc.publicnode.com` by default. Set `BASE_RPC_URL` to use another Base RPC:

```sh
export BASE_RPC_URL=https://your-base-rpc
forge test --match-contract BaseW0GTest -vv
```

The `lib/` sources are committed at the pinned revisions below. `forge-std` is a pinned Git submodule. Clone with `--recurse-submodules` to initialize it.

## Pinned dependencies

| Dependency | Tag | Commit |
| --- | --- | --- |
| [1inch/swap-vm](https://github.com/1inch/swap-vm) | `v1.0.2` | `32c687c2b73101fc26549e48fa1ff8a4d73afbac` |
| [1inch/aqua](https://github.com/1inch/aqua) | `v1.0.1` | `7219b1763b0099e7ab1e76b0f21053d95a6b69e5` |
| [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | `v5.4.0` | `c64a1edb67b6e3f4a15cca8909c9482ad33a02b0` |
| [1inch/solidity-utils](https://github.com/1inch/solidity-utils) | `6.9.7` | `29043f22422fde454951e9733129cce5d67e6a39` |
| [foundry-rs/forge-std](https://github.com/foundry-rs/forge-std) | `v1.11.0` | `8e40513d678f392f398620b3ef2b418648b33e89` |

The router is pinned to SwapVM `v1.0.2`: its deployed `eip712Domain()` returns name `1inch SwapVM v1.0` and version `1.0.2`. The aqua source remapping bridges the path difference between SwapVM's `@1inch/aqua/src/interfaces/IAqua.sol` import and Aqua `v1.0.1`'s `contracts/interfaces/IAqua.sol` layout. Dependency files stay unmodified.

## Mainnet reference

The fork tests use the deployed contracts and tokens:

| Contract | Address |
| --- | --- |
| AquaSwapVMRouter | `0x111111338c5091E8440b67B168bAe16a668AC0De` |
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |

Live bytecode was inspected at Ethereum block `26344307` using `cast code` and `cast keccak`:

| Contract | Code hash |
| --- | --- |
| AquaSwapVMRouter | `0x1ffc57300722e5a2c523b5131e17c01950f447718449e1c9fd2ab382b3e340f9` |
| Aqua | `0x720bc02d220db318164dc3bade86eec1f3655bdc00fc1174de7d816a95c341f8` |

These selectors were found in the deployed bytecode by matching `cast code` output with `grep -o`:

| Router selector | Function |
| --- | --- |
| `0xf4d2d412` | `swap` |
| `0x44aa5f14` | `quote` |
| `0xf5d08521` | `hash` |
| `0xceb9a5d8` | `asView` |
| `0x63fccba9` | `AQUA` |
| `0x8da5cb5b` | `owner` |
| `0x84b0196e` | `eip712Domain` |
| `0xf973a209` | `ORDER_TYPEHASH` |

| Aqua selector | Function |
| --- | --- |
| `0xf50b870f` | `ship` |
| `0xb00bbd10` | `pull` |
| `0x47d72768` | `push` |
| `0x28defc17` | `dock` |
| `0x6d58b4cc` | `rawBalances` |
| `0x65f2fe14` | `safeBalances` |

## Base

The same `AgentQuoteBoard` and `AgentQuoteExtruction` run against the real W0G/USDC pair on Base mainnet. W0G is CCIP-bridged 0G with 18 decimals; USDC has 6 decimals. The board's EIP-712 domain uses Base chainId `8453`.

### Base addresses

| Contract | Address |
| --- | --- |
| Aqua | `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a` |
| AquaSwapVMRouter | `0x111111338c5091E8440b67B168bAe16a668AC0De` |
| W0G | `0x23cd099eB438CcA50349EE2BC809196b1ae00861` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Uniswap v3 W0G/USDC 0.3% | `0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e` |

At Base block `53521567`, Aqua runtime was 5,619 bytes and AquaSwapVMRouter runtime was 20,541 bytes. `router.AQUA()` returned the Aqua address above, and `router.eip712Domain()` reported chainId `8453`. W0G reported 18 decimals and symbol `W0G`; USDC reported 6 decimals. The pool reported token0 `W0G`, token1 `USDC`, and fee `3000`. The tests read the mid from `slot0().sqrtPriceX96`; that mid is a reference price, not an execution oracle.

### Base commands

```sh
export BASE_RPC_URL=https://base-rpc.publicnode.com
forge test --match-contract BaseW0GTest -vv
```

Deploy without a key. This uses Foundry's default sender and a broadcast-free simulation, so it reads no key and sends nothing:

```sh
forge script script/Deploy.s.sol --fork-url "$BASE_RPC_URL"
```

Deploy for real. The deployer key is read only from `DEPLOYER_PK` and is never written to a file:

```sh
DEPLOYER_PK=... forge script script/Deploy.s.sol --rpc-url "$BASE_RPC_URL" --broadcast
```

Ship the two-sided W0G/USDC strategy. `W0G_AMOUNT` and `USDC_AMOUNT` are raw units (18 and 6 decimals):

```sh
BOARD=0x... \
EXTRUCTION=0x... \
MAKER_PK=... \
W0G_AMOUNT=50000000000000000000000 \
USDC_AMOUNT=50000000000 \
FEE_BPS=30 \
forge script script/ShipStrategy.s.sol --rpc-url "$BASE_RPC_URL" --broadcast
```

The maker must hold at least `W0G_AMOUNT` W0G and `USDC_AMOUNT` USDC. `ship` records Aqua allowances; it does not move tokens. The script checks that `EXTRUCTION.board()` equals `BOARD`, approves Aqua for both tokens, and ships one strategy with a W0G balance and a USDC balance so the same order hash serves both directions. It prints the strategy hash and the taker order struct as JSON on stdout:

```json
{"strategyHash":"0x...","order":{"maker":"0x...","traits":"0x...","data":"0x..."},"pair":{"w0g":"0x23cd099eB438CcA50349EE2BC809196b1ae00861","usdc":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","feeBps":30},"amounts":{"w0g":"50000000000000000000000","usdc":"50000000000"}}
```

### Pricing trust

Pricing trust sits with the agent signer. 

`AgentQuoteBoard` stores the signed `rateE18` and does not read the Uniswap pool, compute a mid, or enforce a deviation band. A quote arbitrarily far from the onchain mid still fills at the signed rate.

`BaseW0GTest.test_quoteFarOutsideMidBandStillFillsAtQuotedRate` posts a 2x-mid quote and proves the fill pays exactly 2x mid minus the fee, and the board stores that rate verbatim. 

A compromised, buggy, or malicious agent key can therefore price a fill away from the market. Takers must compare the signed rate with their own reference before filling. The board enforces quote freshness, maker and pair binding, strictly increasing nonces, and agent rotation, not price correctness.

## Aqua opcode table

Both `v1.0.2` `AquaOpcodes.sol` and the general `Opcodes.sol` build their opcode table as a fixed-size memory array, then return it as a dynamic array by setting `result := instructions` and writing `instructions.length - 1` to the first memory slot. That slot held source element 0, the first `_notInstruction`, so it is overwritten by the dynamic-array length; returned opcode 0 is source element 1.

In Aqua's `AquaOpcodes.sol`, Extruction is source element 33 and therefore effective opcode 32 (`0x20`). Source element 34, `Controls._onlyTxOriginTokenBalanceNonZero`, is effective opcode 33 (`0x21`). The general `Opcodes.sol` has Extruction at source element 34, effective index 33, but the deployed AquaSwapVMRouter uses the Aqua table. `test_aquaOpcode33IsNotExtruction` verifies that `0x21` dispatches to `Controls._onlyTxOriginTokenBalanceNonZero` on the deployed router; the fill tests verify that `0x20` dispatches to Extruction.

To check the known selectors in the deployed router bytecode:

```sh
ROUTER=0x111111338c5091E8440b67B168bAe16a668AC0De
cast code "$ROUTER" --rpc-url https://ethereum-rpc.publicnode.com | grep -oiE 'f4d2d412|44aa5f14|f5d08521|ceb9a5d8|63fccba9|8da5cb5b|84b0196e|f973a209'
```

## Quote and fee behavior

`AgentQuoteBoard` uses EIP-712 domain name `Upkeep AgentQuoteBoard`, version `1`. A maker can register or revoke its agent. Quotes bind the maker, token pair, rate, expiry, nonce, and `inferenceId`; relayers can post valid agent signatures. Posting rejects expired quotes, zero rates, zero or missing `inferenceId`, same-token pairs, and zero tokens. Nonces increase strictly per maker. Every `setAgent` call, including setting the same agent or revoking with zero, advances the maker's agent epoch and invalidates outstanding quotes. Fills check that the quote belongs to the current agent epoch and re-check expiry. Views include `getAgent`, `lastNonce`, and `isQuoteCurrent`.

The quote rate is output token wei per `1e18` input token wei. For exact-in, the extruction floors gross output at the signed rate, then floors again after subtracting the output-side fee. For exact-out, it rounds up the gross output required before the fee, then rounds up the required input. `amountNetPulled` is preserved.

For USDC (6 decimals) and WETH (18 decimals), a price of 1 USDC to 1/3000 WETH uses `rateE18 = 333333333333333333333333334` to produce exactly `1e18` gross WETH for `3000e6` input under the specified integer math. `rateE18 = 1e27` with `3000e6` input produces `3e18` gross WETH under the same formula.

The `inferenceId` is the onchain audit link to the 0G Compute request. The 0G inference result stays outside this contract's validation boundary; fills validate the current agent epoch, pair, nonzero rate and `inferenceId`, and quote expiry.

## Verification evidence

- SwapVM tag `v1.0.2` resolves to `32c687c2b73101fc26549e48fa1ff8a4d73afbac`; Aqua tag `v1.0.1` resolves to `7219b1763b0099e7ab1e76b0f21053d95a6b69e5`.
- The deployed router `0x111111338c5091E8440b67B168bAe16a668AC0De` reports `1inch SwapVM v1.0` and `1.0.2` from `eip712Domain()`.
- `cast code` on the deployed router contains selectors `f4d2d412`, `44aa5f14`, `f5d08521`, `ceb9a5d8`, `63fccba9`, `8da5cb5b`, `84b0196e`, and `f973a209`.
- Contract runtime sizes must remain below 24,576 bytes. `forge build --sizes` measured `AgentQuoteBoard` at 4,012 bytes and `AgentQuoteExtruction` at 2,193 bytes.
- On Base at block `53521567`, `AquaSwapVMRouter` and `Aqua` at the addresses above returned the same Aqua runtime as Ethereum and a router `eip712Domain()` chainId of `8453`; `W0G` returned 18 decimals and the pool returned token0 `W0G`, token1 `USDC`, fee `3000`.
- `BaseW0GTest` passes 5 tests against the real Base W0G/USDC pair. `ShipStrategy.s.sol` was also exercised end to end on a local Base fork: it printed a strategy hash, and Aqua reported both token balances with `tokensCount = 2`.

## Test coverage

`AgentQuoteTest` forks Ethereum mainnet and calls the deployed Aqua and AquaSwapVMRouter. It checks that both `quote()` and `swap()` fail closed for missing, expired, or rotated-agent quotes, exact-in and exact-out quote/swap agreement at a non-default fee, token balance deltas, unregistered signer rejection, replayed and older nonce rejection, maker isolation, and the Aqua opcode dispatch. Test accounts use fixed numerical keys with `vm.addr` and `vm.sign` only.

`BaseW0GTest` forks Base mainnet and exercises the real W0G/USDC pair through the deployed Aqua and AquaSwapVMRouter: one two-sided strategy, both exact-in directions priced from Uniswap v3 `slot0`, exact balance deltas against the signed quote minus fee, stale-quote failure, and the no-mid-check pricing-trust test.
