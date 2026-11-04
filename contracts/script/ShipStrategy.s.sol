// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {AgentQuoteExtruction} from "../src/AgentQuoteExtruction.sol";

/// @notice Ships the two-sided W0G/USDC Aqua strategy for a maker.
/// @dev Env: BOARD, EXTRUCTION, MAKER_PK, W0G_AMOUNT, USDC_AMOUNT, FEE_BPS.
/// Optional overrides: AQUA, ROUTER, W0G, USDC.
contract ShipStrategy is Script {
    address private constant DEFAULT_AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    address private constant DEFAULT_ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address private constant DEFAULT_W0G = 0x23cd099eB438CcA50349EE2BC809196b1ae00861;
    address private constant DEFAULT_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 private constant BPS = 10_000;

    function run() external {
        address board = vm.envAddress("BOARD");
        address extruction = vm.envAddress("EXTRUCTION");
        uint256 makerKey = vm.envUint("MAKER_PK");
        address maker = vm.addr(makerKey);
        uint256 w0gAmount = vm.envUint("W0G_AMOUNT");
        uint256 usdcAmount = vm.envUint("USDC_AMOUNT");
        uint256 feeBpsRaw = vm.envUint("FEE_BPS");

        require(board != address(0), "BOARD is zero");
        require(extruction != address(0), "EXTRUCTION is zero");
        require(w0gAmount != 0 && usdcAmount != 0, "amounts must be nonzero");
        require(feeBpsRaw < BPS, "FEE_BPS must be < 10000");
        require(address(AgentQuoteExtruction(extruction).board()) == board, "EXTRUCTION/BOARD mismatch");

        uint16 feeBps = uint16(feeBpsRaw);
        address aqua = vm.envOr("AQUA", DEFAULT_AQUA);
        address router = vm.envOr("ROUTER", DEFAULT_ROUTER);
        address w0g = vm.envOr("W0G", DEFAULT_W0G);
        address usdc = vm.envOr("USDC", DEFAULT_USDC);
        require(w0g != usdc, "token pair must differ");

        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), extruction, bytes2(feeBps));
        ISwapVM.Order memory order = MakerTraitsLib.build(args);
        bytes32 strategyHash = ISwapVM(router).hash(order);

        address[] memory tokens = new address[](2);
        tokens[0] = w0g;
        tokens[1] = usdc;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = w0gAmount;
        amounts[1] = usdcAmount;

        vm.startBroadcast(makerKey);
        IERC20(w0g).approve(aqua, type(uint256).max);
        IERC20(usdc).approve(aqua, type(uint256).max);
        bytes32 shippedHash = IAqua(aqua).ship(router, abi.encode(order), tokens, amounts);
        vm.stopBroadcast();

        require(shippedHash == strategyHash, "strategy hash mismatch");

        console2.log(
            string.concat(
                '{"strategyHash":"',
                vm.toString(strategyHash),
                '","order":{"maker":"',
                vm.toString(maker),
                '","traits":"',
                vm.toString(bytes32(MakerTraits.unwrap(order.traits))),
                '","data":"',
                vm.toString(order.data),
                '"},"pair":{"w0g":"',
                vm.toString(w0g),
                '","usdc":"',
                vm.toString(usdc),
                '","feeBps":',
                vm.toString(feeBps),
                '},"amounts":{"w0g":"',
                vm.toString(w0gAmount),
                '","usdc":"',
                vm.toString(usdcAmount),
                '"}}'
            )
        );
    }
}
