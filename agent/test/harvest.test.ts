import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, decodeFunctionData, getAddress, parseAbiParameters, type Address, type Hex } from "viem";
import { AQUA, AQUA_SWAPVM_ROUTER, decideHarvest, emptyFundingState, fundingTick, harvestAbi, PENDING_TIMEOUT_MS, saltedOrder, strategyHashOf, type AquaSlot, type FundingCtx, type FundingState, type LiveOrder } from "../src/funding-machine.js";
import { fundingAbi } from "../src/funding.js";
import { USDC, W0G } from "../src/price.js";
import live from "../../web/worker/live-order-v2.json";

const E18 = 10n ** 18n;
const agent = getAddress("0x00000000000000000000000000000000000000a1"), HOOK = getAddress("0x1A35d13AE02a834E9b35A98cA1b9C87b30d72888");
const liveOrder: LiveOrder = { order: { maker: live.order.maker as Address, traits: live.order.traits as Hex, data: live.order.data as Hex }, hash: live.strategyHash as Hex, amounts: live.amounts, shipTx: null, shippedAt: null, past: [] };
const FROM = live.strategyHash.toLowerCase() as Hex;
const lc = (h: string) => h.toLowerCase();

/** A chain stand-in that applies each sent tx the way Aqua, the ERC-20s and the hook would, so post-conditions are real reads. */
function chain(over: { commitment?: { w0g: bigint; usdc: bigint }; wallet?: { w0g: bigint; usdc: bigint }; allowance?: bigint } = {}) {
  const c = over.commitment ?? { w0g: 10n * E18, usdc: 50_000_000n };
  const st = { slots: new Map<string, AquaSlot>([[FROM, { ...c, tokensCount: 2 }]]), allowance: { [lc(W0G)]: over.allowance ?? 10n ** 30n, [lc(USDC)]: over.allowance ?? 10n ** 30n } as Record<string, bigint>, hook: FROM as Hex, receipt: "success" as "success" | "reverted" | null, apply: true, sent: [] as { to: Address; data: Hex }[], wallet: { ...(over.wallet ?? { w0g: 12n * E18, usdc: 60_000_000n }), ethWei: 2n * 10n ** 14n } };
  const apply = (to: Address, data: Hex) => {
    if (lc(to) === lc(AQUA)) {
      const d = decodeFunctionData({ abi: harvestAbi, data });
      if (d.functionName === "dock") { const sl = st.slots.get(lc(d.args[1] as Hex))!; if (sl.tokensCount !== 2) throw new Error("DockingShouldCloseAllTokens"); sl.tokensCount = 0xff; }
      if (d.functionName === "ship") {
        const [o] = decodeAbiParameters(parseAbiParameters("(address maker,uint256 traits,bytes data)"), d.args[1] as Hex);
        const h = lc(strategyHashOf({ maker: o.maker, traits: `0x${o.traits.toString(16).padStart(64, "0")}` as Hex, data: o.data }));
        if (st.slots.has(h)) throw new Error("StrategiesMustBeImmutable");
        const [w, u] = d.args[3] as readonly bigint[];
        st.slots.set(h, { w0g: w!, usdc: u!, tokensCount: 2 });
      }
    } else if (lc(to) === lc(HOOK)) {
      const d = decodeFunctionData({ abi: harvestAbi, data }); const o = (d.args as any)[0];
      st.hook = lc(strategyHashOf({ maker: o.maker, traits: `0x${BigInt(o.traits).toString(16).padStart(64, "0")}` as Hex, data: o.data })) as Hex;
    } else { const d = decodeFunctionData({ abi: fundingAbi.erc20, data }); st.allowance[lc(to)] = d.args[1] as bigint; }
  };
  const io = {
    send: async (tx: { to: Address; data: Hex }) => { st.sent.push(tx); if (st.apply) apply(tx.to, tx.data); return `0x${st.sent.length.toString(16).padStart(64, "0")}` as Hex; },
    receipt: async () => st.receipt, readAllowance: async (token: Address) => st.allowance[lc(token)]!,
    readZeroGW0g: async () => 0n, readZeroGNative: async () => 0n, quoteSwapUsdcToW0g: async () => 0n, quoteSwapUsdcToEth: async () => 0n,
  };
  const hio = { aquaSlot: async (h: Hex) => st.slots.get(lc(h)) ?? { w0g: 0n, usdc: 0n, tokensCount: 0 }, hookOrderHash: async () => st.hook };
  const ctx = (s: FundingState, now: number, fees: { w0g: bigint; usdc: bigint }): FundingCtx => {
    const cur = s.live ?? liveOrder, slot = st.slots.get(lc(cur.hash))!;
    return {
      now, io: io as never, agent, agentOwner: agent, zeroGGasReserveWei: 0n,
      decision: { accrued: { usdc: fees.usdc, w0g: fees.w0g }, wallet: st.wallet, strategy: { w0g: slot.w0g, usdc: slot.usdc }, mid: 0.15, ethUsd: 3000, ccipFeeWei: 110_000_000_000_000n, baseGasPriceWei: 6_000_000n, zeroGGasUsdc: 0.01, k: 3, gasTopUpBelowWei: 5n * 10n ** 13n, gasShareBps: 5000, maxSpendWeiPerRun: 3n * 10n ** 14n },
      harvest: { live: cur, hook: HOOK, gasFloorWei: 3n * 10n ** 13n, commitment: slot.tokensCount === 2 ? { w0g: slot.w0g, usdc: slot.usdc } : null, fees: s.live ? { w0g: 0n, usdc: 0n } : fees, io: hio },
    };
  };
  return { st, ctx };
}
const FEES = { w0g: E18 / 2n, usdc: 2_000_000n };

