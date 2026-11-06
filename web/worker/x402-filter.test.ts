import { expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { x402Settlements } from "./cron";

const AGENT = "0xeF2E5ba8becc666b4B7BBfEB8f7d851af40Fd953" as Address;
const payer = "0x00000000000000000000000000000000000000a1" as Address;
const tx = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const transfer = (n: number, value: bigint) => ({ transactionHash: tx(n), args: { from: payer, to: AGENT, value } });

test("x402 revenue requires the exact quote amount and payer authorization", () => {
  const transfers = [transfer(1, 100n * 10n ** 6n), transfer(2, 10_000n), transfer(3, 10_000n)];
  const auths = [{ transactionHash: tx(1), args: { authorizer: payer } }, { transactionHash: tx(2), args: { authorizer: payer } }];

  expect(x402Settlements(transfers as never, auths as never)).toEqual([{ tx: tx(2), payer, value: 10_000n }]);
});
