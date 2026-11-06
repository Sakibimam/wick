// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The subset of 1inch SwapVM (AquaSwapVMRouter v1.0.2) the hook calls.
/// @dev `traits` is SwapVM's MakerTraits user-defined value type; it ABI-encodes as uint256.
interface IAquaSwapVMRouter {
    struct Order {
        address maker;
        uint256 traits;
        bytes data;
    }

    function AQUA() external view returns (address);

    function hash(Order calldata order) external view returns (bytes32);

    function quote(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);

    function swap(Order calldata order, address tokenIn, address tokenOut, uint256 amount, bytes calldata takerTraitsAndData)
        external
        returns (uint256 amountIn, uint256 amountOut, bytes32 orderHash);
}

/// @notice The subset of 1inch Aqua the hook reads.
interface IAqua {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);

    function safeBalances(address maker, address app, bytes32 strategyHash, address token0, address token1)
        external
        view
        returns (uint256 balance0, uint256 balance1);
}
