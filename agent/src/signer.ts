import { createWalletClient, custom, http, type Address, type Chain, type Hex, type WalletClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { base } from "viem/chains";

export const quoteTypes = { Quote: [{ name: "maker", type: "address" }, { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" }, { name: "rateE18", type: "uint256" }, { name: "expiry", type: "uint64" }, { name: "nonce", type: "uint64" }, { name: "inferenceId", type: "bytes32" }] } as const;
export type Quote = { maker: Address; tokenIn: Address; tokenOut: Address; rateE18: bigint; expiry: bigint; nonce: bigint; inferenceId: Hex };
export const quoteDomain = (chainId: number, board: Address) => ({ name: "Upkeep AgentQuoteBoard", version: "1", chainId, verifyingContract: board }) as const;
export function quoteTypedData(chainId: number, board: Address, quote: Quote) { return { domain: quoteDomain(chainId, board), types: quoteTypes, primaryType: "Quote" as const, message: quote }; }
export function localSigner(pk = process.env.AGENT_PK, chain: Chain = base): { account: PrivateKeyAccount; wallet: WalletClient } {
  if (!pk) throw new Error("AGENT_PK is required for local signing");
  const account = privateKeyToAccount(pk as Hex);
  return { account, wallet: createWalletClient({ account, chain, transport: http(chain.id === 8453 ? process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com" : process.env.ZG_RPC_URL || "https://evmrpc.0g.ai") }) };
}
export function unlockedSigner(rpcUrl = process.env.BASE_RPC_URL || "http://127.0.0.1:8545", address = process.env.AGENT_ADDRESS as Address, chain: Chain = base): { account: { address: Address }; wallet: WalletClient } {
  if (!address) throw new Error("AGENT_ADDRESS is required for unlocked signing");
  return { account: { address }, wallet: createWalletClient({ account: address, chain, transport: custom({ request: ({ method, params }) => fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then(async r => { const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result; }) }) }) };
}
export async function signQuote(wallet: WalletClient, chainId: number, board: Address, quote: Quote): Promise<Hex> { return wallet.signTypedData({ ...quoteTypedData(chainId, board, quote), account: wallet.account! }); }
