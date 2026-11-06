import { describe, expect, test } from "bun:test";
import { accountSpend, PRE_LEDGER_ROUTER_DEPOSIT_WEI, seedRouterDeposit, type SpendLedger } from "../src/budget.js";
import { cronTick, emptyCronState } from "../src/worker-tick.js";
import { fakeChain } from "./fake-chain.js";

const vault = 2_343_959_530_558_679_712n;
const liveSpend: SpendLedger = { day: "2026-11-06", spentTodayWei: "5227241531512186", routerDepositWei: "0", lastVaultWei: "2343959530558679712" };

describe("pre-ledger router deposit seed", () => {
  test("recovers the live ledger's remaining deposit", () => {
    expect(seedRouterDeposit(liveSpend)).toMatchObject({ routerDepositWei: "494772758468487814", seeded: true });
  });

  test("applies the seed only once", () => {
    expect(seedRouterDeposit(seedRouterDeposit(liveSpend))).toEqual(seedRouterDeposit(liveSpend));
  });

  test("billed spend lowers router funds even when the vault is unchanged", () => {
    const seeded = seedRouterDeposit(liveSpend);
    const next = accountSpend(seeded, { nowMs: Date.parse("2026-11-06T20:00:00Z"), vaultWei: vault, billedWei: 1000n });
    expect(next.routerDepositWei).toBe((BigInt(seeded.routerDepositWei) - 1000n).toString());
    expect(next.fundsWei).toBe((vault + BigInt(next.routerDepositWei)).toString());
    expect(next.seeded).toBe(true);
  });

  test("legacy cron state is seeded, while a fresh deployment stays at zero", async () => {
    const now = Date.parse("2026-11-06T20:00:00Z");
    const c = fakeChain();
    const old = { ...emptyCronState(), spend: { ...liveSpend, lastVaultWei: "2000000000000000000" } };
    const offline = c.env({ now, agentPk: undefined, zgApiKey: undefined });
    const migrated = await cronTick(old, offline);
    expect(migrated.state.spend).toMatchObject({ seeded: true, routerDepositWei: (PRE_LEDGER_ROUTER_DEPOSIT_WEI - BigInt(liveSpend.spentTodayWei)).toString() });

    const fresh = await cronTick(emptyCronState(), offline);
    expect(fresh.state.spend).toMatchObject({ seeded: true, routerDepositWei: "0" });
  });
});
