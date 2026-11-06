// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {AgentQuoteBoardV2} from "../src/AgentQuoteBoardV2.sol";
import {AgentQuoteExtructionV2} from "../src/AgentQuoteExtructionV2.sol";
import {IUniswapV3PoolOracle, TwapPrice} from "../src/TwapPrice.sol";

interface ISwapVMView {
    function asView() external view returns (ISwapVM);
}

interface IPoolSlot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @notice v2 on a Base mainnet fork pinned at one block: the real AquaSwapVMRouter, Aqua, W0G, USDC and the
/// Uniswap v3 W0G/USDC pool whose TWAP bounds every fill.
contract BaseV2ForkTest is Test {
    uint256 internal constant FORK_BLOCK = 53_794_900;
    address private constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address private constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    IERC20 private constant W0G = IERC20(0x23cd099eB438CcA50349EE2BC809196b1ae00861);
    IERC20 private constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address private constant POOL = 0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e;
    uint16 private constant FEE_BPS = 30;
    uint16 private constant MAX_DEV_BPS = 800;
    uint256 private constant AGENT_KEY = 0xA63E17;
    uint256 private constant W0G_DEPTH = 1_357e15;
    uint256 private constant USDC_DEPTH = 300_000;

    address private maker;
    address private taker;
    AgentQuoteBoardV2 private board;
    AgentQuoteExtructionV2 private ext;
    ISwapVM private router;
    ISwapVM private routerView;
    ISwapVM.Order private order;
    uint256 private twap01;
    uint256 private twap10;
    uint64 private nonce;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")), FORK_BLOCK);
        // The pool's latest observation must be at least one TWAP window old for observe([600, 0]) at cardinality 1.
        vm.warp(block.timestamp + 700);
        maker = vm.addr(0xA11CE);
        taker = vm.addr(0xB0B);
        board = new AgentQuoteBoardV2();
        ext = new AgentQuoteExtructionV2(board);
        router = ISwapVM(ROUTER);
        routerView = ISwapVMView(ROUTER).asView();
        vm.prank(maker);
        board.setAgent(vm.addr(AGENT_KEY));

        deal(address(W0G), maker, W0G_DEPTH);
        deal(address(USDC), maker, USDC_DEPTH);
        deal(address(W0G), taker, 100e18);
        deal(address(USDC), taker, 100e6);
        vm.startPrank(maker);
        W0G.approve(AQUA, W0G_DEPTH);
        USDC.approve(AQUA, USDC_DEPTH);
        vm.stopPrank();
        vm.startPrank(taker);
        W0G.approve(ROUTER, type(uint256).max);
        USDC.approve(ROUTER, type(uint256).max);
        vm.stopPrank();

        order = _ship();
        int24 tick = TwapPrice.meanTick(IUniswapV3PoolOracle(POOL), 600);
        twap01 = TwapPrice.rateE18(tick, true);
        twap10 = TwapPrice.rateE18(tick, false);
        _postPair(twap01 * 9_970 / 10_000, twap10 * 9_970 / 10_000, 100e18, 50e6, 900);
    }

    function test_forkIsPinnedAndTwapTracksSpot() public view {
        assertEq(block.chainid, 8453);
        assertEq(block.number, FORK_BLOCK);
        (, int24 spot,,,,,) = IPoolSlot0(POOL).slot0();
        assertEq(TwapPrice.meanTick(IUniswapV3PoolOracle(POOL), 600), spot);
        // W0G priced between 0.01 and 10 USDC: the rate is in raw units, 1e18 W0G wei -> USDC 6-dp units.
        assertGt(twap01, 0.01e6);
        assertLt(twap01, 10e6);
    }

    function test_usdcToW0gFillsAtSignedRate() public {
        _assertQuoteEqualsSwap(address(USDC), address(W0G), 0.1e6);
    }

    function test_w0gToUsdcFillsAtSignedRate() public {
        _assertQuoteEqualsSwap(address(W0G), address(USDC), 0.5e18);
    }

    function test_twiceTwapQuoteRevertsThroughTheRouter() public {
        _postPair(twap01, twap10 * 2, 100e18, 50e6, 900);
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteExtructionV2.PriceOutOfBand.selector, twap10 * 2, twap10, MAX_DEV_BPS)
        );
        routerView.quote(order, address(USDC), address(W0G), 0.1e6, _traits(true));
        vm.prank(taker);
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteExtructionV2.PriceOutOfBand.selector, twap10 * 2, twap10, MAX_DEV_BPS)
        );
        router.swap(order, address(USDC), address(W0G), 0.1e6, _traits(true));
    }

    function test_fillAboveMaxAmountInRevertsThroughTheRouter() public {
        _postPair(twap01, twap10, 1e18, 0.05e6, 900);
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.AmountInTooLarge.selector, 0.05e6 + 1, 0.05e6));
        router.swap(order, address(USDC), address(W0G), 0.05e6 + 1, _traits(true));
    }

    function test_quoteBeyondStrategyDepthRevertsInTheView() public {
        vm.expectPartialRevert(AgentQuoteExtructionV2.InsufficientDepth.selector);
        routerView.quote(order, address(USDC), address(W0G), 10e6, _traits(true));
    }

    function test_expiryEdgeThroughTheRouter() public {
        uint64 expiry = uint64(block.timestamp + 900);
        vm.warp(expiry - 1);
        routerView.quote(order, address(USDC), address(W0G), 0.1e6, _traits(true));
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.QuoteExpired.selector, expiry));
        routerView.quote(order, address(USDC), address(W0G), 0.1e6, _traits(true));
    }

    function testFuzz_quoteEqualsSwap(uint256 amount, bool usdcIn) public {
        amount = usdcIn ? bound(amount, 1_000, 0.15e6) : bound(amount, 1e15, 1e18);
        _assertQuoteEqualsSwap(usdcIn ? address(USDC) : address(W0G), usdcIn ? address(W0G) : address(USDC), amount);
    }

    function _assertQuoteEqualsSwap(address tin, address tout, uint256 amount) private {
        uint256 rate = board.getQuote(maker, tin, tout).rateE18;
        (uint256 qIn, uint256 qOut, bytes32 qHash) = routerView.quote(order, tin, tout, amount, _traits(true));
        uint256 makerOutBefore = IERC20(tout).balanceOf(maker);
        uint256 takerOutBefore = IERC20(tout).balanceOf(taker);
        vm.prank(taker);
        (uint256 sIn, uint256 sOut, bytes32 sHash) = router.swap(order, tin, tout, amount, _traits(true));
        assertEq(sHash, qHash);
        assertEq(sIn, qIn);
        assertEq(sOut, qOut);
        assertEq(sOut, Math.mulDiv(Math.mulDiv(amount, rate, 1e18), 10_000 - FEE_BPS, 10_000));
        assertEq(makerOutBefore - IERC20(tout).balanceOf(maker), sOut);
        assertEq(IERC20(tout).balanceOf(taker) - takerOutBefore, sOut);
    }

    function _postPair(uint256 r01, uint256 r10, uint256 max0, uint256 max1, uint64 ttl) private {
        AgentQuoteBoardV2.Pair memory p = AgentQuoteBoardV2.Pair({
            maker: maker,
            token0: address(W0G),
            token1: address(USDC),
            rate01E18: r01,
            rate10E18: r10,
            maxIn0: max0,
            maxIn1: max1,
            expiry: uint64(block.timestamp) + ttl,
            epoch: board.epochOf(maker),
            nonce: ++nonce,
            inferenceId: keccak256(abi.encode("0g", nonce))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, board.pairDigest(p));
        board.postPair(p, abi.encodePacked(r, s, v));
    }

    function _ship() private returns (ISwapVM.Order memory shipped) {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(
            bytes1(0x20), bytes1(uint8(44)), address(ext), FEE_BPS, POOL, MAX_DEV_BPS
        );
        shipped = MakerTraitsLib.build(args);
        address[] memory tokens = new address[](2);
        tokens[0] = address(W0G);
        tokens[1] = address(USDC);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = W0G_DEPTH;
        amounts[1] = USDC_DEPTH;
        vm.prank(maker);
        assertEq(IAqua(AQUA).ship(ROUTER, abi.encode(shipped), tokens, amounts), router.hash(shipped));
    }

    function _traits(bool exactIn) private view returns (bytes memory) {
        TakerTraitsLib.Args memory a;
        a.taker = taker;
        a.isExactIn = exactIn;
        a.useTransferFromAndAquaPush = true;
        return TakerTraitsLib.build(a);
    }
}
