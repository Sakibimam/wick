// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {AquaAggregatorHook} from "../src/AquaAggregatorHook.sol";
import {IAquaSwapVMRouter} from "../src/interfaces/IAquaSwapVMRouter.sol";

interface IUniswapV3PoolSlot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @notice Deploys AquaAggregatorHook through the CREATE2 deployer, points it at the Wick order and
/// initializes the W0G/USDC v4 pool. The broadcaster becomes the hook owner.
/// @dev Env: SALT (from script/mine.sh, mined for the same broadcaster), ORDER_JSON (default
/// ../.progress/live-order.json, shape {"order":{"maker","traits","data"}}). Optional: POOL_FEE,
/// TICK_SPACING, SQRT_PRICE_X96 (default: the Uniswap v3 W0G/USDC 0.3% pool's current price).
contract Deploy is Script {
    using stdJson for string;
    using PoolIdLibrary for PoolKey;

    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    IPoolManager constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IAquaSwapVMRouter constant ROUTER = IAquaSwapVMRouter(0x111111338c5091E8440b67B168bAe16a668AC0De);
    address constant W0G = 0x23cd099eB438CcA50349EE2BC809196b1ae00861;
    address constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    IUniswapV3PoolSlot0 constant V3_W0G_USDC = IUniswapV3PoolSlot0(0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e);
    /// @dev Aggregator hook ID byte: "1" for 1inch, "A" for Aqua.
    uint8 constant ID = 0x1A;
    uint160 constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    function run() external returns (AquaAggregatorHook hook, PoolId poolId) {
        require(block.chainid == 8453, "Base only");
        address owner = msg.sender;
        bytes32 salt = vm.envBytes32("SALT");

        string memory json = vm.readFile(vm.envOr("ORDER_JSON", string("../.progress/live-order.json")));
        IAquaSwapVMRouter.Order memory o = IAquaSwapVMRouter.Order({
            maker: json.readAddress(".order.maker"),
            traits: uint256(json.readBytes32(".order.traits")),
            data: json.readBytes(".order.data")
        });

        bytes memory initCode =
            abi.encodePacked(type(AquaAggregatorHook).creationCode, abi.encode(address(PM), address(ROUTER), owner));
        address predicted = vm.computeCreate2Address(salt, keccak256(initCode), CREATE2_DEPLOYER);
        require(uint160(predicted) & Hooks.ALL_HOOK_MASK == FLAGS, "salt: wrong hook flags");
        require(uint8(uint160(predicted) >> 152) == ID, "salt: wrong ID byte");

        uint160 sqrtPriceX96 = uint160(vm.envOr("SQRT_PRICE_X96", uint256(0)));
        if (sqrtPriceX96 == 0) (sqrtPriceX96,,,,,,) = V3_W0G_USDC.slot0();

        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(W0G),
            currency1: Currency.wrap(USDC),
            fee: uint24(vm.envOr("POOL_FEE", uint256(0))),
            tickSpacing: int24(int256(vm.envOr("TICK_SPACING", uint256(1)))),
            hooks: IHooks(predicted)
        });

        vm.startBroadcast(owner);
        hook = new AquaAggregatorHook{salt: salt}(PM, ROUTER, owner);
        hook.setOrder(o);
        PM.initialize(key, sqrtPriceX96);
        vm.stopBroadcast();

        require(address(hook) == predicted, "deployed address mismatch");
        poolId = key.toId();
        console2.log("hook", address(hook));
        console2.log("owner", owner);
        console2.log("orderHash");
        console2.logBytes32(hook.orderHash());
        console2.log("poolId");
        console2.logBytes32(PoolId.unwrap(poolId));
        try hook.quote(false, -1e5, poolId) returns (uint256 out) {
            console2.log("quote 0.1 USDC -> W0G wei", out);
        } catch (bytes memory err) {
            console2.log("quote 0.1 USDC -> W0G reverted:");
            console2.logBytes(err);
        }
    }
}
