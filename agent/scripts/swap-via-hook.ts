// Swaps USDC for W0G through Wick's Uniswap v4 pool on Base. The pool's hook (AquaAggregatorHook) fills the swap from the
// Wick 1inch Aqua strategy, priced by the agent's live board quote. Path: Universal Router V4_SWAP with
// SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL, the same encoding hook/test/Base.sol drives on a fork.
//
// DRY by default: simulates with eth_call and prints the plan. LIVE=1 sends.
//   dry : bun --env-file=../contracts/.env run scripts/swap-via-hook.ts
//   live: LIVE=1 BASE_RPC_URL=<rpc> bun --env-file=../contracts/.env run scripts/swap-via-hook.ts
// Env: PK (taker key, from contracts/.env; without it the taker is an unlocked account, i.e. an anvil fork),
// TAKER, AMOUNT_IN (atomic USDC, default 50000), SLIPPAGE_BPS (default 100), FORCE=1 (go on after a failed pre-flight read,
// to show the swap itself fails closed).
import { BaseError, concat, createPublicClient, createWalletClient, decodeEventLog, encodeAbiParameters, formatUnits, getAddress, http, keccak256, pad, parseAbi, parseAbiItem, parseAbiParameters, toFunctionSelector, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const HOOK: Address = "0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888";
const POOL_MANAGER: Address = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
// Uniswap v4 Universal Router and Permit2 on Base (docs.uniswap.org/contracts/v4/deployments), both checked with `cast code`.
const UNIVERSAL_ROUTER: Address = "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40";
const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const W0G: Address = "0x23cd099eB438CcA50349EE2BC809196b1ae00861";
const USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AQUA: Address = "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a";
const AQUA_ROUTER: Address = "0x111111338c5091E8440b67B168bAe16a668AC0De";
const MAKER: Address = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953";
const EXTRUCTION: Address = "0xEE1374852327Da76Fd04CA5f681C875E3e8e9cf4";
const ORDER_HASH: Hex = "0x05bc438b60860b593d7278d8d64653302a9d314beb0275e9103d5a0c3cbbc035";
// The pool was initialised with fee 0, tickSpacing 1 (Initialize event of tx 0xee9b8414...); PoolId = keccak256(abi.encode(PoolKey)).
const POOL_KEY = { currency0: W0G, currency1: USDC, fee: 0, tickSpacing: 1, hooks: HOOK } as const;
const POOL_ID = keccak256(encodeAbiParameters(parseAbiParameters("address,address,uint24,int24,address"), [W0G, USDC, 0, 1, HOOK]));

const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE_ALL = 0x0c, TAKE_ALL = 0x0f, V4_SWAP = 0x10;

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"]);
const permit2 = parseAbi(["function allowance(address,address,address) view returns (uint160 amount,uint48 expiration,uint48 nonce)", "function approve(address token,address spender,uint160 amount,uint48 expiration)"]);
const hookAbi = parseAbi(["function quote(bool zeroToOne,int256 amountSpecified,bytes32 poolId) returns (uint256)", "function orderHash() view returns (bytes32)", "function poolManager() view returns (address)", "function router() view returns (address)"]);
const boardAbi = parseAbi(["function getQuote(address maker,address tokenIn,address tokenOut) view returns ((uint256 rateE18,uint256 maxAmountIn,uint64 expiry,uint64 epoch,uint64 nonce,bytes32 inferenceId))"]);
const urAbi = parseAbi(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);
const aquaAbi = parseAbi(["function safeBalances(address maker,address app,bytes32 strategyHash,address token0,address token1) view returns (uint256,uint256)"]);
const extructionAbi = parseAbi(["function board() view returns (address)"]);
const swappedEvent = parseAbiItem("event Swapped(bytes32 orderHash,address maker,address taker,address tokenIn,address tokenOut,uint256 amountIn,uint256 amountOut)");
const pmSwapEvent = parseAbiItem("event Swap(bytes32 indexed id,address indexed sender,int128 amount0,int128 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick,uint24 fee)");

// Errors a failed swap can carry. The Universal Router and PoolManager wrap them, so match the selector anywhere in the revert data.
const KNOWN_ERRORS = ["StaleQuote()", "QuoteExpired(uint64)", "ExceedsAquaBalance(uint256,uint256)", "V4TooLittleReceived(uint256,uint256)", "TransferFromFailed()", "TokensNotSupported(address,address)", "WrappedError(address,bytes4,bytes,bytes)", "ExecutionFailed(uint256,bytes)"]
  .map(sig => ({ sig, selector: toFunctionSelector(`error ${sig}`).slice(2).toLowerCase() }));

function revertReason(e: unknown): string {
  const data = e instanceof BaseError ? (e.walk(x => typeof (x as { data?: unknown }).data === "string") as { data?: string } | null)?.data : undefined;
  const hay = (data ?? "").toLowerCase();
  const hits = KNOWN_ERRORS.filter(k => hay.includes(k.selector)).map(k => k.sig);
  const short = e instanceof BaseError ? e.shortMessage : String(e);
  return `${hits.length ? hits.join(" + ") : "unrecognised"} | ${short} | data=${data ?? "none"}`;
}

const rpcUrl = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
const live = process.env.LIVE === "1", force = process.env.FORCE === "1";
const pk = process.env.PK ? (process.env.PK.startsWith("0x") ? process.env.PK : `0x${process.env.PK}`) as Hex : undefined;
const local = pk ? privateKeyToAccount(pk) : undefined;
const taker = getAddress(local?.address ?? process.env.TAKER ?? "0x39ef83fbB0BA61A5b4169fF5ce21Fd89e25aab37");
const client = createPublicClient({ chain: base, transport: http(rpcUrl), pollingInterval: 250 });
const wallet = createWalletClient({ chain: base, transport: http(rpcUrl), account: local ?? taker });

// keccak(key . slot) nested for mappings: slotOf(slot, k1, k2) = keccak(k2 . keccak(k1 . slot)).
const word = (a: Address) => pad(a, { size: 32 });
const num = (n: bigint | number) => pad(toHex(n), { size: 32 });
const mapSlot = (slot: number, ...keys: Address[]) => keys.reduce<Hex>((inner, key) => keccak256(concat([word(key), inner])), num(slot));

async function main() {
  if ((await client.getChainId()) !== 8453) throw new Error("RPC is not Base (chainId 8453)");
  const head = await client.getBlock();
  console.log(`mode=${live ? "LIVE" : "DRY"} rpc=${new URL(rpcUrl).host} block=${head.number} ts=${head.timestamp} taker=${taker}`);

  // 1. Read the live quote first.
  const [orderHash, pm, router, board] = await Promise.all([
    client.readContract({ address: HOOK, abi: hookAbi, functionName: "orderHash" }),
    client.readContract({ address: HOOK, abi: hookAbi, functionName: "poolManager" }),
    client.readContract({ address: HOOK, abi: hookAbi, functionName: "router" }),
    client.readContract({ address: EXTRUCTION, abi: extructionAbi, functionName: "board" }),
  ]);
  if (orderHash !== ORDER_HASH || pm !== POOL_MANAGER || router !== AQUA_ROUTER) throw new Error(`hook wiring differs from the Wick deployment: order=${orderHash} pm=${pm} router=${router}`);
  const q = await client.readContract({ address: board, abi: boardAbi, functionName: "getQuote", args: [MAKER, USDC, W0G] });
  const left = Number(q.expiry) - Number(head.timestamp);
  console.log(`board ${board} quote USDC->W0G rateE18=${q.rateE18} maxAmountIn=${q.maxAmountIn} expiry=${q.expiry} (${left}s left) inferenceId=${q.inferenceId}`);
  if (left <= 0 && !force) throw new Error(`board quote expired ${-left}s ago: wait for the cron to repost, or FORCE=1 to watch the swap fail closed`);

  const requested = BigInt(process.env.AMOUNT_IN || "50000");
  const amountIn = requested < q.maxAmountIn ? requested : q.maxAmountIn;
  let expectedOut = 0n;
  try {
    expectedOut = (await client.simulateContract({ address: HOOK, abi: hookAbi, functionName: "quote", args: [false, -amountIn, POOL_ID] })).result;
  } catch (e) {
    if (!force) throw new Error(`hook.quote reverted: ${revertReason(e)}`);
    console.log(`hook.quote reverted (FORCE=1, sending anyway): ${revertReason(e)}`);
  }
  const slippageBps = BigInt(process.env.SLIPPAGE_BPS || "100");
  const minOut = expectedOut * (10_000n - slippageBps) / 10_000n;
  console.log(`amountIn=${amountIn} (${formatUnits(amountIn, 6)} USDC, cap ${q.maxAmountIn}) hookQuoteOut=${expectedOut} minOut=${minOut} (-${slippageBps}bps) poolId=${POOL_ID}`);

  // 2. Approvals USDC -> Permit2 -> UniversalRouter, only when short.
  const [bal, erc20Allow, p2] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [taker] }),
    client.readContract({ address: USDC, abi: erc20, functionName: "allowance", args: [taker, PERMIT2] }),
    client.readContract({ address: PERMIT2, abi: permit2, functionName: "allowance", args: [taker, USDC, UNIVERSAL_ROUTER] }),
  ]);
  const needErc20 = erc20Allow < amountIn;
  const needP2 = p2[0] < amountIn || p2[1] <= Number(head.timestamp);
  console.log(`taker USDC=${bal} erc20->Permit2=${erc20Allow}${needErc20 ? " (short)" : ""} permit2->UR=${p2[0]} exp=${p2[1]}${needP2 ? " (short)" : ""}`);
  if (live && bal < amountIn) throw new Error(`taker holds ${bal} atomic USDC, needs ${amountIn}`);

  const swapParams = encodeAbiParameters(
    parseAbiParameters("((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData) params"),
    [{ poolKey: POOL_KEY, zeroForOne: false, amountIn, amountOutMinimum: minOut, minHopPriceX36: 0n, hookData: "0x" }]);
  const actions = toHex(new Uint8Array([SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL]));
  const v4Input = encodeAbiParameters(parseAbiParameters("bytes actions,bytes[] params"), [actions, [
    swapParams,
    encodeAbiParameters(parseAbiParameters("address,uint256"), [USDC, amountIn]),
    encodeAbiParameters(parseAbiParameters("address,uint256"), [W0G, minOut]),
  ]]);
  const exec = { address: UNIVERSAL_ROUTER, abi: urAbi, functionName: "execute", args: [toHex(new Uint8Array([V4_SWAP])), [v4Input], head.timestamp + 300n], account: taker } as const;

  if (!live) {
    // Dry run: eth_call with the taker's balance and approvals overridden where short, so an empty wallet still rehearses the fill.
    const usdcDiff = [] as { slot: Hex; value: Hex }[];
    if (bal < amountIn) usdcDiff.push({ slot: mapSlot(9, taker), value: num(amountIn) }); // FiatToken balanceAndBlacklistStates
    if (needErc20) usdcDiff.push({ slot: mapSlot(10, taker, PERMIT2), value: num(amountIn) }); // FiatToken allowed[owner][spender]
    const overrides = [{ address: PERMIT2, stateDiff: [{ slot: mapSlot(1, taker, USDC, UNIVERSAL_ROUTER), value: num((BigInt(head.timestamp + 3600n) << 160n) | amountIn) }] }, // Permit2 allowance: amount | expiration<<160
      ...(usdcDiff.length ? [{ address: USDC, stateDiff: usdcDiff }] : [])];
    try {
      await client.simulateContract({ ...exec, stateOverride: overrides });
      console.log("DRY simulate OK (taker balance and allowances overridden where short, nothing sent). Set LIVE=1 to send.");
    } catch (e) {
      console.log(`DRY simulate REVERTED: ${revertReason(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  const send = async (address: Address, abi: typeof erc20 | typeof permit2, functionName: string, args: unknown[]) => {
    const hash = await wallet.writeContract({ address, abi, functionName, args, chain: base } as never);
    const r = await client.waitForTransactionReceipt({ hash, retryCount: 20, retryDelay: 500 });
    if (r.status !== "success") throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  };
  if (needErc20) console.log(`approve USDC->Permit2 ${await send(USDC, erc20, "approve", [PERMIT2, amountIn])}`);
  if (needP2) console.log(`permit2 approve UR ${await send(PERMIT2, permit2, "approve", [USDC, UNIVERSAL_ROUTER, amountIn, Number(head.timestamp) + 3600])}`);

  const read = async () => ({
    usdc: await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [taker] }),
    w0g: await client.readContract({ address: W0G, abi: erc20, functionName: "balanceOf", args: [taker] }),
    aqua: await client.readContract({ address: AQUA, abi: aquaAbi, functionName: "safeBalances", args: [MAKER, AQUA_ROUTER, ORDER_HASH, W0G, USDC] }),
  });
  const before = await read();
  let hash: Hex;
  try {
    hash = await wallet.writeContract({ ...exec, chain: base } as never);
  } catch (e) {
    console.log(`SWAP REVERTED at gas estimation, nothing sent: ${revertReason(e)}`);
    process.exitCode = 1;
    return;
  }
  const r = await client.waitForTransactionReceipt({ hash, retryCount: 20, retryDelay: 500 });
  if (r.status !== "success") {
    // The receipt carries no reason; replaying the call at the same state does.
    const why = await client.simulateContract(exec).then(() => "replay did not revert", revertReason);
    console.log(`SWAP REVERTED on chain: ${hash} gasUsed=${r.gasUsed}: ${why}`);
    process.exitCode = 1;
    return;
  }
  const after = await read();

  console.log(`tx ${hash} gasUsed=${r.gasUsed} block=${r.blockNumber}`);
  console.log(`USDC in ${before.usdc - after.usdc} | W0G out ${after.w0g - before.w0g} (${formatUnits(after.w0g - before.w0g, 18)} W0G) | hook quote ${expectedOut} | minOut ${minOut}`);
  console.log(`Aqua safeBalances (W0G,USDC): ${before.aqua[0]},${before.aqua[1]} -> ${after.aqua[0]},${after.aqua[1]}`);
  let sawSwapped = false, sawPm = false;
  for (const log of r.logs) {
    try {
      if (log.address.toLowerCase() === AQUA_ROUTER.toLowerCase()) {
        const a = decodeEventLog({ abi: [swappedEvent], data: log.data, topics: log.topics }).args;
        sawSwapped = a.maker.toLowerCase() === MAKER.toLowerCase() && a.orderHash === ORDER_HASH;
        console.log(`SwapVM Swapped maker=${a.maker} orderHash=${a.orderHash} taker=${a.taker} (hook=${a.taker.toLowerCase() === HOOK.toLowerCase()}) in=${a.amountIn} out=${a.amountOut}`);
      } else if (log.address.toLowerCase() === POOL_MANAGER.toLowerCase()) {
        const a = decodeEventLog({ abi: [pmSwapEvent], data: log.data, topics: log.topics }).args;
        if (a.id !== POOL_ID) continue;
        sawPm = true;
        console.log(`PoolManager Swap id=${a.id} amount0=${a.amount0} amount1=${a.amount1} fee=${a.fee}`);
      }
    } catch { /* another event from the same contract */ }
  }
  if (!sawSwapped || !sawPm || after.w0g <= before.w0g) throw new Error("post-condition failed: no Aqua Swapped event for the Wick order, no PoolManager Swap for the hook pool, or no W0G received");
  console.log("POST-CONDITION OK: taker W0G rose, Aqua strategy balances moved, Swapped names the Wick maker and order hash");
}

main().catch(e => { console.error(`FAIL: ${e instanceof Error ? e.message : e}`); process.exit(1); });
