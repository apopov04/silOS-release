#!/usr/bin/env node
// One-shot Gmail OAuth — run on your laptop (needs a browser).
//
// Reads GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET from roots/gmail/.env,
// opens the Google consent screen in your browser, captures the redirect
// on a local loopback port, exchanges the code for a refresh token, and
// writes the full set of credentials back to roots/gmail/.env.
//
// After it finishes, upload the .env to the server:
//   scp roots/gmail/.env silos@YOUR_SERVER_IP:~/silos/roots/gmail/.env
// (or just ask the assistant to do it)

import http from "http";
import { exec } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");
const PORT = 53823;
const REDIRECT_URI = `http://127.0.0.1:${PORT}`;

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
];

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

if (!existsSync(ENV_PATH)) {
  console.error(`Missing ${ENV_PATH}. Create it with these two lines before running:`);
  console.error("  GMAIL_CLIENT_ID=<your client id>");
  console.error("  GMAIL_CLIENT_SECRET=<your client secret>");
  process.exit(1);
}

const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const clientId = env.GMAIL_CLIENT_ID;
const clientSecret = env.GMAIL_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(`GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET must be set in ${ENV_PATH}.`);
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // force refresh_token issuance even if previously granted
  scope: SCOPES,
});

console.log("\nStarting Gmail OAuth flow.");
console.log(`Listening on ${REDIRECT_URI} for the redirect.\n`);
console.log("If your browser doesn't open automatically, open this URL manually:\n");
console.log(authUrl);
console.log("");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    const err = url.searchParams.get("error");

    if (err) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end(`OAuth error: ${err}`);
      console.error(`\nOAuth error: ${err}`);
      server.close();
      process.exit(1);
    }

    if (!code) {
      res.writeHead(400);
      res.end("Missing code");
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body style=\"font-family:sans-serif;padding:2rem;\"><h2>silOS Gmail authorized</h2><p>You can close this tab.</p></body></html>");

    const { tokens } = await oAuth2Client.getToken(code);

    if (!tokens.refresh_token) {
      console.error("\nNo refresh_token returned. Google only issues one on the FIRST authorization.");
      console.error("Revoke silOS at https://myaccount.google.com/permissions and re-run this script.");
      server.close();
      process.exit(1);
    }

    const envContent = [
      `GMAIL_CLIENT_ID=${clientId}`,
      `GMAIL_CLIENT_SECRET=${clientSecret}`,
      `GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`,
      "",
    ].join("\n");
    writeFileSync(ENV_PATH, envContent);

    console.log(`\nSuccess. Credentials written to ${ENV_PATH}`);
    console.log("\nNext: upload to the server so the Gmail root can use it:");
    console.log(`  scp "${ENV_PATH}" silos@YOUR_SERVER_IP:~/silos/roots/gmail/.env`);
    console.log("(or ask the assistant to do it)\n");

    server.close();
    process.exit(0);
  } catch (e) {
    console.error(`\nError: ${e.message}`);
    try {
      res.writeHead(500);
      res.end(e.message);
    } catch {}
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  // Windows: cmd's `start` takes an empty quoted title as the first arg.
  const cmd = process.platform === "win32"
    ? `cmd /c start "" "${authUrl}"`
    : process.platform === "darwin"
      ? `open "${authUrl}"`
      : `xdg-open "${authUrl}"`;
  exec(cmd, (err) => {
    if (err) {
      console.log("(Couldn't auto-open the browser — copy the URL printed above.)");
    }
  });
});
