/** Group points on a 0..1 axis that sit closer than `gap`, so marks that would overlap draw once with a count. Input order is irrelevant. */
export function cluster<T>(items: T[], pos: (t: T) => number, gap: number): { x: number; items: T[] }[] {
  const sorted = [...items].sort((a, b) => pos(a) - pos(b));
  const out: { x: number; items: T[] }[] = [];
  for (const it of sorted) {
    const p = pos(it);
    const last = out.at(-1);
    if (last && p - pos(last.items.at(-1)!) < gap) {
      last.items.push(it);
      last.x = last.items.reduce((a, i) => a + pos(i), 0) / last.items.length;
    } else out.push({ x: p, items: [it] });
  }
  return out;
}
