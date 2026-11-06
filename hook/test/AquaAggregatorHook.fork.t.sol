// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {CustomRevert} from "@uniswap/v4-core/src/libraries/CustomRevert.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Currency, CurrencyLibrary} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams, ModifyLiquidityParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {ImmutableState} from "@uniswap/v4-periphery/src/base/ImmutableState.sol";
import {IAggregatorHook} from "@v4-hooks/aggregator-hooks/interfaces/IAggregatorHook.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {AquaAggregatorHook} from "../src/AquaAggregatorHook.sol";
import {IAquaSwapVMRouter} from "../src/interfaces/IAquaSwapVMRouter.sol";
import {AquaHookBase} from "./Base.sol";

contract AquaAggregatorHookForkTest is AquaHookBase {
    using PoolIdLibrary for PoolKey;

    error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived);

    bytes4 internal constant STALE_QUOTE = bytes4(keccak256("StaleQuote()"));

    struct Balances {
        uint256 aliceW0g;
        uint256 aliceUsdc;
        uint256 makerW0g;
        uint256 makerUsdc;
        uint256 pmW0g;
        uint256 pmUsdc;
    }

    function _snap() internal view returns (Balances memory b) {
        b = Balances(
            W0G.balanceOf(alice),
            USDC.balanceOf(alice),
            W0G.balanceOf(maker),
            USDC.balanceOf(maker),
            W0G.balanceOf(address(PM)),
            USDC.balanceOf(address(PM))
        );
    }

    function _assertHookFlat() internal view {
        assertEq(W0G.balanceOf(address(hook)), 0, "hook holds W0G");
        assertEq(USDC.balanceOf(address(hook)), 0, "hook holds USDC");
    }

    // ---------------------------------------------------------------- wiring

    function test_fork_wiring() public view {
        assertEq(block.chainid, 8453);
        assertEq(block.number, FORK_BLOCK);
        assertGt(address(PM).code.length, 0);
        assertGt(address(UR).code.length, 0);
        assertEq(address(hook.aqua()), AQUA);
        assertEq(uint160(address(hook)) & Hooks.ALL_HOOK_MASK, FLAGS);
        assertEq(hook.orderHash(), ROUTER.hash(order));
        IAquaSwapVMRouter.Order memory o = hook.order();
        assertEq(o.maker, maker);
        assertEq(o.data, order.data);
        (address t0, address t1) = hook.poolTokens(poolId);
        assertEq(t0, address(W0G));
        assertEq(t1, address(USDC));
        (uint256 d0, uint256 d1) = hook.pseudoTotalValueLocked(poolId);
        assertEq(d0, MAKER_W0G);
        assertEq(d1, MAKER_USDC);
        assertEq(W0G.balanceOf(address(PM)), 0, "precondition: PoolManager holds no W0G");
    }

    // ---------------------------------------------------------------- fills

    function test_fork_exactIn_usdcToW0g_fillsAtSignedRateMinusFee() public {
        _postBothMid();
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = _netOut(amountIn, _rate(address(USDC), address(W0G)));
        assertGt(expectedOut, 0);
        assertEq(hook.quote(false, -int256(amountIn), poolId), expectedOut, "hook quote");

        Balances memory b = _snap();
        _exactIn(false, amountIn, expectedOut, false);
        Balances memory a = _snap();

        assertEq(b.aliceUsdc - a.aliceUsdc, amountIn, "alice USDC in");
        assertEq(a.aliceW0g - b.aliceW0g, expectedOut, "alice W0G out");
        assertEq(a.makerUsdc - b.makerUsdc, amountIn, "maker USDC in");
        assertEq(b.makerW0g - a.makerW0g, expectedOut, "maker W0G out");
        assertEq(a.pmUsdc, b.pmUsdc, "PoolManager USDC flat");
        assertEq(a.pmW0g, b.pmW0g, "PoolManager W0G flat");
        _assertHookFlat();
    }

    function test_fork_exactIn_w0gToUsdc_settleFirst_fillsAtSignedRateMinusFee() public {
        _postBothMid();
        uint256 amountIn = 1_000e18;
        uint256 expectedOut = _netOut(amountIn, _rate(address(W0G), address(USDC)));
        assertGt(expectedOut, 0);
        assertEq(hook.quote(true, -int256(amountIn), poolId), expectedOut, "hook quote");

        Balances memory b = _snap();
        _exactIn(true, amountIn, expectedOut, true);
        Balances memory a = _snap();

        assertEq(b.aliceW0g - a.aliceW0g, amountIn, "alice W0G in");
        assertEq(a.aliceUsdc - b.aliceUsdc, expectedOut, "alice USDC out");
        assertEq(a.makerW0g - b.makerW0g, amountIn, "maker W0G in");
        assertEq(b.makerUsdc - a.makerUsdc, expectedOut, "maker USDC out");
        assertEq(a.pmUsdc, b.pmUsdc, "PoolManager USDC flat");
        assertEq(a.pmW0g, b.pmW0g, "PoolManager W0G flat");
        _assertHookFlat();
    }

    function test_fork_exactOut_usdcToW0g() public {
        _postBothMid();
        uint256 amountOut = 500e18;
        uint256 expectedIn = _grossIn(amountOut, _rate(address(USDC), address(W0G)));
        assertEq(hook.quote(false, int256(amountOut), poolId), expectedIn, "hook quote");

        Balances memory b = _snap();
        _exactOut(false, amountOut, expectedIn, false);
        Balances memory a = _snap();

        assertEq(b.aliceUsdc - a.aliceUsdc, expectedIn, "alice USDC in");
        assertEq(a.aliceW0g - b.aliceW0g, amountOut, "alice W0G out");
        assertEq(a.makerUsdc - b.makerUsdc, expectedIn, "maker USDC in");
        assertEq(b.makerW0g - a.makerW0g, amountOut, "maker W0G out");
        _assertHookFlat();
    }

    function test_fork_exactOut_w0gToUsdc_settleFirst() public {
        _postBothMid();
        uint256 amountOut = 100e6;
        uint256 expectedIn = _grossIn(amountOut, _rate(address(W0G), address(USDC)));
        assertEq(hook.quote(true, int256(amountOut), poolId), expectedIn, "hook quote");

        Balances memory b = _snap();
        _exactOut(true, amountOut, expectedIn, true);
        Balances memory a = _snap();

        assertEq(b.aliceW0g - a.aliceW0g, expectedIn, "alice W0G in");
        assertEq(a.aliceUsdc - b.aliceUsdc, amountOut, "alice USDC out");
        assertEq(a.makerW0g - b.makerW0g, expectedIn, "maker W0G in");
        assertEq(b.makerUsdc - a.makerUsdc, amountOut, "maker USDC out");
        _assertHookFlat();
    }

    /// @notice The shipped Wick order and the agent quote that was live on chain at FORK_BLOCK:
    /// no prank, no re-signing. A Uniswap swap reaches the real Wick strategy.
    function test_fork_liveWickOrder_fillsFromLiveAgentQuote() public {
        IAquaSwapVMRouter.Order memory live = IAquaSwapVMRouter.Order({
            maker: 0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953,
            traits: MAKER_TRAITS_AQUA,
            data: hex"201659d954dd4fde7f99634f7b2d29e6b4ffebe7b7e0001e"
        });
        hook.setOrder(live);
        assertEq(hook.orderHash(), 0xf2513850c1981305143c9655af1305ff35ed5ef52f0bd5d8588f3a8f02ac7f5e);
        assertTrue(BOARD.isQuoteCurrent(live.maker, address(USDC), address(W0G)), "live quote current at fork block");

        PoolKey memory liveKey = key;
        liveKey.tickSpacing = 10;
        PM.initialize(liveKey, 79228162514264337593543950336);
        key = liveKey;
        poolId = liveKey.toId();

        uint256 amountIn = 100_000; // 0.1 USDC
        uint256 expectedOut = _netOut(amountIn, BOARD.getQuote(live.maker, address(USDC), address(W0G)).rateE18);
        uint256 makerW0g = W0G.balanceOf(live.maker);
        uint256 makerUsdc = USDC.balanceOf(live.maker);
        uint256 aliceW0g = W0G.balanceOf(alice);

        _exactIn(false, amountIn, expectedOut, false);

        assertEq(W0G.balanceOf(alice) - aliceW0g, expectedOut, "alice W0G out");
        assertEq(makerW0g - W0G.balanceOf(live.maker), expectedOut, "live maker W0G out");
        assertEq(USDC.balanceOf(live.maker) - makerUsdc, amountIn, "live maker USDC in");
        _assertHookFlat();
    }

    // ---------------------------------------------------------------- must fail

    function test_revert_expiredQuote_failsClosed() public {
        _post(address(USDC), address(W0G), _mid(address(USDC)), uint64(block.timestamp + 60));
        _exactIn(false, 10e6, 0, false); // fresh: fills
        vm.warp(block.timestamp + 61);

        vm.expectRevert(STALE_QUOTE);
        hook.quote(false, -int256(10e6), poolId);

        Balances memory b = _snap();
        (bool ok, bytes memory ret) = _tryExactIn(false, 10e6, 0, false);
        assertFalse(ok, "stale swap must revert");
        assertTrue(_contains(ret, STALE_QUOTE), "StaleQuote surfaced");
        Balances memory a = _snap();
        assertEq(a.aliceUsdc, b.aliceUsdc);
        assertEq(a.makerW0g, b.makerW0g);
    }

    function test_revert_agentRotated_failsClosed() public {
        _postBothMid();
        vm.prank(maker);
        BOARD.setAgent(makeAddr("newAgent"));
        (bool ok, bytes memory ret) = _tryExactIn(false, 10e6, 0, false);
        assertFalse(ok);
        assertTrue(_contains(ret, STALE_QUOTE), "StaleQuote surfaced");
    }

    function test_revert_unquotedDirection() public {
        _post(address(USDC), address(W0G), _mid(address(USDC)), uint64(block.timestamp + 1 hours));
        (bool ok, bytes memory ret) = _tryExactIn(true, 10e18, 0, true);
        assertFalse(ok, "W0G->USDC has no signed quote");
        assertTrue(_contains(ret, STALE_QUOTE), "StaleQuote surfaced");
        _exactIn(false, 10e6, 0, false); // the quoted direction still fills
    }

    function test_revert_unsupportedToken_initialize() public {
        PoolKey memory bad = PoolKey({
            currency0: Currency.wrap(WETH),
            currency1: Currency.wrap(address(USDC)),
            fee: 0,
            tickSpacing: 1,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(hook),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(AquaAggregatorHook.TokensNotSupported.selector, WETH, address(USDC)),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        PM.initialize(bad, 79228162514264337593543950336);
    }

    function test_revert_initializeWithoutOrder() public {
        AquaAggregatorHook fresh = _deployHook(makeAddr("otherOwner"));
        PoolKey memory k = key;
        k.hooks = IHooks(address(fresh));
        vm.expectRevert(
            abi.encodeWithSelector(
                CustomRevert.WrappedError.selector,
                address(fresh),
                IHooks.beforeInitialize.selector,
                abi.encodeWithSelector(AquaAggregatorHook.OrderNotSet.selector),
                abi.encodeWithSelector(Hooks.HookCallFailed.selector)
            )
        );
        PM.initialize(k, 79228162514264337593543950336);
    }

    function test_revert_notPoolManager() public {
        SwapParams memory p = SwapParams({zeroForOne: false, amountSpecified: -1e6, sqrtPriceLimitX96: 0});
        vm.prank(alice);
        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.beforeSwap(alice, key, p, "");

        vm.expectRevert(ImmutableState.NotPoolManager.selector);
        hook.beforeInitialize(alice, key, 1 << 96);
    }

    function test_revert_addLiquidity() public {
        ModifyLiquidityParams memory p = ModifyLiquidityParams({tickLower: -60, tickUpper: 60, liquidityDelta: 1e18, salt: 0});
        vm.prank(address(PM));
        vm.expectRevert(IAggregatorHook.LiquidityNotAllowed.selector);
        hook.beforeAddLiquidity(alice, key, p, "");
    }

    function test_revert_setOrder_notOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        hook.setOrder(order);
    }

    function test_revert_minOutAboveSignedFill() public {
        _postBothMid();
        uint256 amountIn = 1_000e6;
        uint256 expectedOut = _netOut(amountIn, _rate(address(USDC), address(W0G)));
        (bool ok, bytes memory ret) = _tryExactIn(false, amountIn, expectedOut + 1, false);
        assertFalse(ok, "router min-out protects the swapper");
        assertEq(ret, abi.encodeWithSelector(V4TooLittleReceived.selector, expectedOut + 1, expectedOut));
    }

    function test_revert_quoteBeyondAquaDepth() public {
        _postBothMid();
        uint256 rate = _rate(address(USDC), address(W0G));
        uint256 amountIn = _grossIn(MAKER_W0G, rate) + 1e6;
        uint256 out = _netOut(amountIn, rate);
        vm.expectRevert(abi.encodeWithSelector(AquaAggregatorHook.ExceedsAquaBalance.selector, out, MAKER_W0G));
        hook.quote(false, -int256(amountIn), poolId);
        (bool ok,) = _tryExactIn(false, amountIn, 0, false);
        assertFalse(ok, "swap beyond Aqua depth reverts");
    }

    /// @notice The PoolManager on Base holds no W0G, so the hook cannot take W0G it has not been paid yet.
    /// The swap-then-settle action order reverts; settle-then-swap (test above) fills.
    function test_revert_w0gIn_swapBeforeSettle_whenPoolManagerHoldsNoW0G() public {
        _postBothMid();
        assertEq(W0G.balanceOf(address(PM)), 0);
        (bool ok, bytes memory ret) = _tryExactIn(true, 1_000e18, 0, false);
        assertFalse(ok);
        assertTrue(_contains(ret, CurrencyLibrary.ERC20TransferFailed.selector), "PoolManager W0G transfer failed");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_exactIn_usdcToW0g(uint256 amountIn) public {
        _postBothMid();
        uint256 rate = _rate(address(USDC), address(W0G));
        amountIn = bound(amountIn, 1, Math.mulDiv(MAKER_W0G, 1e18, rate));
        uint256 expectedOut = _netOut(amountIn, rate);
        vm.assume(expectedOut > 0);

        Balances memory b = _snap();
        _exactIn(false, amountIn, expectedOut, false);
        Balances memory a = _snap();
        assertEq(b.aliceUsdc - a.aliceUsdc, amountIn);
        assertEq(a.aliceW0g - b.aliceW0g, expectedOut);
        assertEq(b.makerW0g - a.makerW0g, expectedOut);
        assertEq(a.makerUsdc - b.makerUsdc, amountIn);
        _assertHookFlat();
    }

    function testFuzz_exactIn_w0gToUsdc(uint256 amountIn) public {
        _postBothMid();
        uint256 rate = _rate(address(W0G), address(USDC));
        amountIn = bound(amountIn, 1e12, Math.mulDiv(MAKER_USDC, 1e18, rate));
        uint256 expectedOut = _netOut(amountIn, rate);
        vm.assume(expectedOut > 0);

        Balances memory b = _snap();
        _exactIn(true, amountIn, expectedOut, true);
        Balances memory a = _snap();
        assertEq(b.aliceW0g - a.aliceW0g, amountIn);
        assertEq(a.aliceUsdc - b.aliceUsdc, expectedOut);
        assertEq(b.makerUsdc - a.makerUsdc, expectedOut);
        assertEq(a.makerW0g - b.makerW0g, amountIn);
        _assertHookFlat();
    }

    function testFuzz_exactOut_usdcToW0g(uint256 amountOut) public {
        _postBothMid();
        uint256 rate = _rate(address(USDC), address(W0G));
        amountOut = bound(amountOut, 1e12, MAKER_W0G);
        uint256 expectedIn = _grossIn(amountOut, rate);

        Balances memory b = _snap();
        _exactOut(false, amountOut, expectedIn, false);
        Balances memory a = _snap();
        assertEq(b.aliceUsdc - a.aliceUsdc, expectedIn);
        assertEq(a.aliceW0g - b.aliceW0g, amountOut);
        assertEq(b.makerW0g - a.makerW0g, amountOut);
        _assertHookFlat();
    }
}
