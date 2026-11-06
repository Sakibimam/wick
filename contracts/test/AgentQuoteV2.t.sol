// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SwapRegisters} from "@1inch/swap-vm/src/libs/VM.sol";
import {AgentQuoteBoardV2} from "../src/AgentQuoteBoardV2.sol";
import {AgentQuoteExtructionV2} from "../src/AgentQuoteExtructionV2.sol";
import {TwapPrice} from "../src/TwapPrice.sol";
import {V2Fixture, MockPool, Wallet1271} from "./V2Fixture.sol";

contract AgentQuoteV2Test is V2Fixture {
    uint256 private constant NEW_AGENT_KEY = 0xA63E18;

    function setUp() public {
        _setUpV2();
    }

    // ---------- nonce brick (finding 1) ----------

    function test_leakedKeyMaxNonceIsClearedByRotation() public {
        AgentQuoteBoardV2.Pair memory evil =
            _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), type(uint64).max);
        board.postPair(evil, _signPair(evil, AGENT_KEY));
        AgentQuoteBoardV2.Pair memory stuck = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        bytes memory stuckSig = _signPair(stuck, AGENT_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteBoardV2.NonceNotIncreasing.selector, uint64(1), type(uint64).max)
        );
        board.postPair(stuck, stuckSig);

        vm.prank(maker);
        board.setAgent(vm.addr(NEW_AGENT_KEY));
        assertEq(board.epochOf(maker), 2);
        assertEq(board.lastNonce(maker, 2), 0);
        assertFalse(board.isQuoteCurrent(maker, T0, T1));

        AgentQuoteBoardV2.Pair memory fresh = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        board.postPair(fresh, _signPair(fresh, NEW_AGENT_KEY));
        assertTrue(board.isQuoteCurrent(maker, T0, T1));
        assertEq(board.lastNonce(maker, 2), 1);
        assertEq(board.lastNonce(maker, 1), type(uint64).max);
    }

    function test_leakedKeyCannotPostAfterRotation() public {
        vm.prank(maker);
        board.setAgent(vm.addr(NEW_AGENT_KEY));
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 5);
        bytes memory sig = _signPair(p, AGENT_KEY);
        vm.expectRevert(AgentQuoteBoardV2.InvalidAgentSignature.selector);
        board.postPair(p, sig);
    }

    function test_oldEpochSignatureCannotReplayAfterReRegisteringSameAgent() public {
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 600), 7);
        bytes memory sig = _signPair(p, AGENT_KEY);
        board.postPair(p, sig);
        vm.prank(maker);
        board.setAgent(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteBoardV2.WrongEpoch.selector, uint64(1), uint64(2)));
        board.postPair(p, sig);
    }

    // ---------- postPair (finding 2) and events (finding 7) ----------

    function test_postPairStoresBothDirectionsAndEmitsNonceAndEpoch() public {
        uint64 expiry = uint64(block.timestamp + 900);
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 5e18, 7e6, expiry, 3);
        bytes memory sig = _signPair(p, AGENT_KEY);
        vm.expectEmit(true, true, true, true, address(board));
        emit AgentQuoteBoardV2.QuotePosted(maker, T0, T1, p.rate01E18, 5e18, expiry, 1, 3, p.inferenceId);
        vm.expectEmit(true, true, true, true, address(board));
        emit AgentQuoteBoardV2.QuotePosted(maker, T1, T0, p.rate10E18, 7e6, expiry, 1, 3, p.inferenceId);
        board.postPair(p, sig);

        AgentQuoteBoardV2.Posted memory a = board.getQuote(maker, T0, T1);
        AgentQuoteBoardV2.Posted memory b = board.getQuote(maker, T1, T0);
        assertEq(a.rateE18, p.rate01E18);
        assertEq(a.maxAmountIn, 5e18);
        assertEq(b.rateE18, p.rate10E18);
        assertEq(b.maxAmountIn, 7e6);
        assertEq(a.nonce, 3);
        assertEq(b.epoch, 1);
        assertEq(a.inferenceId, b.inferenceId);
        assertEq(board.lastNonce(maker, 1), 3);
    }

    function test_setAgentEmitsEpoch() public {
        vm.expectEmit(true, true, false, true, address(board));
        emit AgentQuoteBoardV2.AgentSet(maker, address(0xCAFE), 2);
        vm.prank(maker);
        board.setAgent(address(0xCAFE));
    }

    function test_singlePostWorksAndSharesTheNonceSpace() public {
        AgentQuoteBoardV2.Quote memory q = _quote(T1, T0, _mid10(), 1e6, uint64(block.timestamp + 60), 4);
        board.post(q, _signQuote(q, AGENT_KEY));
        assertEq(board.getQuote(maker, T1, T0).rateE18, _mid10());
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 4);
        bytes memory sig = _signPair(p, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteBoardV2.NonceNotIncreasing.selector, uint64(4), uint64(4)));
        board.postPair(p, sig);
    }

    function test_pairSignatureCannotBeUsedAsQuoteSignature() public {
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        bytes memory pairSig = _signPair(p, AGENT_KEY);
        AgentQuoteBoardV2.Quote memory q = _quote(T0, T1, _mid01(), 1, uint64(block.timestamp + 60), 1);
        vm.expectRevert(AgentQuoteBoardV2.InvalidAgentSignature.selector);
        board.post(q, pairSig);
    }

    // ---------- ERC-1271 agent (finding 7) ----------

    function test_erc1271AgentCanPost() public {
        Wallet1271 wallet = new Wallet1271(vm.addr(NEW_AGENT_KEY));
        vm.prank(maker);
        board.setAgent(address(wallet));
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, NEW_AGENT_KEY));
        assertTrue(board.isQuoteCurrent(maker, T1, T0));

        AgentQuoteBoardV2.Pair memory bad = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 2);
        bytes memory badSig = _signPair(bad, AGENT_KEY);
        vm.expectRevert(AgentQuoteBoardV2.InvalidAgentSignature.selector);
        board.postPair(bad, badSig);
    }

    function test_eip7702DelegatedEoaAgentStillSignsWithItsKey() public {
        address delegated = vm.addr(NEW_AGENT_KEY);
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(0xdead)));
        assertGt(delegated.code.length, 0);
        vm.prank(maker);
        board.setAgent(delegated);
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, NEW_AGENT_KEY));
        assertTrue(board.isQuoteCurrent(maker, T0, T1));
    }

    // ---------- MAX_TTL and expiry edges (findings 5, 6) ----------

    function test_postAcceptsExactlyMaxTtl() public {
        _postMidPair(900);
        assertEq(board.getQuote(maker, T0, T1).expiry, block.timestamp + 900);
    }

    function test_postRejectsOneSecondOverMaxTtl() public {
        uint64 expiry = uint64(block.timestamp) + 901;
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, expiry, 1);
        bytes memory sig = _signPair(p, AGENT_KEY);
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteBoardV2.TtlTooLong.selector, expiry, uint64(block.timestamp) + 900)
        );
        board.postPair(p, sig);
    }

    function test_postRejectsExpiryEqualToNow() public {
        AgentQuoteBoardV2.Quote memory q = _quote(T0, T1, _mid01(), 1, uint64(block.timestamp), 1);
        bytes memory sig = _signQuote(q, AGENT_KEY);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteBoardV2.QuoteExpired.selector, uint64(block.timestamp)));
        board.post(q, sig);
    }

    function test_postAcceptsExpiryOneSecondAhead() public {
        AgentQuoteBoardV2.Quote memory q = _quote(T0, T1, _mid01(), 1e18, uint64(block.timestamp + 1), 1);
        board.post(q, _signQuote(q, AGENT_KEY));
        SwapRegisters memory r = _fill(T0, T1, true, 1e18, type(uint256).max);
        assertGt(r.amountOut, 0);
    }

    function test_fillAtLastSecondBeforeExpirySucceeds() public {
        _postMidPair(60);
        vm.warp(block.timestamp + 59);
        assertGt(_fill(T0, T1, true, 1e18, type(uint256).max).amountOut, 0);
    }

    function test_fillAtExpirySecondReverts() public {
        _postMidPair(60);
        uint64 expiry = uint64(block.timestamp + 60);
        vm.warp(expiry);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.QuoteExpired.selector, expiry));
        _fill(T0, T1, true, 1e18, type(uint256).max);
    }

    // ---------- price band (finding 3) ----------

    function test_twiceTwapQuoteRevertsPriceOutOfBand() public {
        uint256 twice = _mid10() * 2;
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), twice, 1e30, 1e30, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, AGENT_KEY));
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteExtructionV2.PriceOutOfBand.selector, twice, _mid10(), MAX_DEV_BPS)
        );
        _fill(T1, T0, true, 1e6, type(uint256).max);
    }

    function test_bandEdgeInclusive() public {
        uint256 mid = _mid01();
        uint256 edge = mid + mid * MAX_DEV_BPS / 10_000;
        AgentQuoteBoardV2.Pair memory p = _pair(edge, _mid10(), 1e30, 1e30, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, AGENT_KEY));
        assertGt(_fill(T0, T1, true, 1e18, type(uint256).max).amountOut, 0);

        uint256 over = edge + mid / 1000;
        AgentQuoteBoardV2.Pair memory p2 = _pair(over, _mid10(), 1e30, 1e30, uint64(block.timestamp + 60), 2);
        board.postPair(p2, _signPair(p2, AGENT_KEY));
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.PriceOutOfBand.selector, over, mid, MAX_DEV_BPS));
        _fill(T0, T1, true, 1e18, type(uint256).max);
    }

    function test_bandFollowsTheTwapNotTheQuote() public {
        _postMidPair(60);
        pool.setMeanTick(TICK + 2000);
        vm.expectPartialRevert(AgentQuoteExtructionV2.PriceOutOfBand.selector);
        _fill(T0, T1, true, 1e18, type(uint256).max);
    }

    function test_poolForAnotherPairIsRejected() public {
        _postMidPair(60);
        MockPool other = new MockPool(T0, address(0x3000), TICK);
        bytes memory args = abi.encodePacked(FEE_BPS, address(other), MAX_DEV_BPS);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.PoolPairMismatch.selector, address(other)));
        _fillWith(args, T0, T1, true, 1e18, type(uint256).max);
    }

    // ---------- maxAmountIn and depth (finding 4, judge finding a) ----------

    function test_fillAboveMaxAmountInRevertsExactIn() public {
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 2e18, 1e6, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, AGENT_KEY));
        assertGt(_fill(T0, T1, true, 2e18, type(uint256).max).amountOut, 0);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.AmountInTooLarge.selector, 2e18 + 1, 2e18));
        _fill(T0, T1, true, 2e18 + 1, type(uint256).max);
    }

    function test_fillAboveMaxAmountInRevertsExactOut() public {
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 2e18, 1e6, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, AGENT_KEY));
        vm.expectPartialRevert(AgentQuoteExtructionV2.AmountInTooLarge.selector);
        _fill(T1, T0, false, 100e18, type(uint256).max);
    }

    function test_fillBeyondStrategyDepthReverts() public {
        _postMidPair(60);
        SwapRegisters memory ok = _fill(T1, T0, true, 1e6, type(uint256).max);
        vm.expectRevert(
            abi.encodeWithSelector(AgentQuoteExtructionV2.InsufficientDepth.selector, ok.amountOut, ok.amountOut - 1)
        );
        _fill(T1, T0, true, 1e6, ok.amountOut - 1);
    }

    // ---------- remaining custom errors ----------

    function test_boardInputErrors() public {
        uint64 e = uint64(block.timestamp + 60);
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, e, 1);
        p.maker = address(0);
        vm.expectRevert(AgentQuoteBoardV2.ZeroMaker.selector);
        board.postPair(p, "");
        p = _pair(_mid01(), _mid10(), 1, 1, e, 1);
        p.token0 = address(0);
        vm.expectRevert(AgentQuoteBoardV2.ZeroToken.selector);
        board.postPair(p, "");
        p = _pair(_mid01(), _mid10(), 1, 1, e, 1);
        (p.token0, p.token1) = (T1, T0);
        vm.expectRevert(AgentQuoteBoardV2.InvalidPair.selector);
        board.postPair(p, "");
        p = _pair(0, _mid10(), 1, 1, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.InvalidRate.selector);
        board.postPair(p, "");
        p = _pair(_mid01(), _mid10(), 1, 0, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.ZeroMaxAmountIn.selector);
        board.postPair(p, "");
        p = _pair(_mid01(), _mid10(), 1, 1, e, 1);
        p.inferenceId = bytes32(0);
        vm.expectRevert(AgentQuoteBoardV2.MissingInferenceId.selector);
        board.postPair(p, "");

        AgentQuoteBoardV2.Quote memory q = _quote(T0, T0, 1, 1, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.InvalidPair.selector);
        board.post(q, "");
        q = _quote(address(0), T0, 1, 1, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.ZeroToken.selector);
        board.post(q, "");
        q = _quote(T0, T1, 0, 1, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.InvalidRate.selector);
        board.post(q, "");
        q = _quote(T0, T1, 1, 0, e, 1);
        vm.expectRevert(AgentQuoteBoardV2.ZeroMaxAmountIn.selector);
        board.post(q, "");
    }

    function test_revokedAgentInvalidatesQuotesAndCannotPost() public {
        _postMidPair(600);
        vm.prank(maker);
        board.setAgent(address(0));
        assertFalse(board.isQuoteCurrent(maker, T0, T1));
        vm.expectRevert(AgentQuoteExtructionV2.StaleQuote.selector);
        _fill(T0, T1, true, 1e18, type(uint256).max);
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp + 60), 1);
        bytes memory sig = _signPair(p, AGENT_KEY);
        vm.expectRevert(AgentQuoteBoardV2.InvalidAgentSignature.selector);
        board.postPair(p, sig);
    }

    function test_missingQuoteIsStale() public {
        vm.expectRevert(AgentQuoteExtructionV2.StaleQuote.selector);
        _fill(T0, T1, true, 1e18, type(uint256).max);
    }

    function test_extructionArgErrors() public {
        _postMidPair(60);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.InvalidArgsLength.selector, uint256(2)));
        _fillWith(abi.encodePacked(FEE_BPS), T0, T1, true, 1e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.InvalidFeeBps.selector, uint16(10_000)));
        _fillWith(abi.encodePacked(uint16(10_000), address(pool), MAX_DEV_BPS), T0, T1, true, 1e18, type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(AgentQuoteExtructionV2.InvalidDeviationBps.selector, uint16(0)));
        _fillWith(abi.encodePacked(FEE_BPS, address(pool), uint16(0)), T0, T1, true, 1e18, type(uint256).max);
        vm.expectRevert(AgentQuoteExtructionV2.ZeroSwapAmount.selector);
        _fill(T0, T1, true, 1, type(uint256).max);
    }

    function test_tickMathKnownValuesAndRange() public view {
        assertEq(twap.sqrtAt(0), 79228162514264337593543950336);
        assertEq(twap.sqrtAt(-887272), 4295128739);
        assertEq(twap.sqrtAt(887272), 1461446703485210103287273052203988822378723970342);
        assertEq(twap.sqrtAt(1), 79232123823359799118286999568);
        assertEq(twap.sqrtAt(-1), 79224201403219477170569942574);
    }

    function test_tickOutOfRangeReverts() public {
        vm.expectRevert(abi.encodeWithSelector(TwapPrice.TickOutOfRange.selector, int24(887273)));
        twap.sqrtAt(887273);
    }

    function test_meanTickRoundsTowardNegativeInfinity() public {
        pool.setMeanTick(-1);
        _postMidPair(60);
        vm.expectPartialRevert(AgentQuoteExtructionV2.PriceOutOfBand.selector);
        _fill(T0, T1, true, 1e18, type(uint256).max);
    }

    // ---------- fuzz (finding 8) ----------

    function testFuzz_freshness(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 1, 900));
        elapsed = uint64(bound(elapsed, 0, 2_000));
        _postMidPair(ttl);
        vm.warp(block.timestamp + elapsed);
        if (elapsed < ttl) {
            assertGt(_fill(T0, T1, true, 1e18, type(uint256).max).amountOut, 0);
        } else {
            vm.expectPartialRevert(AgentQuoteExtructionV2.QuoteExpired.selector);
            _fill(T0, T1, true, 1e18, type(uint256).max);
        }
    }

    function testFuzz_ttlBoundOnPost(uint64 ttl) public {
        ttl = uint64(bound(ttl, 0, 5_000));
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), _mid10(), 1, 1, uint64(block.timestamp) + ttl, 1);
        bytes memory sig = _signPair(p, AGENT_KEY);
        if (ttl == 0) vm.expectPartialRevert(AgentQuoteBoardV2.QuoteExpired.selector);
        else if (ttl > 900) vm.expectPartialRevert(AgentQuoteBoardV2.TtlTooLong.selector);
        board.postPair(p, sig);
    }

    function testFuzz_makerFavoringRounding(uint256 amount, bool zeroForOne, bool exactIn) public {
        _postMidPair(600);
        (address tin, address tout) = zeroForOne ? (T0, T1) : (T1, T0);
        uint256 rate = zeroForOne ? _mid01() : _mid10();
        amount = bound(amount, zeroForOne ? 1e15 : 1_000, zeroForOne ? 1_000e18 : 1_000e6);
        if (!exactIn) amount = bound(amount, 1, zeroForOne ? 100e6 : 100e18);
        SwapRegisters memory r = _fill(tin, tout, exactIn, amount, type(uint256).max);
        // Value the maker gives up never exceeds the input at the signed rate net of fee, in exact arithmetic.
        assertLe(r.amountOut * 1e18 * 10_000, r.amountIn * rate * (10_000 - FEE_BPS));
        if (exactIn) assertEq(r.amountIn, amount);
        else assertEq(r.amountOut, amount);
    }

    function testFuzz_exactInExactOutRoundTrip(uint256 amountIn, bool zeroForOne) public {
        _postMidPair(600);
        (address tin, address tout) = zeroForOne ? (T0, T1) : (T1, T0);
        amountIn = bound(amountIn, zeroForOne ? 1e15 : 1_000, zeroForOne ? 1_000e18 : 1_000e6);
        SwapRegisters memory fwd = _fill(tin, tout, true, amountIn, type(uint256).max);
        SwapRegisters memory back = _fill(tin, tout, false, fwd.amountOut, type(uint256).max);
        assertLe(back.amountIn, amountIn);
        SwapRegisters memory again = _fill(tin, tout, true, back.amountIn, type(uint256).max);
        assertGe(again.amountOut, fwd.amountOut);
    }

    function testFuzz_bandRejectsAnyRateOutsideDeviation(uint256 bps) public {
        bps = bound(bps, MAX_DEV_BPS + 1, 50_000);
        uint256 mid = _mid10();
        uint256 rate = mid + Math.mulDiv(mid, bps, 10_000);
        AgentQuoteBoardV2.Pair memory p = _pair(_mid01(), rate, 1e30, 1e30, uint64(block.timestamp + 60), 1);
        board.postPair(p, _signPair(p, AGENT_KEY));
        vm.expectPartialRevert(AgentQuoteExtructionV2.PriceOutOfBand.selector);
        _fill(T1, T0, true, 1e6, type(uint256).max);
    }
}
