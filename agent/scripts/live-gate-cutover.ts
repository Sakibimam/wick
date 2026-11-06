// Moves the live Wick Aqua strategy behind a taker gate (1inch review: an ungated mainnet strategy is open to MEV).
// Deploys WickGate minted to the v4 hook and the maker, docks the live strategy, ships the same program prefixed with
// SwapVM opcode 0x0e (_onlyTakerTokenBalanceNonZero, deployed-router numbering) at the docked balances, points the hook at
// it, then proves the gate from chain: the maker quotes, a stranger reverts TakerTokenBalanceIsZero.
//
// DRY by default: reads and prints the plan. LIVE=1 sends, one receipt-checked tx at a time.
//   fork: anvil --fork-url <base rpc> --auto-impersonate; LIVE=1 BASE_RPC_URL=http://127.0.0.1:8545 bun run scripts/live-gate-cutover.ts
//   live: LIVE=1 BASE_RPC_URL=<rpc> bun --env-file=../contracts/.env run scripts/live-gate-cutover.ts
// Env: PK (maker key from contracts/.env; without it the maker is an unlocked account, i.e. an anvil fork), GATE (reuse an
// already deployed WickGate instead of deploying one). Prints the LiveOrder the worker's KV `cron-state.funding.live` takes.
import { concat, createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, http, parseAbi, parseAbiParameters, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { USDC, W0G } from "../src/price.js";
import { AQUA, AQUA_SWAPVM_ROUTER, harvestAbi, strategyHashOf, type LiveOrder, type OrderJson } from "../src/funding-machine.js";
import { quote as routerQuote } from "../src/taker.js";

const HOOK: Address = "0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888";
const GATE_OP = "0e14";
const STRANGER: Address = "0x000000000000000000000000000000000000dEaD";
const erc20 = parseAbi(["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const check = (ok: boolean, msg: string) => { if (!ok) throw new Error(`check failed: ${msg}`); };

async function main() {
  const rpcUrl = process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com";
  const live = JSON.parse(await Bun.file(new URL("../../web/worker/live-order-v2.json", import.meta.url).pathname).text());
  const old: OrderJson = live.order;
  const oldHash = strategyHashOf(old);
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const account = process.env.PK ? privateKeyToAccount(process.env.PK as Hex) : (old.maker as Address);
  const wallet = createWalletClient({ account, chain: base, transport: http(rpcUrl) });
  const maker = typeof account === "string" ? account : account.address;
  check(maker.toLowerCase() === old.maker.toLowerCase(), `signer ${maker} is not the maker ${old.maker}`);
  check(!old.data.slice(2).startsWith(GATE_OP), "live order is already gated");

  const [hookHash, [w0g, w0gCount], [usdc]] = await Promise.all([
    client.readContract({ address: HOOK, abi: harvestAbi, functionName: "orderHash" }),
    client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, oldHash, W0G] }),
    client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, oldHash, USDC] }),
  ]);
  console.log({ rpcUrl, maker, oldHash, hookHash, w0g: w0g.toString(), usdc: usdc.toString(), tokensCount: w0gCount });
  check(hookHash.toLowerCase() === oldHash.toLowerCase(), "hook does not point at the live order");
  check(w0gCount === 2, `live strategy tokensCount ${w0gCount}, expected 2 (shipped, not docked)`);

  const send = async (label: string, tx: Parameters<typeof wallet.sendTransaction>[0]) => {
    const hash = await wallet.sendTransaction(tx);
    const rc = await client.waitForTransactionReceipt({ hash, timeout: 120_000 });
    check(rc.status === "success", `${label} ${hash} reverted`);
    console.log(`${label} ${hash} gas ${rc.gasUsed}`);
    return { hash, rc };
  };
  const enc = (fn: "dock" | "ship" | "setOrder", args: readonly unknown[]) => ({ abi: harvestAbi, functionName: fn, args }) as never;

  if (process.env.LIVE !== "1") { console.log("DRY: set LIVE=1 to deploy the gate, dock, ship gated and repoint the hook"); return; }

  let gate = process.env.GATE as Address | undefined;
  if (!gate) {
    const art = JSON.parse(await Bun.file(new URL("../../hook/out/WickGate.sol/WickGate.json", import.meta.url).pathname).text());
    const data = concat([art.bytecode.object as Hex, encodeAbiParameters(parseAbiParameters("address[]"), [[HOOK, maker]])]);
    const { rc } = await send("deployGate", { data, account, chain: base } as never);
    gate = rc.contractAddress!;
  }
  const [hookHolds, makerHolds, supply] = await Promise.all([HOOK, maker].map((a) => client.readContract({ address: gate!, abi: erc20, functionName: "balanceOf", args: [a] })).concat(client.readContract({ address: gate, abi: erc20, functionName: "totalSupply" })));
  check(hookHolds === 1n && makerHolds === 1n && supply === 2n, `gate ${gate} holdings hook ${hookHolds} maker ${makerHolds} supply ${supply}`);

  const order: OrderJson = { maker: old.maker, traits: old.traits, data: `0x${GATE_OP}${gate.slice(2).toLowerCase()}${old.data.slice(2)}` as Hex };
  const hash = strategyHashOf(order);
  for (const [token, need] of [[W0G, w0g], [USDC, usdc]] as const) {
    const allowance = await client.readContract({ address: token, abi: erc20, functionName: "allowance", args: [maker, AQUA] });
    if (allowance < need) await send(`approve ${token}`, { to: token, data: encodeFunctionData({ abi: erc20, functionName: "approve", args: [AQUA, need] }), account, chain: base } as never);
  }

  const dock = await send("dock", { to: AQUA, data: encodeFunctionData(enc("dock", [AQUA_SWAPVM_ROUTER, oldHash, [W0G, USDC]])), account, chain: base } as never);
  const strategy = encodeAbiParameters(parseAbiParameters("(address maker,uint256 traits,bytes data)"), [{ maker: order.maker, traits: BigInt(order.traits), data: order.data }]);
  const ship = await send("ship", { to: AQUA, data: encodeFunctionData(enc("ship", [AQUA_SWAPVM_ROUTER, strategy, [W0G, USDC], [w0g, usdc]])), account, chain: base } as never);
  const set = await send("setOrder", { to: HOOK, data: encodeFunctionData(enc("setOrder", [{ maker: order.maker, traits: BigInt(order.traits), data: order.data }])), account, chain: base } as never);

  const [nowHook, [nw0g, ncount], [nusdc], [, oldCount]] = await Promise.all([
    client.readContract({ address: HOOK, abi: harvestAbi, functionName: "orderHash" }),
    client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, hash, W0G] }),
    client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, hash, USDC] }),
    client.readContract({ address: AQUA, abi: harvestAbi, functionName: "rawBalances", args: [maker, AQUA_SWAPVM_ROUTER, oldHash, W0G] }),
  ]);
  check(nowHook.toLowerCase() === hash.toLowerCase(), `hook points at ${nowHook}, expected ${hash}`);
  check(ncount === 2 && nw0g === w0g && nusdc === usdc, `gated strategy balances ${nw0g}/${nusdc} count ${ncount}`);
  check(oldCount === 0xff, `old strategy tokensCount ${oldCount}, expected 0xff (docked)`);

  const shipped = { maker: order.maker as Address, traits: BigInt(order.traits), data: order.data };
  const asMaker = await routerQuote(client as never, shipped, { tokenIn: USDC, tokenOut: W0G, amountIn: 1000n }).then((q) => `ok out ${q.amountOut}`, (e) => `reverted ${String(e).split("\n")[0]}`);
  const asStranger = await client.readContract({ address: AQUA_SWAPVM_ROUTER, abi: parseAbi(["function quote((address maker,uint256 traits,bytes data) order,address tokenIn,address tokenOut,uint256 amount,bytes takerTraitsAndData) view returns (uint256,uint256,bytes32)", "error TakerTokenBalanceIsZero(address taker,address token)"]), functionName: "quote", args: [shipped, USDC, W0G, 1000n, `0x${"0".repeat(40)}0041`], account: STRANGER }).then(() => "ok", (e) => String(e).includes("TakerTokenBalanceIsZero") ? "reverted TakerTokenBalanceIsZero" : `reverted other: ${String(e).split("\n")[0]}`);
  console.log({ asMaker, asStranger });
  check(asStranger === "reverted TakerTokenBalanceIsZero", "stranger quote was not refused by the gate");

  const next: LiveOrder = { order, hash, amounts: { w0g: w0g.toString(), usdc: usdc.toString() }, shipTx: ship.hash, shippedAt: new Date(Number((await client.getBlock({ blockNumber: ship.rc.blockNumber })).timestamp) * 1000).toISOString(), past: [oldHash] };
  console.log(JSON.stringify({ gate, txs: { dock: dock.hash, ship: ship.hash, setOrder: set.hash }, live: next }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
