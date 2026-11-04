// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract AgentQuoteBoard is EIP712 {
    struct Quote {
        address maker;
        address tokenIn;
        address tokenOut;
        uint256 rateE18;
        uint64 expiry;
        uint64 nonce;
        bytes32 inferenceId;
    }

    bytes32 private constant _QUOTE_TYPEHASH = keccak256(
        "Quote(address maker,address tokenIn,address tokenOut,uint256 rateE18,uint64 expiry,uint64 nonce,bytes32 inferenceId)"
    );

    error ZeroMaker();
    error ZeroToken();
    error MissingInferenceId();
    error QuoteExpired(uint64 expiry);
    error InvalidPair();
    error InvalidRate();
    error InvalidAgentSignature();
    error NonceNotIncreasing(uint64 nonce, uint64 lastNonce);

    event AgentSet(address indexed maker, address indexed agent);
    event QuotePosted(
        address indexed maker,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 rateE18,
        uint64 expiry,
        bytes32 inferenceId
    );

    mapping(address maker => address agent) private _agentOf;
    mapping(address maker => uint64 nonce) private _lastNonce;
    mapping(address maker => mapping(address tokenIn => mapping(address tokenOut => Quote))) private _quotes;
    mapping(address => uint64) private _agentEpoch;
    mapping(address => mapping(address => mapping(address => uint64))) private _quoteEpoch;

    constructor() EIP712("Upkeep AgentQuoteBoard", "1") {}

    function setAgent(address agent) external {
        _agentOf[msg.sender] = agent;
        unchecked {
            ++_agentEpoch[msg.sender];
        }
        emit AgentSet(msg.sender, agent);
    }

    function post(Quote calldata q, bytes calldata sig) external {
        if (q.maker == address(0)) revert ZeroMaker();
        if (q.tokenIn == address(0) || q.tokenOut == address(0)) revert ZeroToken();
        if (q.tokenIn == q.tokenOut) revert InvalidPair();
        if (q.rateE18 == 0) revert InvalidRate();
        if (q.inferenceId == bytes32(0)) revert MissingInferenceId();
        if (q.expiry <= block.timestamp) revert QuoteExpired(q.expiry);

        uint64 previousNonce = _lastNonce[q.maker];
        if (q.nonce <= previousNonce) revert NonceNotIncreasing(q.nonce, previousNonce);
        address agent = _agentOf[q.maker];
        (address recovered,,) = ECDSA.tryRecover(quoteDigest(q), sig);
        if (agent == address(0) || recovered != agent) revert InvalidAgentSignature();

        _lastNonce[q.maker] = q.nonce;
        _quotes[q.maker][q.tokenIn][q.tokenOut] = q;
        _quoteEpoch[q.maker][q.tokenIn][q.tokenOut] = _agentEpoch[q.maker];
        emit QuotePosted(q.maker, q.tokenIn, q.tokenOut, q.rateE18, q.expiry, q.inferenceId);
    }

    function getQuote(address maker, address tokenIn, address tokenOut) external view returns (Quote memory) {
        return _quotes[maker][tokenIn][tokenOut];
    }

    function getAgent(address maker) external view returns (address) {
        return _agentOf[maker];
    }

    function lastNonce(address maker) external view returns (uint64) {
        return _lastNonce[maker];
    }

    function isQuoteCurrent(address maker, address tokenIn, address tokenOut) public view returns (bool) {
        return _agentEpoch[maker] != 0 && _quoteEpoch[maker][tokenIn][tokenOut] == _agentEpoch[maker];
    }

    function quoteDigest(Quote calldata q) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(_QUOTE_TYPEHASH, q.maker, q.tokenIn, q.tokenOut, q.rateE18, q.expiry, q.nonce, q.inferenceId)
        );
        return _hashTypedDataV4(structHash);
    }
}
