// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {Actions} from "@uniswap/v4-periphery/src/libraries/Actions.sol";
import {HookMiner} from "@v4-hooks/utils/HookMiner.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AquaAggregatorHook} from "../src/AquaAggregatorHook.sol";
import {IAquaSwapVMRouter} from "../src/interfaces/IAquaSwapVMRouter.sol";

interface IAgentQuoteBoard {
    struct Quote {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 rateE18;
        uint64 expiry;
        uint64 nonce;
        bytes32 inferenceId;
    }

    function setAgent(address agent) external;
    function post(Quote calldata q, bytes calldata sig) external;
    function getQuote(address maker, address tokenIn, address tokenOut) external view returns (Quote memory);
    function isQuoteCurrent(address maker, address tokenIn, address tokenOut) external view returns (bool);
    function quoteDigest(Quote calldata q) external view returns (bytes32);
}

interface IAquaShip {
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32);
}

interface IUniversalRouter {
    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable;
}

interface IPermit2 {
    function approve(address token, address spender, uint160 amount, uint48 expiration) external;
}

interface IUniswapV3PoolSlot0 {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

/// @dev Shared Base mainnet fork fixture: the real v4 PoolManager and Universal Router, the real
/// AquaSwapVMRouter and Aqua, and the live Wick AgentQuoteBoard and AgentQuoteExtruction.
abstract contract AquaHookBase is Test {
    using PoolIdLibrary for PoolKey;

    // Uniswap v4 on Base, docs.uniswap.org/contracts/v4/deployments, each checked with `cast code`.
    IPoolManager internal constant PM = IPoolManager(0x498581fF718922c3f8e6A244956aF099B2652b2b);
    IUniversalRouter internal constant UR = IUniversalRouter(0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40);
    IPermit2 internal constant PERMIT2 = IPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
    // 1inch AquaSwapVMRouter v1.0.2 and Aqua.
    IAquaSwapVMRouter internal constant ROUTER = IAquaSwapVMRouter(0x111111338c5091E8440b67B168bAe16a668AC0De);
    address internal constant AQUA = 0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a;
    // Live Wick board and extruction (extruction.board() == BOARD on chain).
    IAgentQuoteBoard internal constant BOARD = IAgentQuoteBoard(0x309933CE439Da6A059593d73B8c82E8C8447C3F8);
    address internal constant EXTRUCTION = 0x59d954dd4fDE7F99634f7b2d29E6b4fFEbE7B7e0;
    IERC20 internal constant W0G = IERC20(0x23cd099eB438CcA50349EE2BC809196b1ae00861);
    IERC20 internal constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    IUniswapV3PoolSlot0 internal constant V3_W0G_USDC = IUniswapV3PoolSlot0(0xe03cCe449932219fc0Ca28f3a4f784CE55dE0c4e);

    uint256 internal constant FORK_BLOCK = 53_796_900;
    uint16 internal constant FEE_BPS = 30;
    uint256 internal constant MAKER_W0G = 50_000e18;
    uint256 internal constant MAKER_USDC = 50_000e6;
    uint256 internal constant MAKER_TRAITS_AQUA = 1 << 254;
    uint256 internal constant MAKER_KEY = 0xA11CE;
    uint256 internal constant AGENT_KEY = 0xA63E17;

    uint256 internal constant V4_SWAP = 0x10;
    uint160 internal constant FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    struct ExactOutputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountOut;
        uint128 amountInMaximum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    AquaAggregatorHook internal hook;
    PoolKey internal key;
    PoolId internal poolId;
    IAquaSwapVMRouter.Order internal order;
    address internal maker;
    address internal agent;
    address internal alice = makeAddr("alice");
    uint64 internal nonce;

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")), FORK_BLOCK);
        hook = _deployHook(address(this));
        maker = vm.addr(MAKER_KEY);
        agent = vm.addr(AGENT_KEY);

        vm.prank(maker);
        BOARD.setAgent(agent);
        order = _shipFreshStrategy(maker);
        hook.setOrder(order);

        key = PoolKey({
            currency0: Currency.wrap(address(W0G)),
            currency1: Currency.wrap(address(USDC)),
            fee: 0,
            tickSpacing: 1,
            hooks: IHooks(address(hook))
        });
        poolId = key.toId();
        (uint160 sqrtPriceX96,,,,,,) = V3_W0G_USDC.slot0();
        PM.initialize(key, sqrtPriceX96);

        deal(address(W0G), alice, 1_000_000e18);
        deal(address(USDC), alice, 100_000e6);
        vm.startPrank(alice);
        W0G.approve(address(PERMIT2), type(uint256).max);
        USDC.approve(address(PERMIT2), type(uint256).max);
        PERMIT2.approve(address(W0G), address(UR), type(uint160).max, type(uint48).max);
        PERMIT2.approve(address(USDC), address(UR), type(uint160).max, type(uint48).max);
        vm.stopPrank();
    }

