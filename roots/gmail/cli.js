#!/usr/bin/env node
// Gmail root CLI. Agents invoke this via Bash; each run is stateless.
//
// Commands:
//   list-unread [--max N]          List unread inbox messages (default N=10).
//   read <messageId>               Full message headers + body.
//   search "<query>" [--max N]     Gmail search (same syntax as the web UI).
//   send --to <a> --subject "<s>" --body "<b>" [--cc <a>] [--bcc <a>]
//   mark-read <id> [<id> ...]      Remove the UNREAD label from one or more messages.
//   mark-read --all                Mark every unread message in the account as read.
//
// stdout: JSON on success. stderr + exit code > 0 on error.

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");

// --- env loading ---------------------------------------------------------

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!existsSync(ENV_PATH)) die(`Missing ${ENV_PATH}. Run authorize.js first.`);
const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = env;
if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
  die(`.env is missing one of GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN.`);
}

// --- auth ----------------------------------------------------------------

const oAuth2 = new google.auth.OAuth2(GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET);
oAuth2.setCredentials({ refresh_token: GMAIL_REFRESH_TOKEN });
const gmail = google.gmail({ version: "v1", auth: oAuth2 });

// --- helpers -------------------------------------------------------------

function getHeader(headers, name) {
  const h = headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

// Gmail stores signatures as HTML. For our text/plain outbound mail we need to
// flatten them. Covers the shapes signatures actually use (br, div/p, links,
// entities, nested spans). Not a general HTML-to-text library.
function htmlToPlainText(html) {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (_, href, text) => {
      const t = text.replace(/<[^>]+>/g, "").trim();
      return t && t !== href ? `${t} (${href})` : href;
    })
    .replace(/<img[^>]*\/?>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Fetch the signature configured in Gmail Settings > See all settings > General.
// The Gmail API does NOT auto-append signatures the way the web UI does, so we
// fetch + append manually. Gmail stores signatures as HTML — we return both the
// original HTML (for the HTML part of our multipart message) and a flattened
// plain-text version (for the text part). Fails gracefully: empty strings if
// scope is insufficient or the user has no signature.
async function getSignature() {
  try {
    const { data } = await gmail.users.settings.sendAs.list({ userId: "me" });
    const primary = (data.sendAs || []).find((s) => s.isPrimary) || data.sendAs?.[0];
    if (!primary?.signature) return { html: "", text: "" };
    return { html: primary.signature, text: htmlToPlainText(primary.signature) };
  } catch (err) {
    console.error(`Signature fetch skipped: ${err?.message || err}`);
    return { html: "", text: "" };
  }
}

// Escape + wrap plain-prose body as minimal HTML. Paragraphs (double newline)
// become <p>; single newlines become <br>. Escapes HTML specials so a stray
// `<` in the user's text doesn't break rendering.
function plainBodyToHtml(text) {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  const paragraphs = escaped.split(/\n{2,}/).map((p) => p.replace(/\n/g, "<br>"));
  return paragraphs.map((p) => `<p>${p}</p>`).join("\n");
}

// RFC 2047 — non-ASCII subject lines need B-encoding. Pass ASCII through.
function encodeSubject(s) {
  if (/^[\x20-\x7E]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// RFC 2045 — base64 body parts must wrap at 76 chars.
function base64Wrap(content) {
  const b64 = Buffer.from(content || "", "utf8").toString("base64");
  return (b64.match(/.{1,76}/g) || []).join("\r\n");
}

// Recursively walk message payload parts; collect text/plain and text/html bodies.
function extractBody(payload) {
  if (!payload) return { text: "", html: "" };
  if (payload.parts && payload.parts.length > 0) {
    let text = "";
    let html = "";
    for (const p of payload.parts) {
      const sub = extractBody(p);
      if (sub.text) text += (text ? "\n" : "") + sub.text;
      if (sub.html) html += (html ? "\n" : "") + sub.html;
    }
    return { text, html };
  }
  const data = payload.body?.data;
  if (!data) return { text: "", html: "" };
  const decoded = Buffer.from(data, "base64url").toString("utf8");
  if (payload.mimeType === "text/plain") return { text: decoded, html: "" };
  if (payload.mimeType === "text/html") return { text: "", html: decoded };
  return { text: "", html: "" };
}

async function summarize(id) {
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "metadata",
    metadataHeaders: ["From", "To", "Subject", "Date"],
  });
  return {
    id: data.id,
    threadId: data.threadId,
    from: getHeader(data.payload?.headers, "From"),
    to: getHeader(data.payload?.headers, "To"),
    subject: getHeader(data.payload?.headers, "Subject"),
    date: getHeader(data.payload?.headers, "Date"),
    snippet: data.snippet || "",
    unread: (data.labelIds || []).includes("UNREAD"),
  };
}

// Minimal arg parser. Supports:
//   --flag value      -> args.flag = value
//   --flag=value      -> same
//   positional        -> args._ array
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// --- commands ------------------------------------------------------------

async function cmdListUnread(args) {
  const max = Math.min(Math.max(parseInt(args.max || "10", 10), 1), 50);
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q: "in:inbox is:unread",
    maxResults: max,
  });
  const ids = (data.messages || []).map((m) => m.id);
  const summaries = [];
  for (const id of ids) summaries.push(await summarize(id));
  console.log(JSON.stringify({ count: summaries.length, messages: summaries }, null, 2));
}

