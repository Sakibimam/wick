// Live 0G inference: one quote decision per model tier against the real Base mid. Spends router credit.
import { createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { askBrain, BrainError, MODEL_BY_TIER } from "../src/brain.js";
import { readMarket } from "../src/price.js";

const client = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL || "https://mainnet.base.org") });
const market = await readMarket(client);
console.log(`MID=${market.mid}`);
for (const tier of ["NORMAL", "LOW"] as const) {
  try {
    const out = await askBrain({ mid: market.mid, recentMids: [market.mid], inventory: { w0g: 0, usdc: 1 }, budgetTier: tier });
    console.log(`REQUEST_ID=${out.requestId} TIER=${tier} MODEL=${MODEL_BY_TIER[tier]} RATE_E18=${out.rateE18} SPREAD_BPS=${out.spreadBps}`);
  } catch (e) {
    if (e instanceof BrainError) { console.log(`BRAIN_ERROR TIER=${tier} CODE=${e.code} ${e.message}`); process.exitCode = 1; }
    else throw e;
  }
}
