import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { deriveSecretKey } from "../auth.js";
import { signInitData, ownerFields, OWNER, NOW } from "./helpers.mjs";

const KEY = deriveSecretKey("123456:TEST-TOKEN");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-"));
const pub = path.join(tmp, "public");
fs.mkdirSync(pub);
for (const f of ["index.html", "app.js", "app.css", "force-graph.min.js"]) fs.writeFileSync(path.join(pub, f), `/*${f}*/`);
const graphPath = path.join(tmp, "graph.json");
const GRAPH = JSON.stringify({ generatedAt: "x", nodes: [{ id: "a", title: "A", type: "note", degree: 0 }], links: [] });

let server, base;
before(async () => {
  server = createServer({ secretKeyHex: KEY, ownerId: OWNER, graphPath, publicDir: pub, now: () => NOW });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const good = () => signInitData(ownerFields(), KEY);

test("graph 503 when graph.json does not exist yet", async () => {
  const r = await fetch(base + "/api/graph", { headers: { "X-Telegram-Init-Data": good() } });
  assert.equal(r.status, 503);
});

test("graph 200 with valid initData, no-store", async () => {
  fs.writeFileSync(graphPath, GRAPH);
  const r = await fetch(base + "/api/graph", { headers: { "X-Telegram-Init-Data": good() } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(r.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await r.json(), JSON.parse(GRAPH));
});

test("graph 401 with no / forged / other-user initData, empty body", async () => {
  fs.writeFileSync(graphPath, GRAPH);
  const other = signInitData(ownerFields({ user: JSON.stringify({ id: 1 }) }), KEY);
  const forged = good().replace(/hash=[0-9a-f]+/, "hash=" + "0".repeat(64));
  for (const h of [undefined, "", forged, other, "garbage"]) {
    const headers = h === undefined ? {} : { "X-Telegram-Init-Data": h };
    const r = await fetch(base + "/api/graph", { headers });
    assert.equal(r.status, 401, String(h).slice(0, 30));
    assert.equal(await r.text(), "");
  }
});

test("initData in the query string is ignored", async () => {
  const r = await fetch(base + "/api/graph?" + good());
  assert.equal(r.status, 401);
});

test("static files served with security headers", async () => {
  const r = await fetch(base + "/");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  const csp = r.headers.get("content-security-policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' https:\/\/telegram\.org/);
  assert.match(csp, /frame-ancestors https:\/\/web\.telegram\.org/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("referrer-policy"), "no-referrer");
  for (const p of ["/app.js", "/app.css", "/force-graph.min.js"]) assert.equal((await fetch(base + p)).status, 200, p);
});

test("unknown paths and traversal attempts 404", async () => {
  for (const p of ["/server.js", "/auth.js", "/public/index.html", "/../server.js", "/%2e%2e/auth.js", "/graph.json", "/data/graph.json", "/index.html/", "//etc/passwd"]) {
    const r = await fetch(base + p);
    assert.equal(r.status, 404, p);
  }
});

test("non-GET methods rejected", async () => {
  const r = await fetch(base + "/api/graph", { method: "POST", headers: { "X-Telegram-Init-Data": good() } });
  assert.equal(r.status, 405);
});

test("healthz is public and data-free", async () => {
  const r = await fetch(base + "/healthz");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "ok");
});