    function _deployHook(address owner) internal returns (AquaAggregatorHook h) {
        bytes memory args = abi.encode(address(PM), address(ROUTER), owner);
        (address predicted, bytes32 salt) =
            HookMiner.find(address(this), FLAGS, type(AquaAggregatorHook).creationCode, args);
        h = new AquaAggregatorHook{salt: salt}(PM, ROUTER, owner);
        require(address(h) == predicted, "hook address mismatch");
    }

    function _shipFreshStrategy(address m) internal returns (IAquaSwapVMRouter.Order memory o) {
        o = IAquaSwapVMRouter.Order({
            maker: m,
            traits: MAKER_TRAITS_AQUA,
            data: abi.encodePacked(bytes1(0x20), bytes1(uint8(22)), EXTRUCTION, FEE_BPS)
        });
        deal(address(W0G), m, MAKER_W0G);
        deal(address(USDC), m, MAKER_USDC);
        address[] memory tokens = new address[](2);
        tokens[0] = address(W0G);
        tokens[1] = address(USDC);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = MAKER_W0G;
        amounts[1] = MAKER_USDC;
        vm.startPrank(m);
        W0G.approve(AQUA, type(uint256).max);
        USDC.approve(AQUA, type(uint256).max);
        bytes32 shipped = IAquaShip(AQUA).ship(address(ROUTER), abi.encode(o), tokens, amounts);
        vm.stopPrank();
        require(shipped == ROUTER.hash(o), "strategy hash mismatch");
    }

