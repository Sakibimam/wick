import { ImageResponse } from "next/og";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { economicsOf } from "./economics";
import { fmt0g, fmtPct, fmtPrice, significant, toNumber } from "./format";
import { latestByDirection } from "./quotes";
import { statusSchema, type AgentStatus } from "./schema";

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_ALT = "Wick: the market maker that pays for its own brain, with its live fuel, signed price and AI runs paid by fees";

const SITE = "https://wick.earn-shield-alerts.workers.dev";
// Night circuit tokens, as hex because the image renderer has no OKLCH.
const C = { paper: "#0c0c0f", panel: "#17171b", rule: "#34343b", ink: "#f0f0f6", ink2: "#cfcfd6", muted: "#a3a3ad", ok: "#5fd38d", danger: "#f0645a", base: "#6c8cf5", zg: "#ec6aa6", warn: "#f2b33d" };

type Svc = { fetch: (req: Request) => Promise<Response> };

/** The status document, read through the Worker's own service binding when deployed, over the public URL otherwise. */
async function readStatus(): Promise<AgentStatus | null> {
  const attempts: (() => Promise<Response>)[] = [];
  try {
    const self = (getCloudflareContext().env as unknown as { WORKER_SELF_REFERENCE?: Svc }).WORKER_SELF_REFERENCE;
    if (self) attempts.push(() => self.fetch(new Request(`${SITE}/api/status`)));
  } catch {
    // Outside the Worker (next dev, next build) there is no Cloudflare context; the public URL below is the read.
  }
  attempts.push(() => fetch(`${SITE}/api/status`, { signal: AbortSignal.timeout(5000) }));
  for (const go of attempts) {
    try {
      const res = await go();
      if (!res.ok) continue;
      const parsed = statusSchema.safeParse(await res.json());
      if (parsed.success) return parsed.data;
    } catch (e) {
      if (!(e instanceof Error)) throw e;
    }
  }
  return null;
}

async function font(): Promise<ArrayBuffer | null> {
  try {
    const css = await (await fetch("https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600", { signal: AbortSignal.timeout(4000) })).text();
    const url = css.match(/src: url\((.+?)\) format\('(?:truetype|opentype)'\)/)?.[1];
    return url ? await (await fetch(url, { signal: AbortSignal.timeout(4000) })).arrayBuffer() : null;
  } catch (e) {
    if (e instanceof Error) return null;
    throw e;
  }
}

function Stat({ label, value, unit, color }: { label: string; value: string; unit?: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", fontSize: 24, color: C.muted, fontFamily: "Barlow" }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ display: "flex", fontSize: 64, color: color ?? C.ink, lineHeight: 1 }}>{value}</div>
        {unit ? <div style={{ display: "flex", fontSize: 28, color: C.muted }}>{unit}</div> : null}
      </div>
    </div>
  );
}

export async function renderCard(): Promise<ImageResponse> {
  const [status, display] = await Promise.all([readStatus(), font()]);
  const econ = status ? economicsOf(status) : null;
  const p = status ? latestByDirection(status.quotes) : null;
  const fuel = status ? fmt0g(toNumber(status.budget.computeBalanceWei, "0G")) : null;
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", background: C.paper, color: C.ink, padding: "56px 64px", fontFamily: display ? "Barlow Condensed" : "sans-serif" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <svg width="56" height="56" viewBox="0 0 64 64">
            <path fill={C.ink} d="M32 6c2.5 7.5 13 13.5 13 26.5a13 13 0 0 1-26 0c0-6.6 3.2-10.7 6.4-14.2.4 4 1.9 6.6 4.4 8.1-.9-7.3-.1-13.6 2.2-20.4z" />
            <path fill={C.warn} d="M32 30.5c2.6 3.3 4.6 5.6 4.6 9a4.6 4.6 0 0 1-9.2 0c0-3.4 2-5.7 4.6-9z" />
            <rect fill={C.ink} x="30.6" y="43" width="2.8" height="15" rx="1.4" />
          </svg>
          <div style={{ display: "flex", fontSize: 40, letterSpacing: 6 }}>WICK</div>
          <div style={{ display: "flex", marginLeft: "auto", fontSize: 24, color: C.muted }}>live on Base and 0G</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", fontSize: 96, lineHeight: 0.95, textTransform: "uppercase" }}>The market maker that pays for its own brain</div>
          {econ?.coverage != null ? <div style={{ display: "flex", fontSize: 32, color: C.ink2 }}>{`Fees earned cover ${fmtPct(econ.coverage * 100)} of its AI bill`}</div> : null}
        </div>
        <div style={{ display: "flex", gap: 72, borderTop: `2px solid ${C.rule}`, paddingTop: 28 }}>
          <Stat label="Fuel for AI runs" value={fuel ?? "live"} unit={fuel ? "0G" : undefined} color={C.zg} />
          <Stat label="Signed price, ask / bid" value={p?.["buy-w0g"] && p["sell-w0g"] ? `${fmtPrice(p["buy-w0g"].priceUsdcPerW0g)} / ${fmtPrice(p["sell-w0g"].priceUsdcPerW0g)}` : "live"} unit="USDC" />
          <Stat label="AI runs paid by fees" value={econ?.runsPaidByFees != null ? significant(econ.runsPaidByFees, 2) : status ? String(status.inferences.length) : "live"} color={C.ok} />
        </div>
      </div>
    ),
    { ...OG_SIZE, fonts: display ? [{ name: "Barlow Condensed", data: display, weight: 600, style: "normal" }] : undefined, headers: { "cache-control": "public, max-age=300" } },
  );
}
