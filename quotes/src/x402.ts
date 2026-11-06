// x402 v1, scheme "exact" on Base: the payment requirement Wick answers with, and the local checks a payment must pass before it is settled.
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";

export const USDC: Address = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
export const NETWORK = "base";
export const CHAIN_ID = 8453;
// FiatToken v2 on Base: name() is "USD Coin", version() is "2". Both feed the EIP-712 domain the payer signs.
export const USDC_DOMAIN = { name: "USD Coin", version: "2", chainId: CHAIN_ID, verifyingContract: USDC } as const;
// A settlement needs a few blocks; an authorization that dies sooner cannot be settled.
export const MIN_VALIDITY_SECONDS = 6;

export const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type PaymentRequirements = {
  scheme: "exact";
  network: typeof NETWORK;
  maxAmountRequired: string;
  asset: Address;
  payTo: Address;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
};

export type Authorization = { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
export type PaymentPayload = { x402Version: 1; scheme: "exact"; network: typeof NETWORK; payload: { signature: Hex; authorization: Authorization } };

export function requirements(resource: string, payTo: Address, priceAtomic: bigint): PaymentRequirements {
  return {
    scheme: "exact",
    network: NETWORK,
    maxAmountRequired: priceAtomic.toString(),
    asset: USDC,
    payTo,
    resource,
    description: "Wick signed W0G/USDC price: the agent's live AgentQuoteBoard quote, the 0G Compute request behind it, and the router amountOut capped at strategy depth",
    mimeType: "application/json",
    maxTimeoutSeconds: 120,
    extra: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version },
  };
}

export const encodeHeader = (v: unknown) => btoa(JSON.stringify(v));

export function decodePayment(header: string): PaymentPayload | null {
  try {
    const p = JSON.parse(atob(header)) as PaymentPayload;
    const a = p?.payload?.authorization;
    if (!a || typeof p.payload.signature !== "string") return null;
    if (![a.from, a.to].every((x) => typeof x === "string" && isAddress(x))) return null;
    if (![a.value, a.validAfter, a.validBefore].every((x) => typeof x === "string" && /^\d{1,78}$/.test(x))) return null;
    if (typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return null;
    return p;
  } catch {
    return null;
  }
}

export type Verdict = { ok: true; payer: Address } | { ok: false; reason: string };

/** Every check the exact scheme defines that needs no chain read. The nonce check runs against USDC.authorizationState separately. */
export async function verifyPayment(p: PaymentPayload, req: PaymentRequirements, nowSec: number): Promise<Verdict> {
  if (p.x402Version !== 1) return { ok: false, reason: "unsupported_x402_version" };
  if (p.scheme !== req.scheme || p.network !== req.network) return { ok: false, reason: "unsupported_scheme_or_network" };
  const a = p.payload.authorization;
  if (getAddress(a.to) !== getAddress(req.payTo)) return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch" };
  if (BigInt(a.value) !== BigInt(req.maxAmountRequired)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_value" };
  if (BigInt(a.validAfter) > BigInt(nowSec)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after" };
  if (BigInt(a.validBefore) < BigInt(nowSec + MIN_VALIDITY_SECONDS)) return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before" };
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: { from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value), validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce },
      signature: p.payload.signature,
    });
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  }
  // ponytail: EOA signatures only; an ERC-1271 smart-wallet payer needs an isValidSignature eth_call here.
  if (signer !== getAddress(a.from)) return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  return { ok: true, payer: signer };
}
