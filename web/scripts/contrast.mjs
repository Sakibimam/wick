// WCAG contrast for every text and surface pair in app/globals.css. Exits 1 on any miss.
// Run `node scripts/contrast.mjs --control` to confirm the check can fail: it feeds a known low-contrast pair and must exit 1.
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const token = (name) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*oklch\\(([\\d.]+)%\\s+([\\d.]+)\\s+([\\d.]+)\\)`));
  if (!m) throw new Error(`token ${name} not found`);
  return [Number(m[1]) / 100, Number(m[2]), Number(m[3])];
};
const toRGB = ([L, C, h]) => {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.min(1, Math.max(0, v)));
};
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const ratio = (fg, bg) => { const x = lum(toRGB(token(fg))), y = lum(toRGB(token(bg))); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

const PAIRS = [
  ["ink", "paper", 7], ["ink-2", "paper", 7], ["ink-2", "panel", 7], ["ink", "lane", 7], ["muted", "paper", 4.5], ["muted", "lane", 4.5], ["muted", "panel", 4.5], ["muted", "sunken", 4.5],
  ["ink", "sunken", 7], ["on-accent", "accent", 7],
  ["ok", "paper", 4.5], ["warn", "paper", 4.5], ["danger", "paper", 4.5], ["quiet", "paper", 4.5], ["danger-ink", "paper", 4.5], ["danger-ink", "panel", 4.5],
  ["ok-ink", "ok-tint", 4.5], ["warn-ink", "warn-tint", 4.5], ["danger-ink", "danger-tint", 4.5],
];
const pairs = process.argv.includes("--control") ? [["muted", "sunken", 12]] : PAIRS;
let miss = 0;
for (const [fg, bg, min] of pairs) {
  const r = ratio(fg, bg);
  if (r < min) miss++;
  console.log(`${r >= min ? "PASS" : "FAIL"} ${r.toFixed(2)} >= ${min}  ${fg} on ${bg}`);
}
process.exit(miss ? 1 : 0);
