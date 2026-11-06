// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IAquaSwapVMRouter} from "../src/interfaces/IAquaSwapVMRouter.sol";
import {WickGate} from "../src/WickGate.sol";
import {AquaHookBase, IAquaShip} from "./Base.sol";

/// @notice An ungated Aqua strategy on mainnet is open to any taker calling AquaSwapVMRouter
/// directly. Opcode 0x0e (_onlyTakerTokenBalanceNonZero on the deployed router) in front of the
/// extruction keeps the strategy reachable only by WickGate holders: the v4 hook and the agent.
contract TakerGateForkTest is AquaHookBase {
    bytes internal constant EXACT_IN = hex"00000000000000000000000000000000000000000041";
    bytes4 internal constant TAKER_TOKEN_BALANCE_IS_ZERO =
        bytes4(keccak256("TakerTokenBalanceIsZero(address,address)"));

    WickGate internal gate;
    address internal agentTaker = makeAddr("agentTaker");

    function setUp() public override {
        super.setUp();
        address[] memory holders = new address[](2);
        holders[0] = address(hook);
        holders[1] = agentTaker;
        gate = new WickGate(holders);
        order = _shipGated();
        hook.setOrder(order);
        _postBothMid();
        deal(address(USDC), agentTaker, 1_000e6);
        vm.prank(agentTaker);
        USDC.approve(address(ROUTER), type(uint256).max);
        vm.prank(alice);
        USDC.approve(address(ROUTER), type(uint256).max);
    }

    function _shipGated() internal returns (IAquaSwapVMRouter.Order memory o) {
        bytes memory ext = abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), EXTRUCTION, FEE_BPS);
        bytes memory program = abi.encodePacked(bytes1(0x0e), bytes1(uint8(20)), address(gate), ext);
        o = IAquaSwapVMRouter.Order({maker: maker, traits: MAKER_TRAITS_AQUA, data: program});
        address[] memory tokens = new address[](2);
        tokens[0] = address(W0G);
        tokens[1] = address(USDC);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAKER_W0G;
        amounts[1] = MAKER_USDC;
        bytes32 expected = ROUTER.hash(o);
        vm.prank(maker);
        bytes32 shipped = IAquaShip(AQUA).ship(address(ROUTER), abi.encode(o), tokens, amounts);
        require(shipped == expected, "hash");
    }

    function test_gate_wiring() public view {
        assertEq(gate.balanceOf(address(hook)), 1);
        assertEq(gate.balanceOf(alice), 0);
        assertEq(gate.totalSupply(), 2);
        assertEq(hook.orderHash(), ROUTER.hash(order));
    }

    /// A Uniswap swapper reaches the gated strategy: the hook is the SwapVM taker and holds WickGate.
    function test_gate_uniswapSwapThroughHook_fills() public {
        uint256 amountIn = 10e6;
        uint256 expectedOut = _netOut(amountIn, BOARD.getQuote(maker, address(USDC), address(W0G)).rateE18);
        uint256 before = W0G.balanceOf(alice);
        _exactIn(false, amountIn, expectedOut, false);
        assertEq(W0G.balanceOf(alice) - before, expectedOut, "alice W0G out");
    }

    function test_gate_holderDirectSwap_fills() public {
        vm.prank(agentTaker);
        (, uint256 out,) = ROUTER.swap(order, address(USDC), address(W0G), 1e6, EXACT_IN);
        assertGt(out, 0);
    }

    /// Must fail: anyone else calling the router directly is refused before the extruction runs.
    function test_gate_strangerDirectSwap_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TAKER_TOKEN_BALANCE_IS_ZERO, alice, address(gate)));
        ROUTER.swap(order, address(USDC), address(W0G), 1e6, EXACT_IN);
    }

    function test_gate_strangerQuote_reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TAKER_TOKEN_BALANCE_IS_ZERO, alice, address(gate)));
        ROUTER.quote(order, address(USDC), address(W0G), 1e6, EXACT_IN);
    }

    /// Control: the same stranger fills the ungated strategy setUp shipped (AquaHookBase), so the
    /// revert above is the gate alone.
    function test_control_ungatedStrangerDirectSwap_fills() public {
        IAquaSwapVMRouter.Order memory open = IAquaSwapVMRouter.Order({
            maker: maker,
            traits: MAKER_TRAITS_AQUA,
            data: abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), EXTRUCTION, FEE_BPS)
        });
        vm.prank(alice);
        (, uint256 out,) = ROUTER.swap(open, address(USDC), address(W0G), 1e6, EXACT_IN);
        assertGt(out, 0);
    }
}
