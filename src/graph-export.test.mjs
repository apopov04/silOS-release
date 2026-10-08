import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraph, isExcluded } from "./graph-export.js";

const NOW = new Date("2026-10-02T12:00:00Z");
const notes = [
  { id: "alex", path: "core/alex.md", title: "Alex", type: "person", content: "BODY-SECRET-1", created: "x" },
  { id: "ideas", path: "core/ideas.md", title: "Ideas", type: "note" },
  { id: "pw", path: "secrets/passwords.md", title: "Passwords", type: "note" },
  { id: "so", path: "startup/standing-orders.md", title: "SO", type: "note" },
  { id: "win", path: "secrets\\win.md", title: "Win", type: "note" },
  { id: "dot", path: "./startup/dot.md", title: "Dot", type: "note" },
  { id: "notitle", path: "core/notitle.md", title: null, type: null },
];
const links = [
  { source_id: "alex", target_id: "ideas" },
  { source_id: "alex", target_id: "ideas" },   // duplicate
  { source_id: "ideas", target_id: "ideas" },  // self-link
  { source_id: "alex", target_id: "pw" },      // into excluded
  { source_id: "so", target_id: "alex" },      // from excluded
  { source_id: "ideas", target_id: null },     // dangling
  { source_id: "notitle", target_id: "alex" },
];

test("excluded prefixes, including backslash and ./ forms", () => {
  assert.equal(isExcluded("secrets/passwords.md"), true);
  assert.equal(isExcluded("startup/x.md"), true);
  assert.equal(isExcluded("secrets\\win.md"), true);
  assert.equal(isExcluded("./startup/dot.md"), true);
  assert.equal(isExcluded("core/secrets-plan.md"), false);
  assert.equal(isExcluded("core/alex.md"), false);
});

test("only included notes appear", () => {
  const g = buildGraph(notes, links, NOW);
  assert.deepEqual(g.nodes.map((n) => n.id), ["alex", "ideas", "notitle"]);
});

test("allowlisted fields only", () => {
  const g = buildGraph(notes, links, NOW);
  assert.deepEqual(Object.keys(g).sort(), ["generatedAt", "links", "nodes"]);
  for (const n of g.nodes) assert.deepEqual(Object.keys(n).sort(), ["degree", "id", "title", "type"]);
  for (const l of g.links) assert.deepEqual(Object.keys(l).sort(), ["source", "target"]);
  assert.equal(JSON.stringify(g).includes("BODY-SECRET-1"), false);
  assert.equal(JSON.stringify(g).includes("Passwords"), false);
});

test("links: resolved, deduped, no self, none touching excluded", () => {
  const g = buildGraph(notes, links, NOW);
  assert.deepEqual(g.links, [
    { source: "alex", target: "ideas" },
    { source: "notitle", target: "alex" },
  ]);
});

test("degree counts both directions among included", () => {
  const g = buildGraph(notes, links, NOW);
  const d = Object.fromEntries(g.nodes.map((n) => [n.id, n.degree]));
  assert.deepEqual(d, { alex: 2, ideas: 1, notitle: 1 });
});

test("missing title/type fall back", () => {
  const g = buildGraph(notes, links, NOW);
  const n = g.nodes.find((x) => x.id === "notitle");
  assert.equal(n.title, "notitle");
  assert.equal(n.type, "note");
});

test("deterministic output", () => {
  const a = buildGraph(notes, links, NOW);
  const b = buildGraph([...notes].reverse(), [...links].reverse(), NOW);
  assert.deepEqual(a, b);
  assert.equal(a.generatedAt, "2026-10-02T12:00:00.000Z");
});