async function drive(c: ReturnType<typeof chain>, s0 = emptyFundingState(), fees = FEES, ticks = 12) {
  let s = s0, now = 1_800_000_000_000; const actions: string[] = [];
  for (let i = 0; i < ticks; i++) { const r = await fundingTick(s, c.ctx(s, now, fees)); s = r.state; actions.push(r.action); now += 300_000; if (r.action.startsWith("harvested")) break; }
  return { s, actions };
}

describe("harvest order", () => {
  test("strategyHashOf reproduces the live v2 strategy hash read from Base", () => { expect(lc(strategyHashOf(liveOrder.order))).toBe(FROM); });
  test("salt is one no-op instruction ahead of the unchanged program, replaced on every re-ship, never stacked", () => {
    const a = saltedOrder(liveOrder.order, 1n), b = saltedOrder(a, 2n);
    expect(a.data).toBe(`0x14080000000000000001${live.order.data.slice(2)}` as Hex);
    expect(b.data).toBe(`0x14080000000000000002${live.order.data.slice(2)}` as Hex);
    expect([a.maker, a.traits]).toEqual([liveOrder.order.maker, liveOrder.order.traits]);
    expect(new Set([FROM, lc(strategyHashOf(a)), lc(strategyHashOf(b))]).size).toBe(3);
  });
});

describe("decideHarvest", () => {
  const base = { commitment: { w0g: 10n * E18, usdc: 50_000_000n }, fees: FEES, wallet: { w0g: 12n * E18, usdc: 60_000_000n, ethWei: 2n * 10n ** 14n }, mid: 0.15, ethUsd: 3000, baseGasPriceWei: 6_000_000n, k: 3, gasFloorWei: 3n * 10n ** 13n, maxSpendWeiPerRun: 3n * 10n ** 14n };
  // Deterministic LCG so a failure reproduces.
  let seed = 7n; const rnd = (max: bigint) => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n); return max === 0n ? 0n : seed % (max + 1n); };
  const cases = Array.from({ length: 2000 }, () => ({ ...base, commitment: { w0g: rnd(20n * E18), usdc: rnd(100_000_000n) }, fees: { w0g: rnd(5n * E18), usdc: rnd(30_000_000n) }, wallet: { w0g: rnd(25n * E18), usdc: rnd(120_000_000n), ethWei: base.wallet.ethWei } }));

  test("never re-ships more inventory than the wallet holds", () => {
    expect(cases.some((c) => c.wallet.w0g < c.commitment.w0g - c.fees.w0g)).toBe(true);
    for (const c of cases) { const d = decideHarvest(c); expect(BigInt(d.inventory.w0g) <= c.wallet.w0g && BigInt(d.inventory.usdc) <= c.wallet.usdc).toBe(true); }
  });
  test("never frees seed: spare after harvest is at most spare before plus fees, and inventory keeps commitment minus fees", () => {
    const max0 = (x: bigint) => (x > 0n ? x : 0n), min = (a: bigint, b: bigint) => (a < b ? a : b);
    let backed = 0;
    for (const c of cases) {
      const d = decideHarvest(c);
      for (const t of ["w0g", "usdc"] as const) {
        const inv = BigInt(d.inventory[t]);
        expect(c.wallet[t] - inv <= max0(c.wallet[t] - c.commitment[t]) + c.fees[t]).toBe(true);
        expect(inv >= min(c.wallet[t], max0(c.commitment[t] - c.fees[t]))).toBe(true);
        if (c.wallet[t] >= c.commitment[t]) { backed++; expect(c.commitment[t] - inv <= c.fees[t]).toBe(true); }
      }
    }
    expect(backed).toBeGreaterThan(500);
  });
  test("fires at k x the harvest gas cost, holds below it, never crosses the gas floor", () => {
    const d = decideHarvest(base);
    expect([d.fire, d.reason, d.released]).toEqual([true, "fire", { w0g: (E18 / 2n).toString(), usdc: "2000000" }]);
    const tiny = { ...base, fees: { w0g: 0n, usdc: BigInt(Math.floor(d.thresholdUsdc * 1e6)) - 1n } };
    expect(decideHarvest(tiny).reason).toBe("below_threshold");
    expect(decideHarvest({ ...base, fees: { w0g: 0n, usdc: 0n } }).reason).toBe("no_fees");
    expect(decideHarvest({ ...base, wallet: { ...base.wallet, ethWei: 3n * 10n ** 13n + BigInt(d.costWei) - 1n } }).reason).toBe("gas_floor");
    expect(decideHarvest({ ...base, wallet: { ...base.wallet, ethWei: 3n * 10n ** 13n + BigInt(d.costWei) } }).fire).toBe(true);
    expect(decideHarvest(tiny, () => true).reason).toBe(BigInt(Math.floor(d.thresholdUsdc * 1e6)) - 1n >= BigInt(Math.ceil(d.costUsdc * 1e6)) ? "fire_before_funding" : "below_threshold");
  });
});

