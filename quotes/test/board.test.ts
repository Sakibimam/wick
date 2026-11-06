import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionResult, getAbiItem, getAddress, type Abi } from "viem";
import fixture from "./fixtures/AgentQuoteBoardV2.abi.json";
import order from "../../web/worker/live-order-v2.json";
import { abi, fillable, fresh, MAX_TTL, ORDER_HASH } from "../src/chain";

const boardAbi = fixture.abi as Abi;
const strip = (p: any): any => ({ name: p.name || "", type: p.type, ...(p.components ? { components: p.components.map(strip) } : {}) });

describe("configured board", () => {
  test("wrangler.jsonc points at the v2 board the order was shipped against", async () => {
    const jsonc = await Bun.file(`${import.meta.dir}/../wrangler.jsonc`).text();
    const vars = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "")).vars;
    expect(getAddress(vars.BOARD_ADDRESS)).toBe(getAddress(order.board));
    expect(ORDER_HASH).toBe(order.strategyHash as `0x${string}`);
    expect(order.version).toBe(2);
  });

  test("getQuote output matches the compiled AgentQuoteBoardV2 Posted struct, field for field", () => {
    const ours = getAbiItem({ abi, name: "getQuote" });
    const theirs = getAbiItem({ abi: boardAbi, name: "getQuote" }) as any;
    expect(ours.outputs.map(strip)).toEqual(theirs.outputs.map(strip));
  });

  test("a getQuote return encoded by the board ABI decodes into the right fields", () => {
    const posted = { rateE18: 6807967956184384449584994189312n, maxAmountIn: 50000n, expiry: 1793956070n, epoch: 1n, nonce: 4n, inferenceId: "0x9c5a450196e948ff620976ea6ab0b0b84f6eae2c208730650b1887a2e397efea" as const };
    const data = encodeFunctionResult({ abi: boardAbi, functionName: "getQuote", result: posted });
    expect(decodeFunctionResult({ abi, functionName: "getQuote", data })).toEqual(posted);
  });
});

describe("fill size", () => {
  const rate = 6807967956184384449584994189312n; // W0G per USDC, 1e18-scaled
  const deep = 10n ** 24n;
  test("an ask above maxAmountIn is cut to maxAmountIn", () => {
    expect(fillable(1_000_000n, rate, 50_000n, deep)).toBe(50_000n);
  });
  test("an ask inside both caps is filled as asked", () => {
    expect(fillable(20_000n, rate, 50_000n, deep)).toBe(20_000n);
  });
  test("thin depth binds before maxAmountIn, and the fill's output fits the strategy balance", () => {
    const depthOut = 100_000_000_000_000_000n; // 0.1 W0G
    const fill = fillable(1_000_000n, rate, 50_000n, depthOut);
    expect(fill).toBeLessThan(50_000n);
    expect((fill * rate / 10n ** 18n) * 9970n / 10_000n).toBeLessThanOrEqual(depthOut);
    expect(((fill + 1n) * rate / 10n ** 18n) * 9970n / 10_000n).toBeGreaterThan(depthOut);
  });
  test("no depth or no rate fills nothing", () => {
    expect(fillable(1_000_000n, rate, 50_000n, 0n)).toBe(0n);
    expect(fillable(1_000_000n, 0n, 50_000n, deep)).toBe(0n);
  });
});

describe("freshness", () => {
  const now = 1_793_955_723;
  test("sellable only before expiry and within MAX_TTL of now", () => {
    expect(fresh(BigInt(now + 347), now)).toBe(true);
    expect(fresh(BigInt(now), now)).toBe(false);
    expect(fresh(BigInt(now) + MAX_TTL + 3600n, now)).toBe(false);
  });
});
