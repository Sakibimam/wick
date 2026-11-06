// One agent tick with no filesystem and no long waits, for a Cloudflare Workers cron.
// State lives in whatever store the caller passes back in; every chain read goes through fetch-based viem clients.
import { createWalletClient, formatUnits, http, keccak256, parseAbi, toHex, type Address, type Chain, type PublicClient, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { askBrain } from "./brain.js";
import { deviationBps } from "./budget.js";
import { readMarket, USDC, W0G } from "./price.js";
import { fundingAbi, ZERO_G_PAYMENT_LAYER } from "./funding.js";
import { signQuote, type Quote } from "./signer.js";
import { boardAbi, post } from "./poster.js";
import { cronPolicy, directionalRates } from "./policy.js";

export type InferenceRecord = { requestId: string; model: string; tokens: number | null; costMicroUsd: number | null; currency: string | null; totalCost: string | null; time: string };
export type PostedQuote = { tokenIn: Address; tokenOut: Address; rateE18: string; expiry: string; inferenceId: `0x${string}`; requestId: string; postedTx: `0x${string}`; postedBlock: string };
export type CronState = {
  budget: { tier: "NORMAL" | "LOW" | "CRITICAL" | "PAUSED"; model: string | null; computeBalanceWei: string; spentTodayWei: string; spendCapPerDayWei: string; reason: string; gasWei: string };
  lastMid: number | null;
  recentMids: number[];
  quotedAt: number | null;
  day: string;
  spentTodayWei: string;
  lastComputeBalanceWei: string;
  inferences: InferenceRecord[];
  posted: PostedQuote[];
  lastTick: { at: string; outcome: string } | null;
};
export type TickEnv = { base: PublicClient<any, any>; zeroG: PublicClient<any, any>; chain: Chain; baseRpcUrl: string; baseTransport?: Transport; board: Address; maker: Address; agent: Address; spendCapPerDayWei: bigint; ttlSeconds: number; agentPk?: string; zgApiKey?: string; zgApiBase?: string; now?: number; log?: (line: string) => void };

const KEEP = 50;
const boardRead = [...boardAbi, ...parseAbi(["function getAgent(address) view returns (address)", "function lastNonce(address) view returns (uint64)"])];
const tokenAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export function emptyCronState(): CronState {
  return { budget: { tier: "PAUSED", model: null, computeBalanceWei: "0", spentTodayWei: "0", spendCapPerDayWei: "0", reason: "not_started", gasWei: "0" }, lastMid: null, recentMids: [], quotedAt: null, day: "", spentTodayWei: "0", lastComputeBalanceWei: "", inferences: [], posted: [], lastTick: null };
}

export async function cronTick(prev: CronState, env: TickEnv): Promise<{ state: CronState; outcome: string }> {
  const s: CronState = structuredClone(prev);
  const now = env.now ?? Date.now();
  const log = env.log ?? (() => {});
  const [market, vault, gasWei, quotes] = await Promise.all([
    readMarket(env.base),
    env.zeroG.readContract({ address: ZERO_G_PAYMENT_LAYER, abi: fundingAbi.payment, functionName: "balanceOf", args: [env.agent] }),
    env.base.getBalance({ address: env.agent }),
    Promise.all([[USDC, W0G], [W0G, USDC]].map(([a, b]) => env.base.readContract({ address: env.board, abi: boardAbi, functionName: "getQuote", args: [env.maker, a as Address, b as Address] }))),
  ]);
  const expiries = quotes.map(q => Number(q.expiry)).filter(x => x > 0);
  const secondsToExpiry = expiries.length < 2 ? null : Math.min(...expiries) - Math.floor(now / 1000);

  // Same daily spend accounting as runtime.ts: any drop in the vault balance on one UTC day counts as spend.
  const day = new Date(now).toISOString().slice(0, 10);
  if (s.day !== day) { s.day = day; s.spentTodayWei = "0"; }
  else if (s.lastComputeBalanceWei && BigInt(s.lastComputeBalanceWei) > vault) s.spentTodayWei = (BigInt(s.spentTodayWei) + BigInt(s.lastComputeBalanceWei) - vault).toString();
  s.lastComputeBalanceWei = vault.toString();

  const decision = cronPolicy({ computeBalanceWei: vault, spendCapPerDayWei: env.spendCapPerDayWei, spentTodayWei: BigInt(s.spentTodayWei), priceDeviationBps: s.lastMid === null ? 0 : deviationBps(s.lastMid, market.mid), lastQuoteAgeMs: s.quotedAt === null ? null : now - s.quotedAt, gasWei, secondsToExpiry });
  s.budget = { tier: decision.tier, model: decision.model, computeBalanceWei: vault.toString(), spentTodayWei: s.spentTodayWei, spendCapPerDayWei: env.spendCapPerDayWei.toString(), reason: decision.reason, gasWei: gasWei.toString() };
  const done = (outcome: string) => { s.lastTick = { at: new Date(now).toISOString(), outcome }; log(`tick ${outcome} tier=${decision.tier} reason=${decision.reason} mid=${market.mid} expiresIn=${secondsToExpiry}`); return { state: s, outcome }; };

  if (!env.agentPk || !env.zgApiKey) {
    log("secrets not set");
    s.budget = { ...s.budget, tier: "PAUSED", model: null, reason: decision.reason === "gas_low" ? "gas_low" : "signer_offline" };
    return done("secrets_not_set");
  }
  if (!decision.shouldInfer) return done("hold");

  const account = privateKeyToAccount(env.agentPk as `0x${string}`);
  if (account.address.toLowerCase() !== env.agent.toLowerCase()) throw new Error("AGENT_PK does not match AGENT_ADDRESS");
  const [onBoard, nonce, wbal, ubal] = await Promise.all([
    env.base.readContract({ address: env.board, abi: boardRead, functionName: "getAgent", args: [env.maker] }),
    env.base.readContract({ address: env.board, abi: boardRead, functionName: "lastNonce", args: [env.maker] }),
    env.base.readContract({ address: W0G, abi: tokenAbi, functionName: "balanceOf", args: [env.maker] }),
    env.base.readContract({ address: USDC, abi: tokenAbi, functionName: "balanceOf", args: [env.maker] }),
  ]);
  if ((onBoard as Address).toLowerCase() !== env.agent.toLowerCase()) throw new Error("AGENT_ADDRESS is not the registered board agent");

  s.recentMids = [...s.recentMids.slice(-19), market.mid];
  const result = await askBrain({ mid: market.mid, recentMids: s.recentMids, inventory: { w0g: Number(formatUnits(wbal, 18)), usdc: Number(formatUnits(ubal, 6)) }, budgetTier: decision.tier }, { apiKey: env.zgApiKey, baseUrl: env.zgApiBase, fetchImpl: fetch });
  s.inferences = [...s.inferences, { requestId: result.requestId, model: result.model, tokens: result.tokens, costMicroUsd: result.costMicroUsd, currency: result.billing.currency, totalCost: result.billing.totalCost, time: new Date().toISOString() }].slice(-KEEP);

  const wallet = createWalletClient({ account, chain: env.chain, transport: env.baseTransport ?? http(env.baseRpcUrl) });
  const rates = directionalRates(result.rateE18, result.spreadBps);
  let next = BigInt(nonce as bigint);
  let posted = 0;
  try {
    for (const [tokenIn, tokenOut, rate] of [[USDC, W0G, rates.usdcToW0g], [W0G, USDC, rates.w0gToUsdc]] as const) {
      next++;
      const q: Quote = { maker: env.maker, tokenIn, tokenOut, rateE18: rate, expiry: BigInt(Math.floor(now / 1000) + env.ttlSeconds), nonce: next, inferenceId: keccak256(toHex(result.requestId + tokenIn + tokenOut)) };
      const sig = await signQuote(wallet, env.chain.id, env.board, q);
      const sent = await post(env.base, wallet, env.board, q, sig);
      s.posted = [...s.posted, { tokenIn, tokenOut, rateE18: rate.toString(), expiry: q.expiry.toString(), inferenceId: q.inferenceId, requestId: result.requestId, postedTx: sent.hash, postedBlock: sent.receipt.blockNumber.toString() }].slice(-KEEP);
      posted++;
    }
  } catch (e) {
    // The AI run is billed and any posted quote is on chain: keep both in state rather than losing them with the throw.
    if (posted > 0) { s.lastMid = market.mid; s.quotedAt = now; }
    return done(`partial ${posted}/2 ${result.requestId}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
  }
  s.lastMid = market.mid; s.quotedAt = now;
  return done(`posted ${result.requestId}`);
}
