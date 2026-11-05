// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {AgentQuoteBoard} from "../src/AgentQuoteBoard.sol";
import {AgentQuoteExtruction} from "../src/AgentQuoteExtruction.sol";

interface ISwapVMView {
    function asView() external view returns (ISwapVM);
}

interface ISwapVMBase {
    function AQUA() external view returns (address);

    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        );
}

interface IUniswapV3Pool {
    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);

    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
}

/// @notice Base mainnet fork coverage for the real W0G/USDC product pair.
/// @dev The maker ships one two-sided Aqua strategy. The same order hash serves
/// both directions because Aqua stores a W0G balance and a USDC balance for it.
contract BaseW0GTest is Test {
    address private constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address private constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    IERC20 private constant W0G = IERC20(0x23cd099eB438CcA50349EE2BC809196b1ae00861);
    IERC20 private constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    IUniswapV3Pool private constant POOL = IUniswapV3Pool(0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e);

    uint256 private constant MAKER_KEY = 0xA11CE;
    uint256 private constant AGENT_KEY = 0xA63E17;
    uint256 private constant TAKER_KEY = 0xB0B;
    uint16 private constant FEE_BPS = 30;
    uint256 private constant W0G_LIQUIDITY = 50_000e18;
    uint256 private constant USDC_LIQUIDITY = 50_000e6;
    uint256 private constant MID_BAND_BPS = 500;
    uint256 private constant Q192 = 2 ** 192;

    address private maker;
    address private agent;
    address private taker;
    AgentQuoteBoard private board;
    AgentQuoteExtruction private extruction;
    ISwapVM private router;
    ISwapVM private routerView;
    ISwapVM.Order private order;

    function setUp() public {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")));

        maker = vm.addr(MAKER_KEY);
        agent = vm.addr(AGENT_KEY);
        taker = vm.addr(TAKER_KEY);

        board = new AgentQuoteBoard();
        extruction = new AgentQuoteExtruction(board);
        router = ISwapVM(ROUTER);
        routerView = ISwapVMView(ROUTER).asView();

        vm.prank(maker);
        board.setAgent(agent);

        deal(address(W0G), maker, W0G_LIQUIDITY);
        deal(address(USDC), maker, USDC_LIQUIDITY);
        deal(address(W0G), taker, 10_000e18);
        deal(address(USDC), taker, 10_000e6);

        vm.startPrank(maker);
        W0G.approve(AQUA, type(uint256).max);
        USDC.approve(AQUA, type(uint256).max);
        vm.stopPrank();

        vm.startPrank(taker);
        W0G.approve(ROUTER, type(uint256).max);
        USDC.approve(ROUTER, type(uint256).max);
        vm.stopPrank();

        order = _ship();
    }

    function test_baseForkWiringAndMidRate() public {
        assertEq(block.chainid, 8453);
        assertGt(ROUTER.code.length, 0);
        assertGt(AQUA.code.length, 0);
        assertGt(address(W0G).code.length, 0);
        assertGt(address(USDC).code.length, 0);

        assertEq(IERC20Metadata(address(W0G)).decimals(), 18);
        assertEq(IERC20Metadata(address(W0G)).symbol(), "W0G");
        assertEq(IERC20Metadata(address(USDC)).decimals(), 6);

        assertEq(POOL.token0(), address(W0G));
        assertEq(POOL.token1(), address(USDC));
        assertEq(uint256(POOL.fee()), 3000);
        assertEq(ISwapVMBase(ROUTER).AQUA(), AQUA);
        (,,, uint256 chainId,,,) = ISwapVMBase(ROUTER).eip712Domain();
        assertEq(chainId, 8453);

        uint256 usdcToW0g = _midRate(address(USDC), address(W0G));
        uint256 w0gToUsdc = _midRate(address(W0G), address(USDC));
        assertGt(usdcToW0g, 0);
        assertGt(w0gToUsdc, 0);
        // Each rate is floor-truncated to an integer, so the round trip can lose up to 1/rate of each leg.
        uint256 maxRel = Math.ceilDiv(1e18, w0gToUsdc) + Math.ceilDiv(1e18, usdcToW0g);
        assertApproxEqRel(Math.mulDiv(usdcToW0g, w0gToUsdc, 1e18), 1e18, maxRel);
    }

    function test_usdcToW0GFillMatchesQuoteMinusFee() public {
        _postBothMid();

        uint256 amountIn = 1_000e6;
        AgentQuoteBoard.Quote memory q = board.getQuote(maker, address(USDC), address(W0G));
        uint256 expectedOut = _netExactIn(amountIn, q.rateE18, FEE_BPS);
        bytes memory traits = _takerTraits(true, taker);

        (uint256 quotedIn, uint256 quotedOut,) = routerView.quote(order, address(USDC), address(W0G), amountIn, traits);
        assertEq(quotedIn, amountIn);
        assertEq(quotedOut, expectedOut);

        uint256 makerUsdcBefore = USDC.balanceOf(maker);
        uint256 makerW0gBefore = W0G.balanceOf(maker);
        uint256 takerUsdcBefore = USDC.balanceOf(taker);
        uint256 takerW0gBefore = W0G.balanceOf(taker);

        (uint256 swappedIn, uint256 swappedOut,) = _swap(address(USDC), address(W0G), amountIn, traits);

        assertEq(swappedIn, quotedIn);
        assertEq(swappedOut, quotedOut);
        assertEq(USDC.balanceOf(maker) - makerUsdcBefore, amountIn);
        assertEq(makerW0gBefore - W0G.balanceOf(maker), expectedOut);
        assertEq(takerUsdcBefore - USDC.balanceOf(taker), amountIn);
        assertEq(W0G.balanceOf(taker) - takerW0gBefore, expectedOut);
    }

    function test_w0gToUsdcFillMatchesQuoteMinusFee() public {
        _postBothMid();

        uint256 amountIn = 1_000e18;
        AgentQuoteBoard.Quote memory q = board.getQuote(maker, address(W0G), address(USDC));
        uint256 expectedOut = _netExactIn(amountIn, q.rateE18, FEE_BPS);
        bytes memory traits = _takerTraits(true, taker);

        (uint256 quotedIn, uint256 quotedOut,) = routerView.quote(order, address(W0G), address(USDC), amountIn, traits);
        assertEq(quotedIn, amountIn);
        assertEq(quotedOut, expectedOut);

        uint256 makerW0gBefore = W0G.balanceOf(maker);
        uint256 makerUsdcBefore = USDC.balanceOf(maker);
        uint256 takerW0gBefore = W0G.balanceOf(taker);
        uint256 takerUsdcBefore = USDC.balanceOf(taker);

        (uint256 swappedIn, uint256 swappedOut,) = _swap(address(W0G), address(USDC), amountIn, traits);

        assertEq(swappedIn, quotedIn);
        assertEq(swappedOut, quotedOut);
        assertEq(W0G.balanceOf(maker) - makerW0gBefore, amountIn);
        assertEq(makerUsdcBefore - USDC.balanceOf(maker), expectedOut);
        assertEq(takerW0gBefore - W0G.balanceOf(taker), amountIn);
        assertEq(USDC.balanceOf(taker) - takerUsdcBefore, expectedOut);
    }

    function test_staleQuoteReverts() public {
        uint64 expiry = uint64(block.timestamp + 1);
        _post(maker, AGENT_KEY, 1, expiry, address(USDC), address(W0G), _midRate(address(USDC), address(W0G)));

        vm.warp(block.timestamp + 2);

        vm.expectRevert(AgentQuoteExtruction.StaleQuote.selector);
        _swap(address(USDC), address(W0G), 1_000e6, _takerTraits(true, taker));
    }

    /// @notice Upkeep does not enforce a mid band. A quote at twice the Uniswap
    /// v3 mid, far outside any sane band, still fills at the agent's signed rate.
    /// Pricing trust therefore sits with the agent signer, not with the board.
    function test_quoteFarOutsideMidBandStillFillsAtQuotedRate() public {
        uint256 mid = _midRate(address(USDC), address(W0G));
        uint256 quotedRate = mid * 2;
        uint256 deviationBps = Math.mulDiv(quotedRate - mid, 10_000, mid);
        assertGt(deviationBps, MID_BAND_BPS);

        _post(maker, AGENT_KEY, 1, uint64(block.timestamp + 1 hours), address(USDC), address(W0G), quotedRate);

        uint256 amountIn = 100e6;
        uint256 expectedOut = _netExactIn(amountIn, quotedRate, FEE_BPS);
        uint256 makerW0gBefore = W0G.balanceOf(maker);
        uint256 takerW0gBefore = W0G.balanceOf(taker);

        (uint256 swappedIn, uint256 swappedOut,) =
            _swap(address(USDC), address(W0G), amountIn, _takerTraits(true, taker));

        assertEq(swappedIn, amountIn);
        assertEq(swappedOut, expectedOut);
        assertEq(makerW0gBefore - W0G.balanceOf(maker), expectedOut);
        assertEq(W0G.balanceOf(taker) - takerW0gBefore, expectedOut);
        assertEq(board.getQuote(maker, address(USDC), address(W0G)).rateE18, quotedRate);

        uint256 midPricedOut = _netExactIn(amountIn, mid, FEE_BPS);
        assertGt(expectedOut, midPricedOut * 19 / 10);
    }

    function _postBothMid() private {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        _post(maker, AGENT_KEY, 1, expiry, address(USDC), address(W0G), _midRate(address(USDC), address(W0G)));
        _post(maker, AGENT_KEY, 2, expiry, address(W0G), address(USDC), _midRate(address(W0G), address(USDC)));
    }

    function _ship() private returns (ISwapVM.Order memory shipped) {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), address(extruction), bytes2(FEE_BPS));
        shipped = MakerTraitsLib.build(args);

        address[] memory tokens = new address[](2);
        tokens[0] = address(W0G);
        tokens[1] = address(USDC);
        uint256[] memory balances = new uint256[](2);
        balances[0] = W0G_LIQUIDITY;
        balances[1] = USDC_LIQUIDITY;

        vm.prank(maker);
        bytes32 shippedHash = IAqua(AQUA).ship(ROUTER, abi.encode(shipped), tokens, balances);
        assertEq(shippedHash, router.hash(shipped));
    }

    function _post(
        address quoteMaker,
        uint256 signerKey,
        uint64 nonce,
        uint64 expiry,
        address tokenIn,
        address tokenOut,
        uint256 rate
    ) private {
        AgentQuoteBoard.Quote memory q = _quote(quoteMaker, nonce, expiry, tokenIn, tokenOut, rate);
        board.post(q, _sign(q, signerKey));
    }

    function _quote(address quoteMaker, uint64 nonce, uint64 expiry, address tokenIn, address tokenOut, uint256 rate)
        private
        pure
        returns (AgentQuoteBoard.Quote memory q)
    {
        q = AgentQuoteBoard.Quote({
            maker: quoteMaker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            rateE18: rate,
            expiry: expiry,
            nonce: nonce,
            inferenceId: keccak256(abi.encode("0g-compute-request", nonce, quoteMaker, tokenIn, tokenOut))
        });
    }

    function _sign(AgentQuoteBoard.Quote memory q, uint256 signerKey) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, board.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _netExactIn(uint256 amountIn, uint256 rateE18, uint16 feeBps) private pure returns (uint256) {
        uint256 grossOut = Math.mulDiv(amountIn, rateE18, 1e18);
        return Math.mulDiv(grossOut, 10_000 - feeBps, 10_000);
    }

    function _midRate(address tokenIn, address tokenOut) private view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = POOL.slot0();
        require(sqrtPriceX96 != 0, "zero sqrt price");

        uint256 sqrtSq = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        address token0 = POOL.token0();
        address token1 = POOL.token1();
        if (tokenIn == token0 && tokenOut == token1) {
            return Math.mulDiv(sqrtSq, 1e18, Q192);
        }
        if (tokenIn == token1 && tokenOut == token0) {
            return Math.mulDiv(Q192, 1e18, sqrtSq);
        }
        revert("invalid pair");
    }

    function _takerTraits(bool isExactIn, address takerAddress) private pure returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = takerAddress;
        args.isExactIn = isExactIn;
        args.useTransferFromAndAquaPush = true;
        return TakerTraitsLib.build(args);
    }

    function _swap(address tokenIn, address tokenOut, uint256 amount, bytes memory traits)
        private
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        vm.prank(taker);
        return router.swap(order, tokenIn, tokenOut, amount, traits);
    }
}
