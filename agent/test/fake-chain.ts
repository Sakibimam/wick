// An in-memory Base + 0G for cronTick: every viem call goes through a JSON-RPC transport that decodes eth_call against the
// real ABIs and answers from state, and every signed tx is parsed back so a test asserts on exactly what would be broadcast.
import { createPublicClient, custom, decodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, parseTransaction, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { boardV2Abi } from "../src/poster.js";
import { harvestAbi } from "../src/funding-machine.js";
import { oracleAbi, poolAbi, quoterAbi, USDC, W0G } from "../src/price.js";
import { fundingAbi } from "../src/funding.js";
import { AQUA, ZERO_G_CHAIN, type CronState, type TickEnv } from "../src/worker-tick.js";

export const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;
export const AGENT = privateKeyToAccount(PK).address;
export const BOARD: Address = "0x0d87944FFFf253dBbbD07750AceE7898333218A5";
export const ROUTER: Address = "0x111111338c5091E8440b67B168bAe16a668AC0De";
export const LIVE_HASH = "0x05bc438b60860b593d7278d8d64653302a9d314beb0275e9103d5a0c3cbbc035" as Hex;
const lc = (a: string) => a.toLowerCase();
const TWAP_TICK = -295490;
const sqrtX96 = (p: number) => BigInt(Math.floor(Math.sqrt(p) * 2 ** 48)) * (1n << 48n);

const extra = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function getFee(uint64,(bytes receiver,bytes data,(address token,uint256 amount)[] tokenAmounts,address feeToken,bytes extraArgs)) view returns (uint256)",
]);
const items = new Map<string, AbiFunction>();
for (const it of [...harvestAbi, ...boardV2Abi, ...poolAbi, ...oracleAbi, ...quoterAbi, ...extra, ...fundingAbi.router, ...fundingAbi.erc20, ...fundingAbi.payment] as Abi) if (it.type === "function") items.set(toFunctionSelector(it), it);

export type Quote = { rateE18: bigint; maxAmountIn: bigint; expiry: bigint; epoch: bigint; nonce: bigint; inferenceId: Hex };
export type Sent = { chainId: number; to: Address; value: bigint; data: Hex; fn: string; args: readonly unknown[] };
export type Log = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; transactionIndex: number; logIndex: number; transactionHash: Hex };