describe("harvest run", () => {
  test("dock, ship at commitment minus fees, hook follows; fees become spare and KV order moves to the new hash", async () => {
    const c = chain();
    const { s, actions } = await drive(c);
    expect(actions.at(-1)).toStartWith("harvested harvest-");
    expect(c.st.sent.map((t) => lc(t.to))).toEqual([lc(AQUA), lc(AQUA), lc(HOOK)]);
    const dock = decodeFunctionData({ abi: harvestAbi, data: c.st.sent[0]!.data });
    expect([dock.functionName, dock.args[0], lc(dock.args[1] as Hex), dock.args[2]]).toEqual(["dock", AQUA_SWAPVM_ROUTER, FROM, [W0G, USDC]]);
    const h = s.lastHarvest!;
    const slot = c.st.slots.get(lc(h.to))!;
    expect([slot.w0g, slot.usdc, slot.tokensCount]).toEqual([10n * E18 - E18 / 2n, 48_000_000n, 2]);
    expect(c.st.slots.get(FROM)!.tokensCount).toBe(0xff);
    expect(c.st.wallet.usdc - slot.usdc).toBe(60_000_000n - 50_000_000n + FEES.usdc);
    expect([lc(s.live!.hash), s.live!.past.map(lc), s.live!.amounts]).toEqual([lc(h.to), [FROM], h.inventory]);
    expect(Object.keys(h.txs).sort()).toEqual(["harvest-dock", "harvest-set-order", "harvest-ship"]);
    expect(s.run).toBeNull();
  });

  test("the hook order is updated to exactly the shipped order", async () => {
    const c = chain();
    const { s } = await drive(c);
    const set = decodeFunctionData({ abi: harvestAbi, data: c.st.sent.at(-1)!.data });
    expect(set.functionName).toBe("setOrder");
    const o = (set.args as any)[0];
    expect(o.data).toBe(s.live!.order.data);
    expect(lc(c.st.hook)).toBe(lc(s.live!.hash));
    expect(lc(c.st.hook)).not.toBe(FROM);
  });

  test("ships no more than the wallet holds when another project spent from it mid-harvest", async () => {
    const c = chain();
    let s = emptyFundingState(), now = 1_800_000_000_000;
    s = (await fundingTick(s, c.ctx(s, now, FEES))).state; // sent dock
    s = (await fundingTick(s, c.ctx(s, now += 300_000, FEES))).state; // dock done
    c.st.wallet = { ...c.st.wallet, usdc: 30_000_000n };
    for (let i = 0; i < 6 && s.run; i++) s = (await fundingTick(s, c.ctx(s, now += 300_000, FEES))).state;
    const ship = decodeFunctionData({ abi: harvestAbi, data: c.st.sent[1]!.data });
    expect(ship.functionName).toBe("ship");
    expect((ship.args[3] as readonly bigint[])[1]).toBe(30_000_000n);
    expect(c.st.slots.get(lc(s.live!.hash))!.usdc <= c.st.wallet.usdc).toBe(true);
  });

  test("approves Aqua for the new inventory when the allowance fell below it", async () => {
    const c = chain({ allowance: 1n });
    const { s } = await drive(c);
    expect(c.st.sent.map((t) => lc(t.to))).toEqual([lc(AQUA), lc(W0G), lc(USDC), lc(AQUA), lc(HOOK)]);
    expect(c.st.allowance[lc(W0G)]).toBe(BigInt(s.lastHarvest!.inventory.w0g));
  });

  test("an interrupted harvest resumes: a lost dock receipt and a reverted ship never abandon a docked strategy", async () => {
    const c = chain();
    let s = emptyFundingState(), now = 1_800_000_000_000;
    const tick = async (dt = 300_000) => { const r = await fundingTick(s, c.ctx(s, now += dt, FEES)); s = r.state; return r.action; };
    expect(await tick()).toStartWith("sent harvest-dock");
    c.st.receipt = null; // the dock mined, but the RPC never returns its receipt
    expect(await tick()).toBe("waiting harvest-dock");
    expect(await tick(PENDING_TIMEOUT_MS + 1)).toBe("done harvest-dock");
    expect(s.run?.harvest?.docked).toBe(true);
    c.st.receipt = "success";
    expect(await tick()).toStartWith("sent harvest-ship");
    expect(c.st.sent.filter((t) => decodeFunctionData({ abi: harvestAbi, data: t.data }).functionName === "dock").length).toBe(1);
    // A nonce collision: the ship reverts and changes nothing on chain.
    c.st.slots.delete(lc(s.run!.harvest!.to)); c.st.receipt = "reverted";
    expect(await tick()).toBe("harvest retry reverted harvest-ship");
    expect(s.run?.harvest?.docked).toBe(true);
    c.st.receipt = "success";
    // The cron state is reloaded from KV between ticks: survive a JSON round trip.
    s = JSON.parse(JSON.stringify(s));
    expect(await tick()).toStartWith("sent harvest-ship");
    expect(await tick()).toBe("done harvest-ship");
    expect(await tick()).toStartWith("sent harvest-set-order");
    expect(await tick()).toStartWith("harvested");
    expect(lc(c.st.hook)).toBe(lc(s.live!.hash));
  });

  test("a ship that mined while its receipt was lost is detected on chain and never sent twice", async () => {
    const c = chain();
    let s = emptyFundingState(), now = 1_800_000_000_000;
    const tick = async (dt = 300_000) => { const r = await fundingTick(s, c.ctx(s, now += dt, FEES)); s = r.state; return r.action; };
    await tick(); await tick(); // dock sent, dock done
    expect(await tick()).toStartWith("sent harvest-ship");
    c.st.receipt = null;
    expect(await tick(PENDING_TIMEOUT_MS + 1)).toBe("harvest retry timeout harvest-ship");
    c.st.receipt = "success";
    expect(await tick()).toStartWith("sent harvest-set-order");
    expect(c.st.sent.filter((t) => decodeFunctionData({ abi: harvestAbi, data: t.data }).functionName === "ship").length).toBe(1);
    expect(lc(s.live!.hash)).toBe(lc(s.run!.harvest!.to));
    expect(await tick()).toStartWith("harvested");
  });

  test("a dock that broadcast but whose send threw keeps the run, and the next tick resumes from the chain", async () => {
    const c = chain();
    const io0 = c.ctx(emptyFundingState(), 0, FEES).io;
    let s = emptyFundingState(), now = 1_800_000_000_000, throwOnce = true;
    const tick = async () => { const ctx = c.ctx(s, now += 300_000, FEES); ctx.io = { ...io0, send: async (tx) => { const h = await io0.send(tx); if (throwOnce) { throwOnce = false; throw new Error("fetch failed after broadcast"); } return h; } }; const r = await fundingTick(s, ctx); s = r.state; return r.action; };
    expect(await tick()).toStartWith("harvest send_failed harvest-dock");
    expect(s.run?.harvest?.inventory).toEqual({ w0g: (10n * E18 - E18 / 2n).toString(), usdc: "48000000" });
    expect(await tick()).toStartWith("sent harvest-ship");
    expect(c.st.sent.filter((t) => decodeFunctionData({ abi: harvestAbi, data: t.data }).functionName === "dock").length).toBe(1);
  });

  test("a docked live strategy outside a harvest holds funding instead of reading seed as spare", async () => {
    const c = chain();
    c.st.slots.get(FROM)!.tokensCount = 0xff;
    const r = await fundingTick(emptyFundingState(), c.ctx(emptyFundingState(), 1_800_000_000_000, FEES));
    expect(r.action).toBe("hold strategy_docked");
    expect(c.st.sent.length).toBe(0);
  });

  test("no fees on the live hash: no harvest, funding decides as before", async () => {
    const c = chain();
    const r = await fundingTick(emptyFundingState(), c.ctx(emptyFundingState(), 1_800_000_000_000, { w0g: 0n, usdc: 0n }));
    expect(r.state.lastHarvestDecision?.reason).toBe("no_fees");
    expect(r.state.run).toBeNull();
    expect(c.st.sent.length).toBe(0);
  });
});
