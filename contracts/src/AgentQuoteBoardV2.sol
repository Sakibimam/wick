// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Agent-signed price board for one maker's Aqua strategy.
/// @dev Nonces are scoped to (maker, agentEpoch) and every signature binds its epoch, so rotating the agent
/// both invalidates outstanding quotes and resets the nonce space a leaked key could have exhausted.
/// A quote is fillable while block.timestamp < expiry; post enforces the same rule plus expiry <= now + MAX_TTL.
contract AgentQuoteBoardV2 is EIP712 {
    uint64 public constant MAX_TTL = 900;

    struct Quote {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 rateE18;
        uint256 maxAmountIn;
        uint64 expiry;
        uint64 epoch;
        uint64 nonce;
        bytes32 inferenceId;
    }

    /// @dev Both directions of token0 < token1 in one signature: rate01 prices token0 in -> token1 out.
    struct Pair {
        address maker;
        address token0;
        address token1;
        uint256 rate01E18;
        uint256 rate10E18;
        uint256 maxIn0;
        uint256 maxIn1;
        uint64 expiry;
        uint64 epoch;
        uint64 nonce;
        bytes32 inferenceId;
    }

    struct Posted {
        uint256 rateE18;
        uint256 maxAmountIn;
        uint64 expiry;
        uint64 epoch;
        uint64 nonce;
        bytes32 inferenceId;
    }

    bytes32 private constant _QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address tokenIn,address tokenOut,uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)"
    );
    bytes32 private constant _PAIR_TYPEHASH = keccak256(
        "Pair(address maker,address token0,address token1,uint256 rate01E18,uint256 rate10E18,uint256 maxIn0,uint256 maxIn1,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId)"
    );

    error ZeroMaker();
    error ZeroToken();
    error InvalidPair();
    error InvalidRate();
    error ZeroMaxAmountIn();
    error MissingInferenceId();
    error QuoteExpired(uint64 expiry);
    error TtlTooLong(uint64 expiry, uint64 maxExpiry);
    error WrongEpoch(uint64 epoch, uint64 currentEpoch);
    error NonceNotIncreasing(uint64 nonce, uint64 lastNonce);
    error InvalidAgentSignature();

    event AgentSet(address indexed maker, address indexed agent, uint64 epoch);
    event QuotePosted(
        address indexed maker,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 rateE18,
        uint256 maxAmountIn,
        uint64 expiry,
        uint64 epoch,
        uint64 nonce,
        bytes32 inferenceId
    );

    mapping(address maker => address agent) private _agentOf;
    mapping(address maker => uint64 epoch) private _epochOf;
    mapping(address maker => mapping(uint64 epoch => uint64 nonce)) private _lastNonce;
    mapping(address maker => mapping(address tokenIn => mapping(address tokenOut => Posted))) private _posted;

    constructor() EIP712("Wick AgentQuoteBoard", "2") {}

    function setAgent(address agent) external {
        uint64 epoch = ++_epochOf[msg.sender];
        _agentOf[msg.sender] = agent;
        emit AgentSet(msg.sender, agent, epoch);
    }

    function post(Quote calldata q, bytes calldata sig) external {
        if (q.tokenIn == address(0) || q.tokenOut == address(0)) revert ZeroToken();
        if (q.tokenIn == q.tokenOut) revert InvalidPair();
        if (q.rateE18 == 0) revert InvalidRate();
        if (q.maxAmountIn == 0) revert ZeroMaxAmountIn();
        _admit(q.maker, q.expiry, q.epoch, q.nonce, q.inferenceId, quoteDigest(q), sig);
        _store(q.maker, q.tokenIn, q.tokenOut, q.rateE18, q.maxAmountIn, q.expiry, q.epoch, q.nonce, q.inferenceId);
    }

    function postPair(Pair calldata p, bytes calldata sig) external {
        if (p.token0 == address(0)) revert ZeroToken();
        if (p.token0 >= p.token1) revert InvalidPair();
        if (p.rate01E18 == 0 || p.rate10E18 == 0) revert InvalidRate();
        if (p.maxIn0 == 0 || p.maxIn1 == 0) revert ZeroMaxAmountIn();
        _admit(p.maker, p.expiry, p.epoch, p.nonce, p.inferenceId, pairDigest(p), sig);
        _store(p.maker, p.token0, p.token1, p.rate01E18, p.maxIn0, p.expiry, p.epoch, p.nonce, p.inferenceId);
        _store(p.maker, p.token1, p.token0, p.rate10E18, p.maxIn1, p.expiry, p.epoch, p.nonce, p.inferenceId);
    }

    function getQuote(address maker, address tokenIn, address tokenOut) external view returns (Posted memory) {
        return _posted[maker][tokenIn][tokenOut];
    }

    function getAgent(address maker) external view returns (address) {
        return _agentOf[maker];
    }

    function epochOf(address maker) external view returns (uint64) {
        return _epochOf[maker];
    }

    function lastNonce(address maker, uint64 epoch) external view returns (uint64) {
        return _lastNonce[maker][epoch];
    }

    /// @notice True when the stored quote was signed in the maker's current agent epoch by a live agent.
    function isQuoteCurrent(address maker, address tokenIn, address tokenOut) public view returns (bool) {
        uint64 epoch = _epochOf[maker];
        return epoch != 0 && _agentOf[maker] != address(0) && _posted[maker][tokenIn][tokenOut].epoch == epoch;
    }

    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    _QUOTE_TYPEHASH,
                    q.maker,
                    q.tokenIn,
                    q.tokenOut,
                    q.rateE18,
                    q.maxAmountIn,
                    q.expiry,
                    q.epoch,
                    q.nonce,
                    q.inferenceId
                )
            )
        );
    }

    function pairDigest(Pair calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(_PAIR_TYPEHASH, p)));
    }

    function _admit(
        address maker,
        uint64 expiry,
        uint64 epoch,
        uint64 nonce,
        bytes32 inferenceId,
        bytes32 digest,
        bytes calldata sig
    ) private {
        if (maker == address(0)) revert ZeroMaker();
        if (inferenceId == bytes32(0)) revert MissingInferenceId();
        if (expiry <= block.timestamp) revert QuoteExpired(expiry);
        uint64 maxExpiry = uint64(block.timestamp) + MAX_TTL;
        if (expiry > maxExpiry) revert TtlTooLong(expiry, maxExpiry);
        uint64 current = _epochOf[maker];
        if (epoch != current) revert WrongEpoch(epoch, current);
        uint64 previous = _lastNonce[maker][epoch];
        if (nonce <= previous) revert NonceNotIncreasing(nonce, previous);
        address agent = _agentOf[maker];
        if (agent == address(0) || !_validSignature(agent, digest, sig)) revert InvalidAgentSignature();
        _lastNonce[maker][epoch] = nonce;
    }

    /// @dev ECDSA first, then ERC-1271. An EIP-7702 delegated EOA carries code yet still signs with its key, so a
    /// code-length switch alone would reject it; a pure contract has no key whose address matches, so ECDSA cannot pass for it.
    function _validSignature(address agent, bytes32 digest, bytes calldata sig) private view returns (bool) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, sig);
        if (err == ECDSA.RecoverError.NoError && recovered == agent) return true;
        return agent.code.length != 0 && SignatureChecker.isValidERC1271SignatureNow(agent, digest, sig);
    }

    function _store(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 rateE18,
        uint256 maxAmountIn,
        uint64 expiry,
        uint64 epoch,
        uint64 nonce,
        bytes32 inferenceId
    ) private {
        _posted[maker][tokenIn][tokenOut] = Posted(rateE18, maxAmountIn, expiry, epoch, nonce, inferenceId);
        emit QuotePosted(maker, tokenIn, tokenOut, rateE18, maxAmountIn, expiry, epoch, nonce, inferenceId);
    }
}
