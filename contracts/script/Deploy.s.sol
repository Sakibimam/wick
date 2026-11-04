// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {AgentQuoteBoard} from "../src/AgentQuoteBoard.sol";
import {AgentQuoteExtruction} from "../src/AgentQuoteExtruction.sol";

/// @notice Deploys the Upkeep quote board and extruction on Base.
/// @dev When DEPLOYER_PK is set, the script broadcasts from that key. When it is
/// unset, the script runs a broadcast-free simulation from Foundry's default
/// sender so `forge script script/Deploy.s.sol --fork-url <base>` dry-runs
/// without a key.
contract Deploy is Script {
    function run() external {
        if (vm.envExists("DEPLOYER_PK")) {
            vm.startBroadcast(vm.envUint("DEPLOYER_PK"));
        } else {
            vm.startBroadcast();
        }

        AgentQuoteBoard board = new AgentQuoteBoard();
        AgentQuoteExtruction extruction = new AgentQuoteExtruction(board);

        vm.stopBroadcast();

        console2.log("AgentQuoteBoard", address(board));
        console2.log("AgentQuoteExtruction", address(extruction));
    }
}