    function _post(address tokenIn, address tokenOut, uint256 rate, uint64 expiry) internal {
        IAgentQuoteBoard.Quote memory q = IAgentQuoteBoard.Quote({
            maker: maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            rateE18: rate,
            expiry: expiry,
            nonce: ++nonce,
            inferenceId: keccak256(abi.encode("0g-compute-request", nonce, tokenIn, tokenOut))
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AGENT_KEY, BOARD.quoteDigest(q));
        BOARD.post(q, abi.encodePacked(r, s, v));
    }

    function _postBothMid() internal {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        _post(address(USDC), address(W0G), _mid(address(USDC)), expiry);
        _post(address(W0G), address(USDC), _mid(address(W0G)), expiry);
    }

    /// @dev Uniswap v3 W0G/USDC mid in raw units, scaled 1e18, the same source the Wick agent prices against.
    function _mid(address tokenIn) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,,,,) = V3_W0G_USDC.slot0();
        uint256 sq = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);
        return tokenIn == address(W0G) ? Math.mulDiv(sq, 1e18, 1 << 192) : Math.mulDiv(1 << 192, 1e18, sq);
    }

    function _rate(address tokenIn, address tokenOut) internal view returns (uint256) {
        return BOARD.getQuote(maker, tokenIn, tokenOut).rateE18;
    }

    function _netOut(uint256 amountIn, uint256 rate) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(amountIn, rate, 1e18), 10_000 - FEE_BPS, 10_000);
    }

    function _grossIn(uint256 amountOut, uint256 rate) internal pure returns (uint256) {
        uint256 grossOut = Math.mulDiv(amountOut, 10_000, 10_000 - FEE_BPS, Math.Rounding.Ceil);
        return Math.mulDiv(grossOut, 1e18, rate, Math.Rounding.Ceil);
    }

    // Universal Router V4_SWAP. `settleFirst` pays the input into the PoolManager before the swap action,
    // which a token the PoolManager does not already hold needs (see README, PoolManager inventory).
    function _exactIn(bool zeroForOne, uint256 amountIn, uint256 minOut, bool settleFirst) internal {
        (bool ok, bytes memory ret) = _tryExactIn(zeroForOne, amountIn, minOut, settleFirst);
        _bubble(ok, ret);
    }

    function _exactOut(bool zeroForOne, uint256 amountOut, uint256 maxIn, bool settleFirst) internal {
        (bool ok, bytes memory ret) = _tryExactOut(zeroForOne, amountOut, maxIn, settleFirst);
        _bubble(ok, ret);
    }

    function _bubble(bool ok, bytes memory ret) internal pure {
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }

    function _tryExactIn(bool zeroForOne, uint256 amountIn, uint256 minOut, bool settleFirst)
        internal
        returns (bool, bytes memory)
    {
        (Currency cIn, Currency cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes memory swapParams = abi.encode(
            ExactInputSingleParams(key, zeroForOne, uint128(amountIn), uint128(minOut), 0, bytes(""))
        );
        bytes[] memory params = new bytes[](3);
        bytes memory actions;
        if (settleFirst) {
            actions = abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.TAKE_ALL));
            params[0] = abi.encode(cIn, amountIn, true);
            params[1] = swapParams;
        } else {
            actions =
                abi.encodePacked(uint8(Actions.SWAP_EXACT_IN_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
            params[0] = swapParams;
            params[1] = abi.encode(cIn, amountIn);
        }
        params[2] = abi.encode(cOut, minOut);
        return _execute(actions, params);
    }

    function _tryExactOut(bool zeroForOne, uint256 amountOut, uint256 maxIn, bool settleFirst)
        internal
        returns (bool, bytes memory)
    {
        (Currency cIn, Currency cOut) = zeroForOne ? (key.currency0, key.currency1) : (key.currency1, key.currency0);
        bytes memory swapParams = abi.encode(
            ExactOutputSingleParams(key, zeroForOne, uint128(amountOut), uint128(maxIn), 0, bytes(""))
        );
        bytes[] memory params = new bytes[](3);
        bytes memory actions;
        if (settleFirst) {
            actions =
                abi.encodePacked(uint8(Actions.SETTLE), uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.TAKE_ALL));
            params[0] = abi.encode(cIn, maxIn, true);
            params[1] = swapParams;
        } else {
            actions =
                abi.encodePacked(uint8(Actions.SWAP_EXACT_OUT_SINGLE), uint8(Actions.SETTLE_ALL), uint8(Actions.TAKE_ALL));
            params[0] = swapParams;
            params[1] = abi.encode(cIn, maxIn);
        }
        params[2] = abi.encode(cOut, amountOut);
        return _execute(actions, params);
    }

    function _execute(bytes memory actions, bytes[] memory params) internal returns (bool ok, bytes memory ret) {
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(actions, params);
        vm.prank(alice);
        (ok, ret) = address(UR).call(
            abi.encodeCall(IUniversalRouter.execute, (abi.encodePacked(uint8(V4_SWAP)), inputs, block.timestamp))
        );
    }

    /// @dev True when `needle` appears anywhere in revert data, so the check holds through
    /// PoolManager's WrappedError and the Universal Router's own wrapping.
    function _contains(bytes memory hay, bytes4 needle) internal pure returns (bool) {
        if (hay.length < 4) return false;
        for (uint256 i; i <= hay.length - 4; ++i) {
            if (hay[i] == needle[0] && hay[i + 1] == needle[1] && hay[i + 2] == needle[2] && hay[i + 3] == needle[3]) {
                return true;
            }
        }
        return false;
    }
}
