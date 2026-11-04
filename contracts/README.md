# Upkeep contracts

Upkeep's Aqua strategy executes only when the maker's registered agent has posted a signed quote for the same maker and token pair, and the quote has not expired. Each accepted quote stores the 0G Compute `inferenceId` used to produce it.

## Build and test

Requires Foundry with solc 0.8.30. From this directory:

```sh
forge fmt --check
forge build --sizes
forge test --match-contract AgentQuoteTest -vv
```

Fork tests use `https://ethereum-rpc.publicnode.com` by default. Set `ETH_RPC_URL` to use another Ethereum mainnet RPC:

```sh
export ETH_RPC_URL=https://your-mainnet-rpc
forge test --match-contract AgentQuoteTest -vv
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

The router is pinned to SwapVM `v1.0.2`: its deployed EIP-712 domain reports version `1.0.2`. The aqua source remapping bridges the path difference between SwapVM's `@1inch/aqua/src/interfaces/IAqua.sol` import and Aqua `v1.0.1`'s `contracts/interfaces/IAqua.sol` layout. Dependency files stay unmodified.

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

## Aqua opcode table

The general SwapVM `Opcodes.sol` positional table places Extruction at index 33. The deployed AquaSwapVMRouter uses the shorter Aqua-specific table in `AquaOpcodes.sol`: its effective Extruction index is 32 (`0x20`). Index 33 (`0x21`) is `onlyTxOriginTokenBalanceNonZero`. `test_aquaOpcode33IsNotExtruction` verifies that dispatch against the deployed router on a mainnet fork, and the fill tests execute the quote guard through index 32.

## Quote and fee behavior

`AgentQuoteBoard` uses EIP-712 domain name `Upkeep AgentQuoteBoard`, version `1`. A maker can register or revoke its agent. Quotes bind the maker, token pair, rate, expiry, nonce, and `inferenceId`; relayers can post valid agent signatures. Nonces increase strictly per maker. Expired quotes can be recorded, then fail closed when a strategy tries to fill them.

The quote rate is output token wei per `1e18` input token wei. For exact-in, the extruction floors gross output at the signed rate, then floors again after subtracting the output-side fee. For exact-out, it rounds up the gross output required before the fee, then rounds up the required input. `amountNetPulled` is preserved.

For USDC (6 decimals) and WETH (18 decimals), a price of 1 USDC to 1/3000 WETH uses `rateE18 = 333333333333333333333333334` to produce exactly `1e18` gross WETH for `3000e6` input under the specified integer math. `rateE18 = 1e27` with `3000e6` input produces `3e18` gross WETH under the same formula.

The `inferenceId` is the onchain audit link to the 0G Compute request. The 0G inference result stays outside this contract's validation boundary; fills validate the registered agent's EIP-712 signature, pair, nonce at posting, and quote expiry.

## Test coverage

`AgentQuoteTest` forks Ethereum mainnet and calls the deployed Aqua and AquaSwapVMRouter. It checks exact-in and exact-out quote/swap agreement, token balance deltas, expiry rejection, unregistered signer rejection, replayed and older nonce rejection, maker isolation, and the Aqua opcode dispatch. Test accounts use fixed numerical keys with `vm.addr` and `vm.sign` only.
