Claim: On the deployed Ethereum AquaSwapVMRouter, `0x20` executes an Aqua strategy's Extruction and returns the same net amount in quote and swap, while `0x21` does not execute that Extruction.
Verdict: CONFIRMED for `0x20`; the brief's `0x21` opcode claim is REFUTED for AquaSwapVMRouter v1.0.2.

Measured: `forge test --match-contract DispatchSpikeTest -vv` against a mainnet fork passed with quote and swap both returning 0.997e18 WETH (gas 905,947). The same test with opcode `0x21` reverted at `DispatchSpikeTarget.balanceOf`, proving the fail case. Pinned source `lib/swap-vm/src/opcodes/AquaOpcodes.sol` maps effective opcode 32 to `Extruction._extruction` and opcode 33 to `Controls._onlyTxOriginTokenBalanceNonZero`.
Negative case: Replacing `0x20` with `0x21` made the fork test fail during quote because the router interpreted the target address as a token and called `balanceOf`.

Caveat: The general `Opcodes.sol` table used by non-Aqua routers places Extruction at index 33. AquaSwapVMRouter uses its shorter `AquaOpcodes.sol` table, so reusing the general index fails.
Blocks product: no, provided the strategy uses Aqua opcode `0x20`.
