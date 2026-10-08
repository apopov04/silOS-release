import fs from "fs";
import path from "path";

// Structure-only snapshot of the vault graph for the memory viewer. This file
// is the ONLY thing the internet-facing viewer can read, so it is built by
// allowlist: nodes carry id/title/type/degree, links carry source/target.
// No bodies, tags, properties, aliases or paths ever leave core.
export const EXCLUDED_PREFIXES = ["secrets/", "startup/"];

export function isExcluded(notePath) {
  const p = String(notePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return EXCLUDED_PREFIXES.some((prefix) => p.startsWith(prefix));
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function buildGraph(notes, links, now = new Date()) {
  const included = new Map();
  for (const n of notes) {
    if (isExcluded(n.path)) continue;
    const id = String(n.id);
    included.set(id, {
      id,
      title: n.title == null || n.title === "" ? id : String(n.title),
      type: n.type == null || n.type === "" ? "note" : String(n.type),
      degree: 0,
    });
  }

  const seen = new Set();
  const out = [];
  for (const l of links) {
    if (l.target_id == null) continue;
    const s = String(l.source_id);
    const t = String(l.target_id);
    if (s === t || !included.has(s) || !included.has(t)) continue;
    const key = s + "\u0000" + t;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: s, target: t });
    included.get(s).degree++;
    included.get(t).degree++;
  }

  return {
    generatedAt: now.toISOString(),
    nodes: [...included.values()].sort((a, b) => byKey(a.id, b.id)),
    links: out.sort((a, b) => byKey(a.source, b.source) || byKey(a.target, b.target)),
  };
}

export function writeGraph(db, outDir) {
  const notes = db.prepare("SELECT id, path, title, type FROM notes").all();
  const links = db.prepare("SELECT source_id, target_id FROM links WHERE target_id IS NOT NULL").all();
  const graph = buildGraph(notes, links);
  fs.mkdirSync(outDir, { recursive: true });
  // Write-then-rename so the viewer never reads a half-written file.
  const tmp = path.join(outDir, `.graph.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(graph));
  fs.renameSync(tmp, path.join(outDir, "graph.json"));
  return graph;
}
