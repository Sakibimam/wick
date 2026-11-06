// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BaseAggregatorHook} from "@v4-hooks/aggregator-hooks/BaseAggregatorHook.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IAqua, IAquaSwapVMRouter} from "./interfaces/IAquaSwapVMRouter.sol";

/// @title AquaAggregatorHook
/// @notice Uniswap v4 aggregator hook that fills every swap on its pools from one 1inch Aqua
/// strategy through AquaSwapVMRouter. The hook is the SwapVM taker: it takes the swapper's input
/// from the PoolManager, swaps it against the maker's Aqua balances, and settles the output back.
/// @dev Pricing is whatever the strategy's SwapVM program returns. For Wick that program is
/// AgentQuoteExtruction, which reverts StaleQuote unless the maker's agent signed a current quote
/// for that exact direction, so a Uniswap swap through this hook fails closed instead of filling
/// at an old price. The pools hold no v4 liquidity, so there is no other price to fall through to.
/// One hook serves one Aqua strategy; the owner points it at a new strategy with setOrder.
contract AquaAggregatorHook is BaseAggregatorHook, Ownable {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    /// @dev SwapVM taker traits with no taker data: 20 zero bytes of slice indexes, then the flags.
    /// 0x0040 = useTransferFromAndAquaPush, 0x0001 = isExactIn. Taker and recipient default to msg.sender (this hook).
    bytes private constant EXACT_IN = hex"00000000000000000000000000000000000000000041";
    bytes private constant EXACT_OUT = hex"00000000000000000000000000000000000000000040";

    IAquaSwapVMRouter public immutable router;
    IAqua public immutable aqua;

    IAquaSwapVMRouter.Order private _order;
    bytes32 public orderHash;

    struct PoolTokens {
        address token0;
        address token1;
    }

    mapping(PoolId => PoolTokens) public poolTokens;

    event OrderSet(bytes32 indexed orderHash, address indexed maker);

    error OrderNotSet();
    error TokensNotSupported(address token0, address token1);
    error ExceedsAquaBalance(uint256 amountOut, uint256 available);
    error RouterAmountMismatch(uint256 expected, uint256 actual);

    constructor(IPoolManager manager_, IAquaSwapVMRouter router_, address owner_)
        BaseAggregatorHook(manager_, "AquaAggregatorHook v1.0")
        Ownable(owner_)
    {
        router = router_;
        aqua = IAqua(router_.AQUA());
    }

    /// @notice Points the hook at an Aqua strategy shipped to `router`.
    function setOrder(IAquaSwapVMRouter.Order calldata order_) external onlyOwner {
        bytes32 h = router.hash(order_);
        _order = order_;
        orderHash = h;
        emit OrderSet(h, order_.maker);
    }

    function order() external view returns (IAquaSwapVMRouter.Order memory) {
        return _order;
    }

    /// @inheritdoc BaseAggregatorHook
    /// @dev Depth per side is the smallest of the Aqua strategy balance, the maker's wallet balance and the
    /// maker's allowance to Aqua, because Aqua.pull is a transferFrom on the maker.
    function pseudoTotalValueLocked(PoolId poolId) external view override returns (uint256 amount0, uint256 amount1) {
        PoolTokens memory t = _tokens(poolId);
        address maker = _order.maker;
        amount0 = _depth(maker, t.token0);
        amount1 = _depth(maker, t.token1);
    }

    function _beforeInitialize(address, PoolKey calldata key, uint160) internal override returns (bytes4) {
        bytes32 h = orderHash;
        if (h == bytes32(0)) revert OrderNotSet();
        address token0 = Currency.unwrap(key.currency0);
        address token1 = Currency.unwrap(key.currency1);
        // Aqua reverts unless both tokens are live balances of this strategy.
        try aqua.safeBalances(_order.maker, address(router), h, token0, token1) {}
        catch {
            revert TokensNotSupported(token0, token1);
        }

        poolTokens[key.toId()] = PoolTokens(token0, token1);
        // The hook holds no tokens between swaps, so a standing approval to the immutable router exposes nothing.
        IERC20(token0).forceApprove(address(router), type(uint256).max);
        IERC20(token1).forceApprove(address(router), type(uint256).max);

        emit AggregatorPoolRegistered(key.toId());
        pollTokenJar();
        return IHooks.beforeInitialize.selector;
    }

    /// @inheritdoc BaseAggregatorHook
    function _rawQuote(bool zeroToOne, int256 amountSpecified, PoolId poolId)
        internal
        override
        returns (uint256 amountUnspecified)
    {
        PoolTokens memory t = _tokens(poolId);
        (address tokenIn, address tokenOut) = zeroToOne ? (t.token0, t.token1) : (t.token1, t.token0);
        bool exactIn = amountSpecified < 0;
        uint256 amount = exactIn ? uint256(-amountSpecified) : uint256(amountSpecified);

        (uint256 amountIn, uint256 amountOut,) =
            router.quote(_order, tokenIn, tokenOut, amount, exactIn ? EXACT_IN : EXACT_OUT);

        uint256 available = _depth(_order.maker, tokenOut);
        if (amountOut > available) revert ExceedsAquaBalance(amountOut, available);
        return exactIn ? amountOut : amountIn;
    }

    /// @inheritdoc BaseAggregatorHook
    function _conductSwap(Currency settleCurrency, Currency takeCurrency, SwapParams calldata params, PoolId)
        internal
        override
        returns (uint256 amountSettle, uint256 amountTake, bool hasSettled)
    {
        address tokenIn = Currency.unwrap(takeCurrency);
        address tokenOut = Currency.unwrap(settleCurrency);
        IAquaSwapVMRouter.Order memory o = _order;

        if (params.amountSpecified < 0) {
            amountTake = uint256(-params.amountSpecified);
            poolManager.take(takeCurrency, address(this), amountTake);
            // SwapVM checks amountIn == amountTake for exact-in.
            (, amountSettle,) = router.swap(o, tokenIn, tokenOut, amountTake, EXACT_IN);
        } else {
            amountSettle = uint256(params.amountSpecified);
            (amountTake,,) = router.quote(o, tokenIn, tokenOut, amountSettle, EXACT_OUT);
            poolManager.take(takeCurrency, address(this), amountTake);
            (uint256 swappedIn,,) = router.swap(o, tokenIn, tokenOut, amountSettle, EXACT_OUT);
            if (swappedIn != amountTake) revert RouterAmountMismatch(amountTake, swappedIn);
        }

        poolManager.sync(settleCurrency);
        IERC20(tokenOut).safeTransfer(address(poolManager), amountSettle);
        poolManager.settle();
        hasSettled = true;
    }

    function _tokens(PoolId poolId) private view returns (PoolTokens memory t) {
        t = poolTokens[poolId];
        if (t.token0 == address(0)) revert PoolDoesNotExist();
    }

    function _depth(address maker, address token) private view returns (uint256 d) {
        (d,) = aqua.rawBalances(maker, address(router), orderHash, token);
        uint256 wallet = IERC20(token).balanceOf(maker);
        uint256 allowance = IERC20(token).allowance(maker, address(aqua));
        if (wallet < d) d = wallet;
        if (allowance < d) d = allowance;
    }
}
