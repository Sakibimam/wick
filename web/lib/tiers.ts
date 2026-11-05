import type { Tier } from "./schema";

export type TierMeta = { label: string; tone: "ok" | "warn" | "danger" | "quiet"; consequence: string; index: number };

export const TIER_ORDER: Tier[] = ["NORMAL", "LOW", "CRITICAL", "PAUSED"];

export const TIERS: Record<Tier, TierMeta> = {
  NORMAL: { label: "Normal", tone: "ok", index: 0, consequence: "Full-size AI model, standard spread, requotes when the pool price moves." },
  LOW: { label: "Low", tone: "warn", index: 1, consequence: "Cheaper AI model and a spread twice as wide, to stretch the balance." },
  CRITICAL: { label: "Critical", tone: "danger", index: 2, consequence: "No new AI runs. Only a recent signed price stays up, at a spread four times as wide." },
  PAUSED: { label: "Paused", tone: "quiet", index: 3, consequence: "The agent signs no new prices. A price already signed fills until it expires, then the pool refuses every swap until the agent is funded or the day resets." },
};

const REASONS: Record<string, string> = {
  normal: "Balance and daily spend are both healthy.",
  balance_low: "The 0G balance dropped under the low line.",
  spend_low: "Today's spend is getting close to the daily cap.",
  balance_critical: "The 0G balance dropped under the critical line.",
  spend_critical: "Today's spend is very close to the daily cap.",
  balance_below_floor: "The 0G balance is under the floor needed to pay for any AI run.",
  spend_cap_reached: "Today's spend reached the daily cap.",
  not_started: "The agent has not completed its first cycle yet.",
};

export function reasonText(reason: string): string {
  return REASONS[reason] ?? reason;
}
