// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IExtruction, IStaticExtruction} from "@1inch/swap-vm/src/instructions/Extruction.sol";
import {SwapQuery, SwapRegisters} from "@1inch/swap-vm/src/libs/VM.sol";
import {AgentQuoteBoard} from "./AgentQuoteBoard.sol";

contract AgentQuoteExtruction is IExtruction, IStaticExtruction {
    uint256 private constant _ONE = 1e18;
    uint256 private constant _BPS = 10_000;

    AgentQuoteBoard private immutable _board;

    error InvalidArgsLength(uint256 length);
    error InvalidFeeBps(uint16 feeBps);
    error StaleQuote();
    error ZeroSwapAmount();

    constructor(AgentQuoteBoard board_) {
        _board = board_;
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
        if (args.length != 2) revert InvalidArgsLength(args.length);
        uint16 feeBps = uint16(bytes2(args));
        if (feeBps >= _BPS) revert InvalidFeeBps(feeBps);

        AgentQuoteBoard.Quote memory q = _board.getQuote(query.maker, query.tokenIn, query.tokenOut);
        if (
            q.maker != query.maker || q.tokenIn != query.tokenIn || q.tokenOut != query.tokenOut || q.rateE18 == 0
                || block.timestamp > q.expiry
        ) revert StaleQuote();

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

        return (nextPC, 0, updatedSwap);
    }
}
