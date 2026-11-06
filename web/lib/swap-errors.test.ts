import { describe, expect, test } from "bun:test";
import { failureCopy } from "./swap-errors";

describe("failureCopy", () => {
  test("names the signed per-swap cap", () => {
    expect(failureCopy("too-large", "USDC", undefined, { perSwap: "0.05 USDC" }).body)
      .toBe("Nothing was spent. This signed price fills at most 0.05 USDC per swap. Use Max to fill up to it.");
  });

  test("names strategy depth", () => {
    expect(failureCopy("no-depth", "USDC", undefined, { depth: "12 W0G" }).body)
      .toBe("Nothing was spent. The strategy holds 12 W0G right now. Use Max to fill what it holds.");
  });

  test("keeps uncapped copy unchanged", () => {
    expect(failureCopy("too-large", "USDC").body)
      .toBe("Nothing was spent. Each signed price carries its own fill cap. Use Max to fill up to it.");
    expect(failureCopy("no-depth", "USDC").body)
      .toBe("Nothing was spent. Use Max to fill what the pool holds right now.");
  });
});
