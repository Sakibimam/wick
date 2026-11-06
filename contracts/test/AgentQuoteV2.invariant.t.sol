// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Test} from "forge-std/Test.sol";
import {SwapQuery, SwapRegisters} from "@1inch/swap-vm/src/libs/VM.sol";
import {AgentQuoteBoardV2} from "../src/AgentQuoteBoardV2.sol";
import {AgentQuoteExtructionV2} from "../src/AgentQuoteExtructionV2.sol";
import {MockPool, TwapHarness} from "./V2Fixture.sol";

/// @dev Drives the board and extruction the way the cron, a leaked key and takers would, tracking ghost state.
contract V2Handler is Test {
    uint16 internal constant FEE = 30;
    uint16 internal constant DEV = 800;
    int24 internal constant TICK = -295490;
    address internal constant T0 = address(0x1000);
    address internal constant T1 = address(0x2000);

    AgentQuoteBoardV2 public board;
    AgentQuoteExtructionV2 public ext;
    MockPool public pool;
    address public maker;
    uint256[3] internal keys = [uint256(0xA63E17), 0xA63E18, 0xA63E19];
    uint256 public agentKey;
    uint256 public leakedKey;
    uint256 internal mid01;
    uint256 internal mid10;

    mapping(uint64 epoch => uint64 nonce) public ghostNonce;
    uint64 public maxEpochSeen;
    uint256 public balance0 = 1_000e18;
    uint256 public balance1 = 200e6;
    uint256 public makerLossViolations;
    uint256 public overMaxInViolations;
    uint256 public overDepthViolations;
    uint256 public swaps;
    uint256 public posts;
    uint256 public leakedPostsAccepted;

    constructor() {
        vm.warp(1_800_000_000);
        maker = vm.addr(0xA11CE);
        board = new AgentQuoteBoardV2();
        ext = new AgentQuoteExtructionV2(board);
        pool = new MockPool(T0, T1, TICK);
        TwapHarness h = new TwapHarness();
        mid01 = h.rate(TICK, true);
        mid10 = h.rate(TICK, false);
        agentKey = keys[0];
        vm.prank(maker);
        board.setAgent(vm.addr(agentKey));
        maxEpochSeen = 1;
    }

    function postPair(uint256 dev01, uint256 dev10, uint64 ttl, uint64 step, uint128 max0, uint128 max1) external {
        if (agentKey == 0) return;
        uint64 epoch = board.epochOf(maker);
        uint64 n = board.lastNonce(maker, epoch) + uint64(bound(step, 1, 5));
        AgentQuoteBoardV2.Pair memory p = AgentQuoteBoardV2.Pair({
            maker: maker,
            token0: T0,
            token1: T1,
            rate01E18: _skew(mid01, dev01),
            rate10E18: _skew(mid10, dev10),
            maxIn0: bound(max0, 1, 1_000e18),
            maxIn1: bound(max1, 1, 1_000e6),
            expiry: uint64(block.timestamp) + uint64(bound(ttl, 1, 900)),
            epoch: epoch,
            nonce: n,
            inferenceId: keccak256(abi.encode(n, epoch))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, board.pairDigest(p));
        board.postPair(p, abi.encodePacked(r, s, v));
        ghostNonce[epoch] = n;
        posts++;
    }

    function post(bool zeroForOne, uint256 dev, uint64 ttl, uint128 maxIn) external {
        if (agentKey == 0) return;
        uint64 epoch = board.epochOf(maker);
        uint64 n = board.lastNonce(maker, epoch) + 1;
        AgentQuoteBoardV2.Quote memory q = AgentQuoteBoardV2.Quote({
            maker: maker,
            tokenIn: zeroForOne ? T0 : T1,
            tokenOut: zeroForOne ? T1 : T0,
            rateE18: _skew(zeroForOne ? mid01 : mid10, dev),
            maxAmountIn: bound(maxIn, 1, zeroForOne ? 1_000e18 : 1_000e6),
            expiry: uint64(block.timestamp) + uint64(bound(ttl, 1, 900)),
            epoch: epoch,
            nonce: n,
            inferenceId: keccak256(abi.encode("single", n, epoch))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, board.quoteDigest(q));
        board.post(q, abi.encodePacked(r, s, v));
        ghostNonce[epoch] = n;
        posts++;
    }

    /// @dev A key that was once the agent tries to brick the board with nonce = max in whatever epoch is current.
    function leakedKeyPost(uint64 nonce) external {
        if (leakedKey == 0 || leakedKey == agentKey) return;
        uint64 epoch = board.epochOf(maker);
        AgentQuoteBoardV2.Pair memory p = AgentQuoteBoardV2.Pair({
            maker: maker,
            token0: T0,
            token1: T1,
            rate01E18: mid01,
            rate10E18: mid10,
            maxIn0: 1,
            maxIn1: 1,
            expiry: uint64(block.timestamp) + 60,
            epoch: epoch,
            nonce: uint64(bound(nonce, board.lastNonce(maker, epoch) + 1, type(uint64).max)),
            inferenceId: keccak256("leak")
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(leakedKey, board.pairDigest(p));
        try board.postPair(p, abi.encodePacked(r, s, v)) {
            leakedPostsAccepted++;
        } catch {}
    }

    function setAgent(uint256 which) external {
        uint256 idx = bound(which, 0, 3);
        uint256 next = idx == 3 ? 0 : keys[idx];
        if (agentKey != 0 && agentKey != next) leakedKey = agentKey;
        agentKey = next;
        vm.prank(maker);
        board.setAgent(agentKey == 0 ? address(0) : vm.addr(agentKey));
        maxEpochSeen = board.epochOf(maker);
    }

    function warp(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1, 600));
    }

    function swap(bool zeroForOne, bool exactIn, uint256 amount) external {
        (address tin, address tout) = zeroForOne ? (T0, T1) : (T1, T0);
        amount = bound(amount, 1, zeroForOne ? (exactIn ? 50e18 : 10e6) : (exactIn ? 10e6 : 50e18));
        uint256 balOut = zeroForOne ? balance1 : balance0;
        SwapQuery memory q = SwapQuery(bytes32(0), maker, address(0xBEEF), tin, tout, exactIn);
        SwapRegisters memory reg = SwapRegisters(0, balOut, exactIn ? amount : 0, exactIn ? 0 : amount, 0);
        try ext.extruction(false, 0, q, reg, abi.encodePacked(FEE, address(pool), DEV), "") returns (
            uint256, uint256, SwapRegisters memory out
        ) {
            AgentQuoteBoardV2.Posted memory pq = board.getQuote(maker, tin, tout);
            if (out.amountOut * 1e18 * 10_000 > out.amountIn * pq.rateE18 * (10_000 - FEE)) makerLossViolations++;
            if (out.amountIn > pq.maxAmountIn) overMaxInViolations++;
            if (out.amountOut > balOut) overDepthViolations++;
            if (zeroForOne) {
                balance0 += out.amountIn;
                balance1 -= out.amountOut;
            } else {
                balance1 += out.amountIn;
                balance0 -= out.amountOut;
            }
            swaps++;
        } catch {}
    }

    function _skew(uint256 mid, uint256 dev) private pure returns (uint256) {
        // Signed rates within +-10% of the TWAP, so some land outside the 8% band and must never fill.
        uint256 bps = bound(dev, 0, 2_000);
        return mid * (9_000 + bps) / 10_000;
    }
}

/// @dev Proves the handler reaches the states the invariants guard: accepted posts, real fills, a rejected leaked key.
contract V2HandlerReach is Test {
    function test_handlerPostsFillsAndRejectsLeakedKey() public {
        V2Handler h = new V2Handler();
        h.postPair(1_000, 1_000, 900, 1, 1e30, 1e30);
        h.swap(true, true, 1e18);
        h.swap(false, false, 1e18);
        h.setAgent(1);
        h.leakedKeyPost(type(uint64).max);
        h.post(true, 1_000, 900, 1e30);
        h.swap(true, true, 2e18);
        assertEq(h.posts(), 2);
        assertEq(h.swaps(), 3);
        assertEq(h.leakedPostsAccepted(), 0);
    }
}

contract AgentQuoteV2Invariant is StdInvariant, Test {
    V2Handler private h;
    address private constant T0 = address(0x1000);
    address private constant T1 = address(0x2000);

    function setUp() public {
        h = new V2Handler();
        targetContract(address(h));
    }

    function invariant_nonceMonotonicPerEpochAndPastEpochsFrozen() public view {
        AgentQuoteBoardV2 board = h.board();
        address maker = h.maker();
        uint64 current = board.epochOf(maker);
        assertEq(current, h.maxEpochSeen());
        for (uint64 e = 1; e <= current; ++e) {
            assertGe(board.lastNonce(maker, e), h.ghostNonce(e));
        }
    }

    function invariant_currentImpliesEpochMatchAndLiveAgent() public view {
        AgentQuoteBoardV2 board = h.board();
        address maker = h.maker();
        address[2] memory a = [T0, T1];
        for (uint256 i; i < 2; ++i) {
            address tin = a[i];
            address tout = a[1 - i];
            if (board.isQuoteCurrent(maker, tin, tout)) {
                assertEq(board.getQuote(maker, tin, tout).epoch, board.epochOf(maker));
                assertTrue(board.getAgent(maker) != address(0));
            }
        }
    }

    function invariant_makerNeverLosesBeyondFeeFavorableRounding() public view {
        assertEq(h.makerLossViolations(), 0);
        assertEq(h.overMaxInViolations(), 0);
        assertEq(h.overDepthViolations(), 0);
    }

    function invariant_leakedKeyNeverPosts() public view {
        assertEq(h.leakedPostsAccepted(), 0);
    }
}
