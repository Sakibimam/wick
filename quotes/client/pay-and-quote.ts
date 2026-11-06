// A payer agent buys one Wick quote over x402: read the 402, sign the EIP-3009 authorization it asks for, retry with X-PAYMENT.
// Env: PAYER_PK (read, never printed), QUOTES_URL, TOKEN_IN (USDC|W0G), AMOUNT_IN (atomic units).
import { getAddress, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const pk = process.env.PAYER_PK;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("set PAYER_PK to the payer agent's 0x-prefixed private key");
const account = privateKeyToAccount(pk as Hex);
const base = (process.env.QUOTES_URL || "https://wick-quotes.earn-shield-alerts.workers.dev").replace(/\/+$/, "");
const url = `${base}/v1/quote?tokenIn=${process.env.TOKEN_IN || "USDC"}&amountIn=${process.env.AMOUNT_IN || "1000000"}`;

const first = await fetch(url);
if (first.status !== 402) throw new Error(`expected 402 Payment Required, got ${first.status}: ${await first.text()}`);
const { accepts } = (await first.json()) as { accepts: Array<{ scheme: string; network: string; maxAmountRequired: string; asset: string; payTo: string; maxTimeoutSeconds: number; extra: { name: string; version: string } }> };
const req = accepts.find((r) => r.scheme === "exact" && r.network === "base");
if (!req) throw new Error("no exact/base payment option offered");
console.log(`price ${req.maxAmountRequired} atomic USDC to ${req.payTo}, payer ${account.address}`);

const now = Math.floor(Date.now() / 1000);
const authorization = {
  from: account.address,
  to: getAddress(req.payTo),
  value: req.maxAmountRequired,
  validAfter: String(now - 60),
  validBefore: String(now + req.maxTimeoutSeconds),
  nonce: toHex(crypto.getRandomValues(new Uint8Array(32))),
};
const signature = await account.signTypedData({
  domain: { name: req.extra.name, version: req.extra.version, chainId: 8453, verifyingContract: getAddress(req.asset) },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce: authorization.nonce as Hex },
});
const header = btoa(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } }));

const paid = await fetch(url, { headers: { "X-PAYMENT": header } });
const body = await paid.json();
if (paid.status !== 200) throw new Error(`payment refused (${paid.status}): ${JSON.stringify(body)}`);
const settlement = JSON.parse(atob(paid.headers.get("X-PAYMENT-RESPONSE") ?? "")) as { transaction: Hex };
console.log(JSON.stringify((body as { quote: unknown }).quote, null, 2));
console.log(`settlement tx ${settlement.transaction}`);
if (process.env.X_PAYMENT_OUT) await Bun.write(process.env.X_PAYMENT_OUT, header);
