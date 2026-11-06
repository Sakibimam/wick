// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IExtruction, IStaticExtruction} from "@1inch/swap-vm/src/instructions/Extruction.sol";
import {SwapQuery, SwapRegisters} from "@1inch/swap-vm/src/libs/VM.sol";
import {AgentQuoteBoardV2} from "./AgentQuoteBoardV2.sol";
import {IUniswapV3PoolOracle, TwapPrice} from "./TwapPrice.sol";

/// @notice SwapVM Extruction that fills only at the agent's current signed rate, inside a Uniswap v3 TWAP band,
/// up to the quote's maxAmountIn and the strategy's Aqua balance.
/// @dev args = feeBps (2 bytes) | pool (20 bytes) | maxDeviationBps (2 bytes). quote() and swap() run the same view.
contract AgentQuoteExtructionV2 is IExtruction, IStaticExtruction {
    uint256 private constant _ONE = 1e18;
    uint256 private constant _BPS = 10_000;
    uint32 public constant TWAP_WINDOW = 600;

    AgentQuoteBoardV2 private immutable _board;

    error InvalidArgsLength(uint256 length);
    error InvalidFeeBps(uint16 feeBps);
    error InvalidDeviationBps(uint16 maxDeviationBps);
    error PoolPairMismatch(address pool);
    error StaleQuote();
    error QuoteExpired(uint64 expiry);
    error AmountInTooLarge(uint256 amountIn, uint256 maxAmountIn);
    error InsufficientDepth(uint256 amountOut, uint256 balanceOut);
    error PriceOutOfBand(uint256 rateE18, uint256 twapRateE18, uint16 maxDeviationBps);
    error ZeroSwapAmount();

    constructor(AgentQuoteBoardV2 board_) {
        _board = board_;
    }

    function board() external view returns (AgentQuoteBoardV2) {
        return _board;
    }

    function extruction(
        bool,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata
    )
        external
        view
        override(IExtruction, IStaticExtruction)
        returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap)
    {
        if (args.length != 24) revert InvalidArgsLength(args.length);
        uint16 feeBps = uint16(bytes2(args[0:2]));
        address pool = address(bytes20(args[2:22]));
        uint16 maxDeviationBps = uint16(bytes2(args[22:24]));
        if (feeBps >= _BPS) revert InvalidFeeBps(feeBps);
        if (maxDeviationBps == 0 || maxDeviationBps >= _BPS) revert InvalidDeviationBps(maxDeviationBps);
        if (!_board.isQuoteCurrent(query.maker, query.tokenIn, query.tokenOut)) revert StaleQuote();

        AgentQuoteBoardV2.Posted memory q = _board.getQuote(query.maker, query.tokenIn, query.tokenOut);
        if (block.timestamp >= q.expiry) revert QuoteExpired(q.expiry);
        _checkBand(pool, query.tokenIn, query.tokenOut, q.rateE18, maxDeviationBps);

        updatedSwap = swap;
        if (query.isExactIn) {
            uint256 grossOut = Math.mulDiv(swap.amountIn, q.rateE18, _ONE);
            updatedSwap.amountOut = Math.mulDiv(grossOut, _BPS - feeBps, _BPS);
            if (updatedSwap.amountOut == 0) revert ZeroSwapAmount();
        } else {
            uint256 grossOut = Math.mulDiv(swap.amountOut, _BPS, _BPS - feeBps, Math.Rounding.Ceil);
            updatedSwap.amountIn = Math.mulDiv(grossOut, _ONE, q.rateE18, Math.Rounding.Ceil);
            if (updatedSwap.amountIn == 0) revert ZeroSwapAmount();
        }
        if (updatedSwap.amountIn > q.maxAmountIn) revert AmountInTooLarge(updatedSwap.amountIn, q.maxAmountIn);
        if (updatedSwap.amountOut > swap.balanceOut) revert InsufficientDepth(updatedSwap.amountOut, swap.balanceOut);

        return (nextPC, 0, updatedSwap);
    }

    function _checkBand(address pool, address tokenIn, address tokenOut, uint256 rate, uint16 maxDeviationBps)
        private
        view
    {
        bool zeroForOne = tokenIn < tokenOut;
        (address t0, address t1) = zeroForOne ? (tokenIn, tokenOut) : (tokenOut, tokenIn);
        IUniswapV3PoolOracle oracle = IUniswapV3PoolOracle(pool);
        if (oracle.token0() != t0 || oracle.token1() != t1) revert PoolPairMismatch(pool);
        uint256 twap = TwapPrice.rateE18(TwapPrice.meanTick(oracle, TWAP_WINDOW), zeroForOne);
        uint256 diff = rate > twap ? rate - twap : twap - rate;
        if (diff * _BPS > twap * maxDeviationBps) revert PriceOutOfBand(rate, twap, maxDeviationBps);
    }
}
