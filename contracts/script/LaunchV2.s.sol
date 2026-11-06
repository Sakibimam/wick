// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {AgentQuoteBoardV2} from "../src/AgentQuoteBoardV2.sol";
import {AgentQuoteExtructionV2} from "../src/AgentQuoteExtructionV2.sol";

interface IPoolCardinality {
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

/// @notice Cuts the maker over from v1 to v2 in one broadcast: deploy board + extruction, dock the v1 Aqua strategy,
/// ship v2 with the inventory the wallet actually backs, register the agent and grow the pool's oracle history.
/// @dev Env: V1_STRATEGY_HASH. Optional: FEE_BPS (30), MAX_DEV_BPS (800), CARDINALITY (20), AGENT (maker).
/// Inventory per token = min(v1 Aqua balance, maker wallet balance): v2 never claims more than the wallet holds.
/// FORK_UNLOCKED=true runs from MAKER_ADDRESS unlocked on an anvil fork; otherwise DEPLOYER_PK signs.
contract LaunchV2 is Script {
    address private constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address private constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address private constant W0G = 0x23cd099eB438CcA50349EE2BC809196b1ae00861;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant POOL = 0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e;

    function run() external {
        bool unlocked = vm.envOr("FORK_UNLOCKED", false);
        uint256 key = unlocked ? 0 : vm.envUint("DEPLOYER_PK");
        address maker = unlocked ? vm.envAddress("MAKER_ADDRESS") : vm.addr(key);
        address agent = vm.envOr("AGENT", maker);
        bytes32 v1Hash = vm.envBytes32("V1_STRATEGY_HASH");
        uint16 feeBps = uint16(vm.envOr("FEE_BPS", uint256(30)));
        uint16 maxDevBps = uint16(vm.envOr("MAX_DEV_BPS", uint256(800)));
        uint16 cardinality = uint16(vm.envOr("CARDINALITY", uint256(20)));

        (uint248 v1W0g,) = IAqua(AQUA).rawBalances(maker, ROUTER, v1Hash, W0G);
        (uint248 v1Usdc,) = IAqua(AQUA).rawBalances(maker, ROUTER, v1Hash, USDC);
        uint256 w0gAmount = _min(v1W0g, IERC20(W0G).balanceOf(maker));
        uint256 usdcAmount = _min(v1Usdc, IERC20(USDC).balanceOf(maker));
        require(w0gAmount != 0 && usdcAmount != 0, "nothing to ship");

        if (unlocked) vm.startBroadcast(maker);
        else vm.startBroadcast(key);

        AgentQuoteBoardV2 board = new AgentQuoteBoardV2();
        AgentQuoteExtructionV2 ext = new AgentQuoteExtructionV2(board);

        address[] memory tokens = new address[](2);
        tokens[0] = W0G;
        tokens[1] = USDC;
        IAqua(AQUA).dock(ROUTER, v1Hash, tokens);

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(bytes1(0x20), bytes1(uint8(44)), address(ext), feeBps, POOL, maxDevBps);
        ISwapVM.Order memory order = MakerTraitsLib.build(args);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = w0gAmount;
        amounts[1] = usdcAmount;
        // Exact approvals: Aqua can pull at most what the v2 strategy ships.
        IERC20(W0G).approve(AQUA, w0gAmount);
        IERC20(USDC).approve(AQUA, usdcAmount);
        bytes32 strategyHash = IAqua(AQUA).ship(ROUTER, abi.encode(order), tokens, amounts);

        board.setAgent(agent);
        IPoolCardinality(POOL).increaseObservationCardinalityNext(cardinality);
        vm.stopBroadcast();

        require(strategyHash == ISwapVM(ROUTER).hash(order), "strategy hash mismatch");
        require(address(ext.board()) == address(board), "extruction/board mismatch");
        require(board.getAgent(maker) == agent && board.epochOf(maker) == 1, "agent not set");

        console2.log("BOARD_V2", address(board));
        console2.log("EXTRUCTION_V2", address(ext));
        console2.log(
            string.concat(
                'LIVE_ORDER_V2={"version":2,"strategyHash":"',
                vm.toString(strategyHash),
                '","board":"',
                vm.toString(address(board)),
                '","extruction":"',
                vm.toString(address(ext)),
                '","order":{"maker":"',
                vm.toString(maker),
                '","traits":"',
                vm.toString(bytes32(MakerTraits.unwrap(order.traits))),
                '","data":"',
                vm.toString(order.data),
                '"},"pair":{"w0g":"',
                vm.toString(W0G),
                '","usdc":"',
                vm.toString(USDC),
                '","feeBps":',
                vm.toString(feeBps),
                ',"maxDeviationBps":',
                vm.toString(maxDevBps),
                ',"pool":"',
                vm.toString(POOL),
                '"},"amounts":{"w0g":"',
                vm.toString(w0gAmount),
                '","usdc":"',
                vm.toString(usdcAmount),
                '"},"dockedV1":"',
                vm.toString(v1Hash),
                '"}'
            )
        );
    }

    function _min(uint256 a, uint256 b) private pure returns (uint256) {
        return a < b ? a : b;
    }
}