async function cmdRead(args) {
  const id = args._[0];
  if (!id) die("Usage: read <messageId>");
  const { data } = await gmail.users.messages.get({
    userId: "me",
    id,
    format: "full",
  });
  const body = extractBody(data.payload);
  console.log(JSON.stringify({
    id: data.id,
    threadId: data.threadId,
    from: getHeader(data.payload?.headers, "From"),
    to: getHeader(data.payload?.headers, "To"),
    cc: getHeader(data.payload?.headers, "Cc"),
    subject: getHeader(data.payload?.headers, "Subject"),
    date: getHeader(data.payload?.headers, "Date"),
    snippet: data.snippet || "",
    body: body.text,
    bodyHtml: body.html,
    labels: data.labelIds || [],
  }, null, 2));
}

async function cmdSearch(args) {
  const q = args._[0];
  if (!q) die("Usage: search \"<gmail query>\" [--max N]");
  const max = Math.min(Math.max(parseInt(args.max || "20", 10), 1), 100);
  const { data } = await gmail.users.messages.list({
    userId: "me",
    q,
    maxResults: max,
  });
  const ids = (data.messages || []).map((m) => m.id);
  const summaries = [];
  for (const id of ids) summaries.push(await summarize(id));
  console.log(JSON.stringify({ count: summaries.length, query: q, messages: summaries }, null, 2));
}

// RFC 2046 multipart/alternative. Sends both text/plain and text/html so
// plain-text clients see the stripped version, HTML clients see the formatted
// version (preserving the Gmail signature exactly as the user designed it).
function buildRawEmail({ to, cc, bcc, subject, bodyText, bodyHtml }) {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const parts = [];
  parts.push(`To: ${to}`);
  if (cc) parts.push(`Cc: ${cc}`);
  if (bcc) parts.push(`Bcc: ${bcc}`);
  parts.push(`Subject: ${encodeSubject(subject)}`);
  parts.push("MIME-Version: 1.0");
  parts.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  parts.push("");

  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/plain; charset="UTF-8"');
  parts.push("Content-Transfer-Encoding: base64");
  parts.push("");
  parts.push(base64Wrap(bodyText));

  parts.push(`--${boundary}`);
  parts.push('Content-Type: text/html; charset="UTF-8"');
  parts.push("Content-Transfer-Encoding: base64");
  parts.push("");
  parts.push(base64Wrap(bodyHtml));

  parts.push(`--${boundary}--`);
  return Buffer.from(parts.join("\r\n"), "utf8").toString("base64url");
}

async function cmdSend(args) {
  const { to, subject, body, cc, bcc } = args;
  if (!to || !subject || body === undefined) {
    die(`Usage: send --to <addr> --subject "<s>" --body "<b>" [--cc addr] [--bcc addr]`);
  }
  const { html: sigHtml, text: sigText } = await getSignature();

  // Text part: plain body + RFC 3676 "-- " delimiter + flattened sig.
  const bodyText = sigText ? `${body}\n\n-- \n${sigText}` : body;

  // HTML part: body wrapped as HTML paragraphs, then the signature's original
  // HTML block verbatim (so fonts, links, spacing render exactly as Gmail
  // stores them).
  const bodyAsHtml = plainBodyToHtml(body);
  const bodyHtml = sigHtml
    ? `${bodyAsHtml}\n<br><br>\n<div>-- </div>\n${sigHtml}`
    : bodyAsHtml;

  const raw = buildRawEmail({ to, cc, bcc, subject, bodyText, bodyHtml });
  const { data } = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw },
  });
  console.log(JSON.stringify({
    sent: true,
    id: data.id,
    threadId: data.threadId,
    signatureAppended: !!sigHtml,
  }, null, 2));
}

async function cmdMarkRead(args) {
  let ids = args._.slice();

  if (args.all) {
    // Paginate through every unread message in the account.
    const collected = [];
    let pageToken;
    do {
      const { data } = await gmail.users.messages.list({
        userId: "me",
        q: "is:unread",
        maxResults: 500,
        pageToken,
      });
      for (const m of data.messages || []) collected.push(m.id);
      pageToken = data.nextPageToken;
    } while (pageToken);
    ids = collected;
  }

  if (ids.length === 0) {
    if (!args.all) die("Usage: mark-read <id> [<id> ...]   |   mark-read --all");
    console.log(JSON.stringify({ modified: 0, ids: [] }, null, 2));
    return;
  }

  // batchModify accepts up to 1000 ids per call. Chunk to be safe.
  for (let i = 0; i < ids.length; i += 1000) {
    const chunk = ids.slice(i, i + 1000);
    await gmail.users.messages.batchModify({
      userId: "me",
      requestBody: { ids: chunk, removeLabelIds: ["UNREAD"] },
    });
  }

  console.log(JSON.stringify({ modified: ids.length, ids }, null, 2));
}

// --- dispatch ------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

const handlers = {
  "list-unread": cmdListUnread,
  "read": cmdRead,
  "search": cmdSearch,
  "send": cmdSend,
  "mark-read": cmdMarkRead,
};

const handler = handlers[cmd];
if (!handler) {
  die(`Unknown command: ${cmd || "(none)"}. Expected one of: ${Object.keys(handlers).join(", ")}`);
}

handler(args).catch((err) => {
  const msg = err?.response?.data?.error?.message || err?.message || String(err);
  die(`Error: ${msg}`);
});