export function fakeChain() {
  const st = {
    block: 1_000_000n,
    ethWei: 2n * 10n ** 18n,
    wallet: { w0g: 2n * 10n ** 18n, usdc: 10_000_000n },
    slots: new Map<string, { w0g: bigint; usdc: bigint; tokensCount: number }>([[lc(LIVE_HASH), { w0g: 10n ** 18n, usdc: 5_000_000n, tokensCount: 2 }]]),
    quotes: new Map<string, Quote>(),
    epoch: 1n, lastNonce: 0n,
    ccipFee: null as bigint | null,
    vault: 2n * 10n ** 18n,
    twapTick: TWAP_TICK,
    logs: [] as Log[],
    receipts: new Map<string, { blockNumber: bigint; transactionIndex: number; status: "success" | "reverted" }>(),
    sent: [] as Sent[],
    /** Historical rawBalances, keyed by `${hash}:${block}`: what a dock-time read at an older block returns. */
    history: new Map<string, { w0g: bigint; usdc: bigint; tokensCount: number }>(),
    nonce: 0,
  };
  const call = (to: Address, data: Hex, block?: bigint): unknown => {
    const item = items.get(data.slice(0, 10));
    if (!item) throw new Error(`no abi for ${data.slice(0, 10)} at ${to}`);
    const args = (decodeFunctionData({ abi: [item], data }).args ?? []) as readonly any[];
    const a = lc(to), fn = item.name;
    if (fn === "token0") return W0G;
    if (fn === "token1") return USDC;
    if (fn === "fee") return 3000;
    if (fn === "liquidity") return 10n ** 20n;
    if (fn === "slot0") return a === lc("0xd0b53D9277642d899DF5C87A3966A349A798F224") ? [sqrtX96(3000e-12), 0, 0, 0, 0, 0, true] : [sqrtX96(1.0001 ** st.twapTick), st.twapTick, 0, 0, 0, 0, true];
    if (fn === "observe") return [[0n, BigInt(st.twapTick) * 600n], [0n, 0n]];
    if (fn === "getQuote") return st.quotes.get(`${lc(args[1])}:${lc(args[2])}`) ?? { rateE18: 0n, maxAmountIn: 0n, expiry: 0n, epoch: 0n, nonce: 0n, inferenceId: `0x${"0".repeat(64)}` };
    if (fn === "epochOf") return st.epoch;
    if (fn === "getAgent") return AGENT;
    if (fn === "lastNonce") return st.lastNonce;
    if (fn === "rawBalances") {
      const h = lc(args[2]), sl = (block !== undefined ? st.history.get(`${h}:${block}`) : undefined) ?? st.slots.get(h) ?? { w0g: 0n, usdc: 0n, tokensCount: 0 };
      return [lc(args[3]) === lc(W0G) ? sl.w0g : sl.usdc, sl.tokensCount];
    }
    if (fn === "orderHash") return LIVE_HASH;
    if (fn === "balanceOf") return a === lc(W0G) ? st.wallet.w0g : a === lc(USDC) ? st.wallet.usdc : a === lc("0xA3b15Bd2aD18BFB6b5f92D8AA9F444Dd59d1cE32") ? st.vault : 0n;
    if (fn === "allowance") return 10n ** 30n;
    if (fn === "getFee") { if (st.ccipFee === null) throw new Error("execution reverted"); return st.ccipFee; }
    if (fn === "quoteExactInputSingle") return [10n ** 18n, 0n, 0, 0n];
    throw new Error(`unhandled ${fn}`);
  };
  const block = () => ({ number: `0x${st.block.toString(16)}`, hash: `0x${st.block.toString(16).padStart(64, "0")}`, parentHash: `0x${"0".repeat(64)}`, timestamp: "0x1", baseFeePerGas: "0x5b8d80", gasLimit: "0x1c9c380", gasUsed: "0x0", miner: `0x${"0".repeat(40)}`, transactions: [], difficulty: "0x0", extraData: "0x", logsBloom: `0x${"0".repeat(512)}`, nonce: "0x0000000000000000", receiptsRoot: `0x${"0".repeat(64)}`, sha3Uncles: `0x${"0".repeat(64)}`, size: "0x1", stateRoot: `0x${"0".repeat(64)}`, transactionsRoot: `0x${"0".repeat(64)}`, uncles: [] });
  const onSend = (s: Sent) => {
    if (s.fn === "postPair") {
      const p = s.args[0] as any;
      st.lastNonce = p.nonce;
      st.quotes.set(`${lc(p.token0)}:${lc(p.token1)}`, { rateE18: p.rate01E18, maxAmountIn: p.maxIn0, expiry: p.expiry, epoch: p.epoch, nonce: p.nonce, inferenceId: p.inferenceId });
      st.quotes.set(`${lc(p.token1)}:${lc(p.token0)}`, { rateE18: p.rate10E18, maxAmountIn: p.maxIn1, expiry: p.expiry, epoch: p.epoch, nonce: p.nonce, inferenceId: p.inferenceId });
    }
  };
  const rpc = (chainId: number) => custom({
    async request({ method, params }: { method: string; params?: any }) {
      const p = (params ?? []) as any[];
      switch (method) {
        case "eth_chainId": return `0x${chainId.toString(16)}`;
        case "eth_blockNumber": return `0x${st.block.toString(16)}`;
        case "eth_gasPrice": return "0x5b8d80";
        case "eth_maxPriorityFeePerGas": return "0x1";
        case "eth_estimateGas": return "0x30d40";
        case "eth_getTransactionCount": return `0x${st.nonce.toString(16)}`;
        case "eth_getBalance": return chainId === 8453 ? `0x${st.ethWei.toString(16)}` : `0x${(10n ** 18n).toString(16)}`;
        case "eth_getBlockByNumber": return block();
        case "eth_call": {
          const tag = p[1];
          const b = typeof tag === "string" && tag.startsWith("0x") ? BigInt(tag) : undefined;
          try {
            const res = call(getAddress(p[0].to), p[0].data, b);
            const item = items.get(String(p[0].data).slice(0, 10))!;
            return encodeFunctionResult({ abi: [item], functionName: item.name, result: res as never });
          } catch (e) { throw Object.assign(new Error((e as Error).message), { code: 3 }); }
        }
        case "eth_sendRawTransaction": {
          const tx = parseTransaction(p[0]);
          const item = tx.data && tx.data.length >= 10 ? items.get(tx.data.slice(0, 10)) : undefined;
          const d = item ? decodeFunctionData({ abi: [item], data: tx.data! }) : null;
          const s: Sent = { chainId, to: getAddress(tx.to!), value: tx.value ?? 0n, data: tx.data ?? "0x", fn: d?.functionName ?? "", args: (d?.args ?? []) as readonly unknown[] };
          st.sent.push(s); st.nonce++;
          onSend(s);
          const hash = keccak256(p[0]);
          st.receipts.set(hash, { blockNumber: st.block, transactionIndex: 0, status: "success" });
          return hash;
        }
        case "eth_getTransactionReceipt": {
          const r = st.receipts.get(p[0]);
          if (!r) return null;
          return { transactionHash: p[0], blockHash: `0x${"1".repeat(64)}`, blockNumber: `0x${r.blockNumber.toString(16)}`, transactionIndex: `0x${r.transactionIndex.toString(16)}`, from: AGENT, to: BOARD, cumulativeGasUsed: "0x1", gasUsed: "0x14000", effectiveGasPrice: "0x5b8d80", status: r.status === "success" ? "0x1" : "0x0", logs: [], logsBloom: `0x${"0".repeat(512)}`, type: "0x2", contractAddress: null };
        }
        case "eth_getLogs": {
          const f = p[0] as { address?: string | string[]; fromBlock?: string; toBlock?: string; topics?: (string | string[] | null)[] };
          const from = f.fromBlock && f.fromBlock.startsWith("0x") ? BigInt(f.fromBlock) : 0n, to = f.toBlock && f.toBlock.startsWith("0x") ? BigInt(f.toBlock) : st.block;
          const addrs = f.address === undefined ? null : (Array.isArray(f.address) ? f.address : [f.address]).map(lc);
          return st.logs.filter((l) => l.blockNumber >= from && l.blockNumber <= to && (!addrs || addrs.includes(lc(l.address))) && (f.topics ?? []).every((t, i) => t === null || (Array.isArray(t) ? t.map(lc).includes(lc(l.topics[i] ?? "")) : lc(t) === lc(l.topics[i] ?? ""))))
            .map((l) => ({ address: l.address, topics: l.topics, data: l.data, blockNumber: `0x${l.blockNumber.toString(16)}`, transactionIndex: `0x${l.transactionIndex.toString(16)}`, logIndex: `0x${l.logIndex.toString(16)}`, transactionHash: l.transactionHash, blockHash: `0x${"1".repeat(64)}`, removed: false }));
        }
        default: throw new Error(`unhandled rpc ${method}`);
      }
    },
  });
  const baseT = rpc(8453), zgT = rpc(16661);
  const chain = { ...base, fees: { maxPriorityFeePerGas: 1_000_000n } };
  const env = (over: Partial<TickEnv> = {}): TickEnv => ({
    base: createPublicClient({ chain, transport: baseT, pollingInterval: 10 }) as never,
    zeroG: createPublicClient({ chain: ZERO_G_CHAIN, transport: zgT }) as never,
    chain: chain as never, baseRpcUrl: "http://fake", baseTransport: baseT, zeroGTransport: zgT,
    board: BOARD, aquaApp: ROUTER, strategyHash: LIVE_HASH, maker: AGENT, agent: AGENT, spendCapPerDayWei: 10n ** 18n,
    agentPk: PK, zgApiKey: "test-key", fetchImpl: router(), ...over,
  });
  return { st, env };
}

/** A 0G router stand-in: returns the decision JSON with a verified TEE trace; `decide` can vary it per call. */
export function router(decide: () => unknown = () => ({ spreadBps: 40, skewBps: 10, bidHalfSpreadBps: 60, askHalfSpreadBps: 40, maxAmountInUsdc: 0.05, ttlSeconds: 900, reason: "steady tape, W0G heavy: ask tighter than bid" })) {
  let n = 0;
  return (async () => Response.json({ choices: [{ message: { content: JSON.stringify(decide()) } }], x_0g_trace: { request_id: `rid-${++n}`, tee_verified: true, provider: "0xprov", billing: { currency: "0g", total_cost: "1000" } } })) as unknown as typeof fetch;
}

/** The KV state of a tick that already posted at `nowSec` and holds a steady mid. */
export function postedState(prev: CronState, nowMs: number, mid: number): CronState { return { ...prev, lastMid: mid, quotedAt: nowMs }; }
export { AQUA };
