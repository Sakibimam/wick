// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SwapQuery, SwapRegisters} from "@1inch/swap-vm/src/libs/VM.sol";
import {AgentQuoteBoardV2} from "../src/AgentQuoteBoardV2.sol";
import {AgentQuoteExtructionV2} from "../src/AgentQuoteExtructionV2.sol";
import {TwapPrice} from "../src/TwapPrice.sol";

/// @dev Uniswap v3 oracle stand-in: a constant mean tick over any window, settable spot for manipulation tests.
contract MockPool {
    address public token0;
    address public token1;
    int24 public meanTick;

    constructor(address t0, address t1, int24 tick) {
        token0 = t0;
        token1 = t1;
        meanTick = tick;
    }

    function setMeanTick(int24 tick) external {
        meanTick = tick;
    }

    function observe(uint32[] calldata ago) external view returns (int56[] memory c, uint160[] memory s) {
        c = new int56[](ago.length);
        s = new uint160[](ago.length);
        for (uint256 i; i < ago.length; ++i) {
            c[i] = int56(1_000_000_000) - int56(meanTick) * int56(uint56(ago[i]));
        }
    }
}

/// @dev ERC-1271 agent: a contract wallet whose owner key signs quotes.
contract Wallet1271 {
    address private immutable _owner;

    constructor(address owner_) {
        _owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        (address r,,) = ECDSA.tryRecover(hash, sig);
        return r == _owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract TwapHarness {
    function rate(int24 tick, bool zeroForOne) external pure returns (uint256) {
        return TwapPrice.rateE18(tick, zeroForOne);
    }

    function sqrtAt(int24 tick) external pure returns (uint160) {
        return TwapPrice.sqrtRatioAtTick(tick);
    }
}

abstract contract V2Fixture is Test {
    uint16 internal constant FEE_BPS = 30;
    uint16 internal constant MAX_DEV_BPS = 800;
    int24 internal constant TICK = -295490;
    uint256 internal constant MAKER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xA63E17;
    // Token addresses sorted like a Uniswap pool: T0 (W0G-like, 18 dp) < T1 (USDC-like, 6 dp).
    address internal constant T0 = address(0x1000);
    address internal constant T1 = address(0x2000);

    AgentQuoteBoardV2 internal board;
    AgentQuoteExtructionV2 internal ext;
    MockPool internal pool;
    TwapHarness internal twap;
    address internal maker;
    address internal agent;
    uint64 internal nonce;

    function _setUpV2() internal {
        vm.warp(1_800_000_000);
        maker = vm.addr(MAKER_KEY);
        agent = vm.addr(AGENT_KEY);
        board = new AgentQuoteBoardV2();
        ext = new AgentQuoteExtructionV2(board);
        pool = new MockPool(T0, T1, TICK);
        twap = new TwapHarness();
        vm.prank(maker);
        board.setAgent(agent);
    }

    function _mid01() internal view returns (uint256) {
        return twap.rate(TICK, true);
    }

    function _mid10() internal view returns (uint256) {
        return twap.rate(TICK, false);
    }

    function _pair(uint256 r01, uint256 r10, uint256 max0, uint256 max1, uint64 expiry, uint64 n)
        internal
        view
        returns (AgentQuoteBoardV2.Pair memory p)
    {
        p = AgentQuoteBoardV2.Pair({
            maker: maker,
            token0: T0,
            token1: T1,
            rate01E18: r01,
            rate10E18: r10,
            maxIn0: max0,
            maxIn1: max1,
            expiry: expiry,
            epoch: board.epochOf(maker),
            nonce: n,
            inferenceId: keccak256(abi.encode("0g-request", n))
        });
    }

    function _quote(address tin, address tout, uint256 rate, uint256 maxIn, uint64 expiry, uint64 n)
        internal
        view
        returns (AgentQuoteBoardV2.Quote memory q)
    {
        q = AgentQuoteBoardV2.Quote({
            maker: maker,
            tokenIn: tin,
            tokenOut: tout,
            rateE18: rate,
            maxAmountIn: maxIn,
            expiry: expiry,
            epoch: board.epochOf(maker),
            nonce: n,
            inferenceId: keccak256(abi.encode("0g-request", n))
        });
    }

    function _signPair(AgentQuoteBoardV2.Pair memory p, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, board.pairDigest(p));
        return abi.encodePacked(r, s, v);
    }

    function _signQuote(AgentQuoteBoardV2.Quote memory q, uint256 key) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, board.quoteDigest(q));
        return abi.encodePacked(r, s, v);
    }

    function _postMidPair(uint64 ttl) internal {
        AgentQuoteBoardV2.Pair memory p =
            _pair(_mid01(), _mid10(), 1_000e18, 1_000e6, uint64(block.timestamp) + ttl, ++nonce);
        board.postPair(p, _signPair(p, AGENT_KEY));
    }

    function _args() internal view returns (bytes memory) {
        return abi.encodePacked(FEE_BPS, address(pool), MAX_DEV_BPS);
    }

    function _fill(address tin, address tout, bool exactIn, uint256 amount, uint256 balanceOut)
        internal
        view
        returns (SwapRegisters memory out)
    {
        return _fillWith(_args(), tin, tout, exactIn, amount, balanceOut);
    }

    function _fillWith(bytes memory args, address tin, address tout, bool exactIn, uint256 amount, uint256 balanceOut)
        internal
        view
        returns (SwapRegisters memory out)
    {
        SwapQuery memory q = SwapQuery(bytes32(0), maker, address(0xBEEF), tin, tout, exactIn);
        SwapRegisters memory r = SwapRegisters(0, balanceOut, exactIn ? amount : 0, exactIn ? 0 : amount, 0);
        (,, out) = ext.extruction(true, 0, q, r, args, "");
    }
}
