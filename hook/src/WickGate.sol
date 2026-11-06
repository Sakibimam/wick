// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Taker gate for the Wick Aqua strategy. The strategy program opens with SwapVM
/// `_onlyTakerTokenBalanceNonZero(WickGate)`, so only addresses holding a unit can fill it:
/// the v4 hook (the SwapVM taker for every Uniswap swap) and the agent. Fixed supply, minted once.
contract WickGate is ERC20 {
    constructor(address[] memory holders) ERC20("Wick Taker Gate", "WGATE") {
        for (uint256 i; i < holders.length; ++i) _mint(holders[i], 1);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}
