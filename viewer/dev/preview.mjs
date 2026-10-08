import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { deriveSecretKey } from "../auth.js";
import { signInitData, ownerFields, OWNER } from "../test/helpers.mjs";

// Dev only (not in the image). Usage: node viewer/dev/preview.mjs [graph.json]
const key = deriveSecretKey("preview:" + Math.random());
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-preview-"));
const graphPath = path.join(dir, "graph.json");
const src = process.argv[2];
if (src) fs.copyFileSync(src, graphPath);
else {
  const ids = ["alex", "acme", "silos", "ideas", "lisbon", "sam", "assistant", "side-project", "xss"];
  const nodes = ids.map((id) => ({ id, title: id === "xss" ? "<img src=x onerror=alert(1)>" : id, type: id === "alex" || id === "sam" ? "person" : "note", degree: 0 }));
  const links = [["alex","acme"],["alex","silos"],["silos","assistant"],["alex","lisbon"],["alex","sam"],["acme","silos"],["ideas","silos"],["alex","ideas"],["side-project","acme"],["xss","alex"]]
    .map(([source, target]) => ({ source, target }));
  for (const l of links) { nodes.find((n) => n.id === l.source).degree++; nodes.find((n) => n.id === l.target).degree++; }
  fs.writeFileSync(graphPath, JSON.stringify({ generatedAt: new Date().toISOString(), nodes, links }));
}
const now = Math.floor(Date.now() / 1000);
const initData = signInitData(ownerFields({ auth_date: String(now) }), key);
const port = Number(process.env.PORT || 3013);
createServer({ secretKeyHex: key, ownerId: OWNER, graphPath }).listen(port, "127.0.0.1", () => {
  console.log(`http://127.0.0.1:${port}/#tgWebAppData=${encodeURIComponent(initData)}&tgWebAppVersion=8.0&tgWebAppPlatform=web`);
});
