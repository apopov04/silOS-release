import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInitData } from "./auth.js";

// Memory viewer: the only silOS service reachable from the internet (via the
// Cloudflare Tunnel). It can read exactly one thing -- the structure-only
// graph.json core writes -- and hands it out only to requests carrying the
// owner's Telegram-signed initData. No vault mount, no route to core.

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const STATIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
  "/force-graph.min.js": ["force-graph.min.js", "text/javascript; charset=utf-8"],
};

export const SECURITY_HEADERS = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "frame-ancestors https://web.telegram.org",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function createServer({ secretKeyHex, ownerId, graphPath, publicDir = path.join(HERE, "public"), now = () => Math.floor(Date.now() / 1000) }) {
  return http.createServer((req, res) => {
    const send = (status, body = "", headers = {}) => {
      res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
      res.end(body);
    };

    if (req.method !== "GET") return send(405);
    // Exact-match routing only; the raw path is never joined onto the disk.
    const url = (req.url || "").split("?")[0];

    if (url === "/healthz") return send(200, "ok", { "Content-Type": "text/plain" });

    if (url === "/api/graph") {
      const result = verifyInitData(req.headers["x-telegram-init-data"], secretKeyHex, ownerId, now());
      if (!result.ok) {
        console.log(`401 /api/graph (${result.reason})`);
        return send(401, "", { "Cache-Control": "no-store" });
      }
      fs.readFile(graphPath, (err, buf) => {
        if (err) return send(503, "", { "Cache-Control": "no-store" });
        send(200, buf, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      });
      return;
    }

    const entry = STATIC_FILES[url];
    if (!entry) return send(404);
    fs.readFile(path.join(publicDir, entry[0]), (err, buf) => {
      if (err) return send(404);
      send(200, buf, { "Content-Type": entry[1], "Cache-Control": "no-cache" });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const secretKeyHex = (process.env.VIEWER_SECRET_KEY || "").trim();
  const ownerId = (process.env.OWNER_TELEGRAM_ID || "").trim();
  if (!/^[0-9a-f]{64}$/.test(secretKeyHex) || !/^\d+$/.test(ownerId)) {
    console.error("VIEWER_SECRET_KEY (64 hex) and OWNER_TELEGRAM_ID (digits) are required. Refusing to start.");
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3003);
  createServer({ secretKeyHex, ownerId, graphPath: process.env.GRAPH_PATH || "/data/graph.json" })
    .listen(port, () => console.log(`silOS viewer listening on ${port}`));
}
