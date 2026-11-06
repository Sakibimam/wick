export default { async fetch(req, env) { globalThis.__env = env;
  const ns = globalThis.__env.CLAIMS; const st = ns.get(ns.idFromName("claims")); const key = "probe-" + Date.now();
  const a = await Promise.all([1,2,3,4,5].map(() => st.fetch("https://claims/" + encodeURIComponent(key))));
  const b = await st.fetch("https://claims/" + encodeURIComponent(key + "-other"));
  return Response.json({ concurrent: a.map(r => r.status), other: b.status });
} };
