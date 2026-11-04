// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {Controls} from "@1inch/swap-vm/src/instructions/Controls.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import {AgentQuoteBoard} from "../src/AgentQuoteBoard.sol";
import {AgentQuoteExtruction} from "../src/AgentQuoteExtruction.sol";

interface ISwapVMView {
    function asView() external view returns (ISwapVM);
}

contract AgentQuoteTest is Test {
    address private constant ROUTER = 0x111111338c5091E8440b67B168bAe16a668AC0De;
    address private constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    IERC20 private constant USDC = IERC20(0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48);
    IERC20 private constant WETH = IERC20(0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2);
    uint256 private constant MAKER_KEY = 0xA11CE;
    uint256 private constant AGENT_KEY = 0xA63E17;
    uint256 private constant TAKER_KEY = 0xB0B;
    uint256 private constant SECOND_MAKER_KEY = 0xB0B1;
    uint256 private constant SECOND_AGENT_KEY = 0xA63E18;
    uint16 private constant FEE_BPS = 30;
    uint256 private constant RATE_E18 = 333333333333333333333333334;

    address private maker;
    address private agent;
    address private taker;
    AgentQuoteBoard private board;
    AgentQuoteExtruction private extruction;
    ISwapVM private router;
    ISwapVM private routerView;

    function setUp() public {
        vm.createSelectFork(vm.envOr("ETH_RPC_URL", string("https://ethereum-rpc.publicnode.com")));
        maker = vm.addr(MAKER_KEY);
        agent = vm.addr(AGENT_KEY);
        taker = vm.addr(TAKER_KEY);
        board = new AgentQuoteBoard();
        extruction = new AgentQuoteExtruction(board);
        router = ISwapVM(ROUTER);
        routerView = ISwapVMView(ROUTER).asView();

        vm.prank(maker);
        board.setAgent(agent);
        _fundAndApproveMaker(maker);
        deal(address(USDC), taker, 10_000e6);
        vm.prank(taker);
        USDC.approve(ROUTER, type(uint256).max);
    }

    function test_exactInQuoteAndSwapMatchWithBalanceDeltas() public {
        ISwapVM.Order memory order = _ship(maker);
        _post(maker, AGENT_KEY, 1, uint64(block.timestamp + 1 days), RATE_E18);
        bytes memory traits = _takerTraits(true, taker);
        uint256 amountIn = 3_000e6;
        uint256 makerUsdcBefore = USDC.balanceOf(maker);
        uint256 makerWethBefore = WETH.balanceOf(maker);
        uint256 takerUsdcBefore = USDC.balanceOf(taker);
        uint256 takerWethBefore = WETH.balanceOf(taker);

        (uint256 quotedIn, uint256 quotedOut, bytes32 quotedHash) =
            routerView.quote(order, address(USDC), address(WETH), amountIn, traits);
        (uint256 swappedIn, uint256 swappedOut, bytes32 swappedHash) = _swap(order, amountIn, traits);

        assertEq(quotedHash, router.hash(order));
        assertEq(swappedHash, quotedHash);
        assertEq(quotedIn, amountIn);
        assertEq(quotedOut, 0.997e18);
        assertEq(swappedIn, quotedIn);
        assertEq(swappedOut, quotedOut);
        assertEq(USDC.balanceOf(maker) - makerUsdcBefore, 3_000e6);
        assertEq(makerWethBefore - WETH.balanceOf(maker), 0.997e18);
        assertEq(takerUsdcBefore - USDC.balanceOf(taker), 3_000e6);
        assertEq(WETH.balanceOf(taker) - takerWethBefore, 0.997e18);
    }

    function test_exactOutQuoteAndSwapMatchAndFeeAddsInput() public {
        ISwapVM.Order memory order = _ship(maker);
        _post(maker, AGENT_KEY, 1, uint64(block.timestamp + 1 days), RATE_E18);
        bytes memory traits = _takerTraits(false, taker);
        uint256 amountOut = 0.25e18;
        uint256 noFeeAmountIn = Math.mulDiv(amountOut, 1e18, RATE_E18, Math.Rounding.Ceil);
        uint256 makerUsdcBefore = USDC.balanceOf(maker);
        uint256 takerUsdcBefore = USDC.balanceOf(taker);

        (uint256 quotedIn, uint256 quotedOut,) =
            routerView.quote(order, address(USDC), address(WETH), amountOut, traits);
        (uint256 swappedIn, uint256 swappedOut,) = _swap(order, amountOut, traits);

        assertEq(quotedOut, amountOut);
        assertEq(swappedOut, amountOut);
        assertEq(swappedIn, quotedIn);
        assertGt(quotedIn, noFeeAmountIn);
        assertEq(USDC.balanceOf(maker) - makerUsdcBefore, quotedIn);
        assertEq(takerUsdcBefore - USDC.balanceOf(taker), quotedIn);
        assertEq(WETH.balanceOf(taker), amountOut);
    }

    function test_expiredQuoteFailsClosed() public {
        ISwapVM.Order memory order = _ship(maker);
        _post(maker, AGENT_KEY, 1, uint64(block.timestamp + 1), RATE_E18);
        vm.warp(block.timestamp + 2);

        vm.expectRevert(AgentQuoteExtruction.StaleQuote.selector);
        _swap(order, 3_000e6, _takerTraits(true, taker));
    }

    function test_aquaOpcode33IsNotExtruction() public {
        MakerTraitsLib.Args memory args;
        args.maker = maker;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(bytes1(0x21), bytes1(uint8(20)), address(USDC));
        ISwapVM.Order memory order = MakerTraitsLib.build(args);
        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory balances = new uint256[](2);
        balances[1] = 2e18;
        vm.prank(maker);
        IAqua(AQUA).ship(ROUTER, abi.encode(order), tokens, balances);
        deal(address(USDC), tx.origin, 0);

        vm.expectRevert(abi.encodeWithSelector(Controls.TxOriginTokenBalanceIsZero.selector, tx.origin, address(USDC)));
        _swap(order, 3_000e6, _takerTraits(true, taker));
    }

    function test_nonAgentSignatureIsRejected() public {
        AgentQuoteBoard.Quote memory q = _quote(maker, 1, uint64(block.timestamp + 1 days), RATE_E18);
        bytes memory sig = _sign(q, 0xBAD);

        vm.expectRevert(AgentQuoteBoard.InvalidAgentSignature.selector);
        board.post(q, sig);
    }

    function test_replayedAndOlderNoncesAreRejected() public {
        AgentQuoteBoard.Quote memory first = _quote(maker, 1, uint64(block.timestamp + 1 days), RATE_E18);
        board.post(first, _sign(first, AGENT_KEY));
        bytes memory replaySignature = _sign(first, AGENT_KEY);

        vm.expectRevert(abi.encodeWithSelector(AgentQuoteBoard.NonceNotIncreasing.selector, uint64(1), uint64(1)));
        board.post(first, replaySignature);

        AgentQuoteBoard.Quote memory older = _quote(maker, 0, uint64(block.timestamp + 1 days), RATE_E18);
        bytes memory olderSignature = _sign(older, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteBoard.NonceNotIncreasing.selector, uint64(0), uint64(1)));
        board.post(older, olderSignature);
    }

    function test_quoteForDifferentMakerCannotFillOrder() public {
        ISwapVM.Order memory order = _ship(maker);
        address secondMaker = vm.addr(SECOND_MAKER_KEY);
        address secondAgent = vm.addr(SECOND_AGENT_KEY);
        vm.prank(secondMaker);
        board.setAgent(secondAgent);
        _post(secondMaker, SECOND_AGENT_KEY, 1, uint64(block.timestamp + 1 days), RATE_E18);

        vm.expectRevert(AgentQuoteExtruction.StaleQuote.selector);
        _swap(order, 3_000e6, _takerTraits(true, taker));
    }

    function _ship(address makerAddress) private returns (ISwapVM.Order memory order) {
        MakerTraitsLib.Args memory args;
        args.maker = makerAddress;
        args.useAquaInsteadOfSignature = true;
        args.program = abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), address(extruction), bytes2(FEE_BPS));
        order = MakerTraitsLib.build(args);

        address[] memory tokens = new address[](2);
        tokens[0] = address(USDC);
        tokens[1] = address(WETH);
        uint256[] memory balances = new uint256[](2);
        balances[0] = 0;
        balances[1] = 2e18;

        vm.prank(makerAddress);
        bytes32 shippedHash = IAqua(AQUA).ship(ROUTER, abi.encode(order), tokens, balances);
        assertEq(shippedHash, router.hash(order));
    }

    function _fundAndApproveMaker(address makerAddress) private {
        deal(address(USDC), makerAddress, 0);
        deal(address(WETH), makerAddress, 2e18);
        vm.startPrank(makerAddress);
        USDC.approve(AQUA, type(uint256).max);
        WETH.approve(AQUA, type(uint256).max);
        vm.stopPrank();
    }

    function _post(address quoteMaker, uint256 signerKey, uint64 nonce, uint64 expiry, uint256 rate) private {
        AgentQuoteBoard.Quote memory q = _quote(quoteMaker, nonce, expiry, rate);
        board.post(q, _sign(q, signerKey));
    }

    function _quote(address quoteMaker, uint64 nonce, uint64 expiry, uint256 rate)
        private
        pure
        returns (AgentQuoteBoard.Quote memory q)
    {
        q = AgentQuoteBoard.Quote({
            maker: quoteMaker,
            tokenIn: address(USDC),
            tokenOut: address(WETH),
            rateE18: rate,
            expiry: expiry,
            nonce: nonce,
            inferenceId: keccak256(abi.encode("0g-compute-request", nonce, quoteMaker))
        });
    }

    function _sign(AgentQuoteBoard.Quote memory q, uint256 signerKey) private view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, board.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _takerTraits(bool isExactIn, address takerAddress) private pure returns (bytes memory) {
        TakerTraitsLib.Args memory args;
        args.taker = takerAddress;
        args.isExactIn = isExactIn;
        args.useTransferFromAndAquaPush = true;
        return TakerTraitsLib.build(args);
    }

    function _swap(ISwapVM.Order memory order, uint256 amount, bytes memory traits)
        private
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash)
    {
        vm.prank(taker);
        return router.swap(order, address(USDC), address(WETH), amount, traits);
    }
}
