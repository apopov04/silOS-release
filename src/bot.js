const TelegramBot = require("node-telegram-bot-api");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const telegramifyMarkdown = require("telegramify-markdown");
const { parseModelCommand, parseEffortCommand, EFFORTS } = require("./model-command.cjs");

const VAULT_ROOT = "/app/vault";
const TELEGRAM_SEND_MAX = 50 * 1024 * 1024; // Bot upload limit per Telegram API docs
const IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp"]);

// Claude writes natural markdown; Telegram's MarkdownV2 requires escaping 18
// special chars (_*[]()~`>#+-=|{}.!) in every line of prose. This wraps the
// conversion so the whole bot has a single "how do I stringify for Telegram"
// entry point. On failure, brute-escape all V2 specials — the message loses
// formatting but still sends (better than a silent 400).
function toV2(text) {
  const s = String(text ?? "");
  try {
    return telegramifyMarkdown(s, "escape");
  } catch (err) {
    console.error("V2 convert failed:", err.message);
    return s.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
  }
}

// Only this Telegram username (without the @) may talk to the bot. Everyone
// else is silently ignored. Set TELEGRAM_ALLOWED_USERNAME in .env.
const ALLOWED_USERNAME = (process.env.TELEGRAM_ALLOWED_USERNAME || "").replace(/^@/, "").trim();
if (!ALLOWED_USERNAME) {
  console.error("TELEGRAM_ALLOWED_USERNAME is not set in .env - refusing to start (the bot would answer nobody).");
  process.exit(1);
}
const CORE_URL = process.env.CORE_URL || "http://core:3000";
const ADMIN_URL = process.env.ADMIN_URL || "http://host.docker.internal:3002";
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Store user's chat ID for notifications.
//
// This used to live only in memory, so every bot restart silently disabled all
// unsolicited delivery -- routines, follow-ups, file sends, push fallbacks --
// until the user happened to message first. Nothing logged; pushes just 503'd
// and vanished. Persist it so a restart is invisible.
const CHAT_ID_FILE = "/app/data/chat-id";
let userChatId = null;

try {
  const saved = fs.readFileSync(CHAT_ID_FILE, "utf8").trim();
  if (saved) {
    userChatId = Number(saved);
    console.log(`Restored chat id from disk: ${userChatId}`);
  }
} catch { /* first run, or no state volume yet */ }

// Pushes that arrive before the chat id is known are held rather than dropped,
// then flushed in order the moment it becomes available.
const pendingPushes = [];
const MAX_PENDING_PUSHES = 50;

function setUserChatId(chatId) {
  const isNew = userChatId !== chatId;
  userChatId = chatId;
  if (isNew) {
    try {
      fs.mkdirSync("/app/data", { recursive: true });
      fs.writeFileSync(CHAT_ID_FILE, String(chatId));
    } catch (err) {
      console.error("Could not persist chat id:", err.message);
    }
  }
  if (pendingPushes.length > 0) {
    const queued = pendingPushes.splice(0, pendingPushes.length);
    console.log(`Flushing ${queued.length} queued push(es).`);
    (async () => {
      for (const text of queued) {
        try { await sendResponse(userChatId, text); }
        catch (err) { console.error("queued push failed:", err.message); }
      }
    })();
  }
}

function queuePush(text) {
  if (pendingPushes.length >= MAX_PENDING_PUSHES) pendingPushes.shift();
  pendingPushes.push(text);
  console.log(`No chat id yet — queued push (${pendingPushes.length} held).`);
}

// Serialize /message calls to core — core holds a single Claude session and tracks
// only one pendingResponse, so parallel /message requests from rapid-fire user
// messages would overwrite each other and leave earlier HTTP connections hanging.
// Each message awaits the previous one before calling callClaude.
let messageChain = Promise.resolve();

// Messages queued or in progress in the chain. /model and /effort refuse to
// switch while this is non-zero: a switch restarts the session process and
// would cut off the reply being written.
let messagesInFlight = 0;

// 429-aware Telegram API wrapper. On retry_after, sets mutedUntil; all subsequent
// tg() calls silently skip until that timestamp passes. Keeps us from extending
// a Telegram flood ban by hammering during the cool-down.
let mutedUntil = 0;
async function tg(fn) {
  if (Date.now() < mutedUntil) return null;
  try {
    return await fn();
  } catch (err) {
    const retryAfter = err?.response?.body?.parameters?.retry_after;
    if (retryAfter) {
      mutedUntil = Date.now() + retryAfter * 1000;
      console.error(`Telegram 429. Muted for ${retryAfter}s.`);
    } else {
      console.error("Telegram call failed:", err.message);
    }
    return null;
  }
}

// Typing indicator loop. Telegram auto-expires the typing action after ~5s, so
// we refresh every 4s. Returns a stop() callback.
function startTyping(chatId, { timeoutMs, onTimeout } = {}) {
  tg(() => bot.sendChatAction(chatId, "typing"));
  const id = setInterval(() => tg(() => bot.sendChatAction(chatId, "typing")), 4000);
  // Lifecycle commands (/restart, /save, /compact) only stop typing when core
  // echoes back an exact confirmation string. If core dies before sending it,
  // nothing ever clears the interval and the user sees "typing..." forever with
  // no error. A watchdog bounds that. Ordinary message turns pass no timeout --
  // they can legitimately run for many minutes.
  let watchdog = null;
  const stop = () => {
    clearInterval(id);
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  };
  if (timeoutMs) {
    watchdog = setTimeout(() => {
      clearInterval(id);
      watchdog = null;
      try { onTimeout?.(); } catch (err) { console.error("typing watchdog:", err.message); }
    }, timeoutMs);
  }
  return stop;
}

// How long to wait for a lifecycle confirmation before giving up and telling
// the user, rather than typing into the void.
const LIFECYCLE_TIMEOUT_MS = 180000;

// Telegram caps message text at 4096 chars. Split long text into chunks at
// newline boundaries where possible, falling back to space, then a hard cut.
function splitMessage(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt < maxLen - 500) splitAt = remaining.lastIndexOf(" ", maxLen);
    if (splitAt < maxLen - 500) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\s+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Send a possibly-long response as one or more Telegram messages.
async function sendResponse(chatId, text) {
  for (const chunk of splitMessage(text)) {
    const sent = await tg(() => bot.sendMessage(chatId, toV2(chunk), { parse_mode: "MarkdownV2" }));
    if (!sent) await tg(() => bot.sendMessage(chatId, chunk));
  }
}

// Prevent bot crashes; pick up 429s that slip past tg().
process.on("unhandledRejection", (reason) => {
  const retryAfter = reason?.response?.body?.parameters?.retry_after;
  if (retryAfter) {
    mutedUntil = Date.now() + retryAfter * 1000;
    console.error(`Telegram 429 (unhandled). Muted for ${retryAfter}s.`);
  } else {
    console.error("Unhandled rejection:", reason?.message || reason);
  }
});

// Document classification — routes Telegram file uploads (msg.document) to the
// right Claude content block. PDFs go to a "document" block, images to an
// "image" block, text-like files get inlined into the prompt as text. Anything
// else gets a friendly reject.
const MIME_IMAGE = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]);
const MIME_TEXT_EXTRA = new Set([
  "application/json", "application/xml", "application/javascript",
  "application/yaml", "application/x-yaml", "application/toml",
  "application/x-shellscript", "application/x-sh", "application/sql",
  "application/x-httpd-php",
]);
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "yaml", "yml", "toml", "xml", "html", "htm",
  "csv", "tsv", "log", "ini", "conf", "env", "sh", "bash", "zsh",
  "py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "go", "rs", "java", "c", "cpp",
  "h", "hpp", "cc", "cs", "rb", "php", "swift", "kt", "kts", "lua", "sql",
  "dart", "ex", "exs", "scala", "clj", "r", "m", "mm", "pl", "pm",
]);

function classifyDocument(doc) {
  const mime = (doc.mime_type || "").toLowerCase();
  const filename = doc.file_name || "";
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (MIME_IMAGE.has(mime)) {
    return { kind: "image", mediaType: mime === "image/jpg" ? "image/jpeg" : mime };
  }
  if (mime === "application/pdf" || (mime === "application/octet-stream" && ext === "pdf")) {
    return { kind: "pdf" };
  }
  if (mime.startsWith("text/") || MIME_TEXT_EXTRA.has(mime) || TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text" };
  }
  // Fallback for binary image ext sent as octet-stream
  if (mime === "application/octet-stream" && ["jpg", "jpeg", "png", "gif", "webp"].includes(ext)) {
    return { kind: "image", mediaType: `image/${ext === "jpg" ? "jpeg" : ext}` };
  }
  return { kind: "unsupported", detail: filename || mime || "file" };
}

bot.on("polling_error", (err) => {
  const retryAfter = err?.response?.body?.parameters?.retry_after;
  if (retryAfter) {
    mutedUntil = Date.now() + retryAfter * 1000;
    console.error(`Polling 429. Muted for ${retryAfter}s.`);
  } else {
    console.error("Polling error:", err.message);
  }
});

console.log("silOS bot started. Waiting for messages...");

tg(() => bot.setMyCommands([
  { command: "session", description: "Session info" },
  { command: "model", description: "Show or switch model, e.g. /model claude-opus-4-6" },
  { command: "effort", description: "Show or set effort: low, medium, high, max" },
  { command: "status", description: "Server health status" },
  { command: "routines", description: "View and manage scheduled routines" },
  { command: "restart", description: "Restart the session" },
  { command: "save", description: "Save conversation summary" },
  { command: "compact", description: "Save and compact context" },
]));

bot.on("message", async (msg) => {
  // First line of defense: drop everything from non-owner immediately
  if (msg.from.username !== ALLOWED_USERNAME) return;

  const chatId = msg.chat.id;
  setUserChatId(chatId);

  let text = msg.text;
  let imageData = null;
  let documentData = null;

  // Handle photo messages
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1]; // largest size
    try {
      tg(() => bot.sendChatAction(chatId, "typing"));
      const file = await bot.getFile(photo.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      imageData = {
        base64: buffer.toString("base64"),
        mediaType: file.file_path.endsWith(".png") ? "image/png" : "image/jpeg",
        fileName: null, // Telegram photos don't carry original filenames
      };
      text = msg.caption || "What do you see in this image?";
    } catch (err) {
      console.error("Image download error:", err.message);
      await tg(() => bot.sendMessage(chatId, "Couldn't process that image."));
      return;
    }
  }

  // Handle document (file) messages
  if (msg.document) {
    const doc = msg.document;
    const TELEGRAM_MAX = 20 * 1024 * 1024; // getFile limit for bots
    if (doc.file_size && doc.file_size > TELEGRAM_MAX) {
      await tg(() => bot.sendMessage(chatId, `That file is over Telegram's 20MB download limit for bots. Try trimming or compressing it first.`));
      return;
    }
    const cls = classifyDocument(doc);
    if (cls.kind === "unsupported") {
      await tg(() => bot.sendMessage(chatId, `Sorry — I can't read "${cls.detail}" natively. I handle PDFs, images (jpg/png/gif/webp), and text-based files (txt, md, json, yaml, code, etc.). If it's a .docx or .xlsx, try exporting to PDF first.`));
      return;
    }
    try {
      tg(() => bot.sendChatAction(chatId, "typing"));
      const file = await bot.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());

      if (cls.kind === "image") {
        imageData = {
          base64: buffer.toString("base64"),
          mediaType: cls.mediaType,
          fileName: doc.file_name || null,
        };
        text = msg.caption || "What do you see in this image?";
      } else if (cls.kind === "pdf") {
        documentData = {
          base64: buffer.toString("base64"),
          mediaType: "application/pdf",
          fileName: doc.file_name || null,
        };
        const filename = doc.file_name || "document";
        text = msg.caption ? `[Attached: ${filename}]\n${msg.caption}` : `Take a look at this PDF (${filename}) and summarize.`;
      } else if (cls.kind === "text") {
        const MAX_TEXT = 2 * 1024 * 1024;
        if (buffer.length > MAX_TEXT) {
          await tg(() => bot.sendMessage(chatId, `That text file is ${(buffer.length / 1024 / 1024).toFixed(1)}MB — over the 2MB inline cap. Can you trim it?`));
          return;
        }
        const content = buffer.toString("utf8");
        const filename = doc.file_name || "attached file";
        const caption = msg.caption || "";
        text = `[Attached file: ${filename}]\n\`\`\`\n${content}\n\`\`\`${caption ? `\n\n${caption}` : ""}`;
      }
    } catch (err) {
      console.error("Document download error:", err.message);
      await tg(() => bot.sendMessage(chatId, "Couldn't download that file from Telegram."));
      return;
    }
  }

  // Handle voice messages
  if (msg.voice || msg.audio) {
    const fileId = (msg.voice || msg.audio).file_id;
    try {
      tg(() => bot.sendChatAction(chatId, "typing"));
      text = await transcribeVoice(fileId);
      if (!text || !text.trim()) {
        await tg(() => bot.sendMessage(chatId, "Couldn't make out what you said."));
        return;
      }
      console.log("Transcribed:", text.substring(0, 100));
    } catch (err) {
      console.error("Transcription error:", err.message);
      await tg(() => bot.sendMessage(chatId, "Couldn't transcribe that voice message."));
      return;
    }
  }

  if (!text) return;

  // If replying to a message, include it as context
  if (msg.reply_to_message) {
    if (msg.reply_to_message.text) {
      text = `[Replying to: "${msg.reply_to_message.text}"]\n\n${text}`;
    } else if (msg.reply_to_message.photo && !imageData) {
      // Replying to a photo — download it as context
      try {
        const replyPhoto = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1];
        const file = await bot.getFile(replyPhoto.file_id);
        const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = Buffer.from(await response.arrayBuffer());
        imageData = {
          base64: buffer.toString("base64"),
          mediaType: file.file_path.endsWith(".png") ? "image/png" : "image/jpeg",
          fileName: null,
        };
        if (msg.reply_to_message.caption) {
          text = `[Replying to image with caption: "${msg.reply_to_message.caption}"]\n\n${text}`;
        }
      } catch (err) {
        console.error("Reply image download error:", err.message);
      }
    }
  }

  // /model and /effort — show or switch the session's model / effort level
  const modelCmd = parseModelCommand(text);
  const effortCmd = modelCmd ? null : parseEffortCommand(text);
  if (modelCmd || effortCmd) {
    await handleSwitchCommand(chatId, modelCmd ? "model" : "effort", modelCmd || effortCmd);
    return;
  }

  // Handle session command — read-only session details
  if (text.toLowerCase() === "/session") {
    try {
      await sendInfoMessage(chatId);
    } catch (err) {
      await tg(() => bot.sendMessage(chatId, "Failed to get session info."));
    }
    return;
  }

  // Handle status command — read-only server health
  if (text.toLowerCase() === "/status") {
    try {
      const res = await fetch(ADMIN_URL + "/status");
      const data = await res.json();
      const sent = await tg(() => bot.sendMessage(chatId, toV2(data.text), { parse_mode: "MarkdownV2" }));
      if (!sent) await tg(() => bot.sendMessage(chatId, data.text));
    } catch (err) {
      await tg(() => bot.sendMessage(chatId, "Failed to get server status."));
    }
    return;
  }

  // Handle restart command
  if (text.toLowerCase() === "/restart") {
    global.restartStop = startTyping(chatId, {
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
      onTimeout: () => {
        global.restartStop = null;
        tg(() => bot.sendMessage(
          chatId,
          "_Restart did not confirm within 3 minutes. The session may still have come back \— send a message to check._",
          { parse_mode: "MarkdownV2" },
        )).catch(() => tg(() => bot.sendMessage(
          chatId,
          "Restart did not confirm within 3 minutes. The session may still have come back - send a message to check.",
        )));
      },
    });
    try {
      await fetch(CORE_URL + "/restart", { method: "POST" });
    } catch (err) {
      global.restartStop?.();
      global.restartStop = null;
      await tg(() => bot.sendMessage(chatId, "Failed to restart session."));
    }
    return;
  }

  // Handle save command — save conversation summary without restart or compact
  if (text.toLowerCase() === "/save") {
    global.saveStop = startTyping(chatId);
    try {
      await fetch(CORE_URL + "/save", { method: "POST" });
    } catch (err) {
      global.saveStop?.();
      global.saveStop = null;
      await tg(() => bot.sendMessage(chatId, "Failed to save conversation."));
    }
    return;
  }

  // Handle compact command — save conversation summary then compact context
  if (text.toLowerCase() === "/compact") {
    global.compactStop = startTyping(chatId);
    try {
      await fetch(CORE_URL + "/compact", { method: "POST" });
    } catch (err) {
      global.compactStop?.();
      global.compactStop = null;
      await tg(() => bot.sendMessage(chatId, "Failed to compact session."));
    }
    return;
  }

  // Handle routines command — list scheduled routines with manage buttons
  if (text.toLowerCase() === "/routines") {
    try {
      await sendRoutinesMessage(chatId);
    } catch (err) {
      await tg(() => bot.sendMessage(chatId, "Failed to load routines."));
    }
    return;
  }

  console.log("Received:", text);

  // Claim this message's slot in the serial chain BEFORE the typing loop starts,
  // so a later-arriving message can't race ahead of this one.
  const previousChain = messageChain;
  let resolveMyTurn;
  messageChain = new Promise((resolve) => { resolveMyTurn = resolve; });
  messagesInFlight++;

  // Typing indicator while core processes — refreshed every 4s, no rate-limit risk
  const stopTyping = startTyping(chatId);
  try {
    await previousChain;
    const result = await callClaude(text, imageData, documentData);
    stopTyping();

    // Core answers { cancelled: true } when the turn was dropped deliberately.
    if (result.cancelled) return;

    // Chunks long responses to stay under Telegram's 4096-char message limit.
    await sendResponse(chatId, result.response || "No response received.");
  } catch (err) {
    stopTyping();
    console.error("Error:", err.message);
    await tg(() => bot.sendMessage(chatId, "Something went wrong. Try again."));
  } finally {
    // Always resolve — otherwise the chain deadlocks and every subsequent message hangs
    messagesInFlight--;
    resolveMyTurn();
  }
});

async function transcribeVoice(fileId) {
  const ts = Date.now();
  const oggPath = `/tmp/voice_${ts}.ogg`;
  const wavPath = `/tmp/voice_${ts}.wav`;

  try {
    // Download audio from Telegram
    const file = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(oggPath, buffer);

    // Convert to wav (16kHz mono — what Whisper expects)
    execSync(`ffmpeg -i ${oggPath} -ar 16000 -ac 1 ${wavPath} -y`, { stdio: "ignore" });

    // Transcribe with whisper.cpp
    const result = execSync(
      `whisper -m /opt/whisper/models/ggml-tiny.bin -f ${wavPath} --no-timestamps -nt`,
      { encoding: "utf8", timeout: 60000 }
    ).trim();

    return result;
  } finally {
    // Cleanup temp files
    try { fs.unlinkSync(oggPath); } catch {}
    try { fs.unlinkSync(wavPath); } catch {}
  }
}

// Plain http.request, not fetch: Node's fetch (undici) aborts any request whose
// response headers take longer than 5 minutes with a bare "fetch failed". Core
// deliberately holds /message open until the turn finishes -- long tasks, or a
// message held across a restart -- so that limit killed real turns. Ending the
// wait is core's job (reply, /cancel, or the connection dropping).
function postToCore(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(new URL(urlPath, CORE_URL), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error("Core returned " + res.statusCode));
        }
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(payload);
  });
}

async function callClaude(message, image, document) {
  const body = { text: message };
  if (image) body.image = image;
  if (document) body.document = document;
  // Return the whole object so callers can inspect { cancelled: true } vs { response: ... }
  return await postToCore("/message", body);
}

// Send the /session info display (read-only; /model and /effort change it)
async function sendInfoMessage(chatId) {
  const res = await fetch(CORE_URL + "/info");
  const data = await res.json();
  // **bold** (CommonMark) — the converter maps that to V2 *bold*. Single-asterisk
  // here would be parsed as italic, which is wrong for a header row.
  const infoText = [
    "\u{2139}\uFE0F **Session Info** \u{2139}\uFE0F",
    `Model: ${data.model}`,
    `Effort: ${data.effort}`,
    `Uptime: ${data.uptime}`,
    `Messages: ${data.messages}`,
  ].join("\n");
  const sent = await tg(() => bot.sendMessage(chatId, toV2(infoText), { parse_mode: "MarkdownV2" }));
  if (!sent) await tg(() => bot.sendMessage(chatId, infoText.replace(/\*\*/g, "")));
}

async function sendPlain(chatId, text) {
  await tg(() => bot.sendMessage(chatId, text));
}

// /model and /effort. `cmd` is the parser result: show | set | invalid.
async function handleSwitchCommand(chatId, what, cmd) {
  if (cmd.kind === "invalid") return sendPlain(chatId, cmd.reason);

  let info;
  try {
    info = await (await fetch(CORE_URL + "/info")).json();
  } catch {
    return sendPlain(chatId, "Couldn't reach the session. Try again in a moment.");
  }
  const current = what === "model" ? info.model : info.effort;

  if (cmd.kind === "show") {
    return sendPlain(chatId, what === "model"
      ? `Model: ${current}\nSwitch with /model <model-id>, e.g. /model claude-opus-4-6 (or opus / sonnet / haiku).`
      : `Effort: ${current}\nSet with /effort <level>: ${EFFORTS.join(", ")}.`);
  }

  if (messagesInFlight > 0) {
    return sendPlain(chatId, `Wait for the current reply to finish, then switch. Still on ${current}.`);
  }

  const target = what === "model" ? cmd.model : cmd.effort;
  const stopTyping = startTyping(chatId);
  try {
    const res = await fetch(CORE_URL + "/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(what === "model" ? { model: cmd.model } : { effort: cmd.effort }),
    });
    const data = await res.json().catch(() => ({}));
    stopTyping();
    if (res.ok && data.ok) {
      return sendPlain(chatId, what === "model" ? `Switched to ${data.model}.` : `Effort set to ${data.effort}.`);
    }
    const reason = data.error ? `: ${String(data.error).slice(0, 200)}` : "";
    return sendPlain(chatId, `Couldn't switch to ${target}${reason}. Still on ${current}.`);
  } catch (err) {
    stopTyping();
    return sendPlain(chatId, `Couldn't switch to ${target}: ${err.message}. Still on ${current}.`);
  }
}

// Render the /routines list with per-routine [Toggle] [Delete] buttons and a
// [Refresh] footer. Mirrors sendInfoMessage's edit-in-place pattern so callbacks
// can refresh the same message.
async function sendRoutinesMessage(chatId, editMsgId) {
  const res = await fetch(CORE_URL + "/routines");
  const routines = await res.json();

  const keyboard = [];
  let bodyText;

  if (!Array.isArray(routines) || routines.length === 0) {
    bodyText = "_No routines scheduled._";
  } else {
    const lines = ["**Routines**", ""];
    for (const r of routines) {
      const state = r.enabled ? "on" : "off";
      lines.push(`• ${r.title} — \`${r.schedule}\` (${state})`);
      const toggleLabel = (r.enabled ? "Disable" : "Enable") + ": " + r.title;
      keyboard.push([
        { text: toggleLabel.slice(0, 48), callback_data: "toggle_routine_" + r.id },
        { text: "Delete", callback_data: "delete_routine_" + r.id },
      ]);
    }
    bodyText = lines.join("\n");
  }
  keyboard.push([{ text: "Refresh", callback_data: "routines_refresh" }]);

  const opts = { parse_mode: "MarkdownV2", reply_markup: { inline_keyboard: keyboard } };
  if (editMsgId) {
    await tg(() => bot.editMessageText(toV2(bodyText), { chat_id: chatId, message_id: editMsgId, ...opts }));
  } else {
    await tg(() => bot.sendMessage(chatId, toV2(bodyText), opts));
  }
}

// Handle inline keyboard callbacks (routine management)
bot.on("callback_query", async (query) => {
  if (query.from.username !== ALLOWED_USERNAME) return;

  const chatId = query.message.chat.id;
  const msgId = query.message.message_id;

  // Routine management — toggle enabled, delete, or refresh the list in place.
  if (query.data.startsWith("toggle_routine_")) {
    const id = query.data.replace("toggle_routine_", "");
    await tg(() => bot.answerCallbackQuery(query.id));
    await fetch(CORE_URL + "/routine/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    await sendRoutinesMessage(chatId, msgId).catch(() => {});
    return;
  }

  if (query.data.startsWith("delete_routine_")) {
    const id = query.data.replace("delete_routine_", "");
    await tg(() => bot.answerCallbackQuery(query.id));
    await fetch(CORE_URL + "/routine/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
    await sendRoutinesMessage(chatId, msgId).catch(() => {});
    return;
  }

  if (query.data === "routines_refresh") {
    await tg(() => bot.answerCallbackQuery(query.id));
    await sendRoutinesMessage(chatId, msgId).catch(() => {});
    return;
  }

  await tg(() => bot.answerCallbackQuery(query.id));
});

// Notification server — core POSTs to /notify for status strings, /send-file
// to relay a file from the (read-only) shared vault mount to the user via Telegram.
const notifyServer = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }

  if (req.url === "/notify") return handleNotify(req, res);
  if (req.url === "/push-message") return handlePushMessage(req, res);
  if (req.url === "/send-file") return handleSendFile(req, res);
  if (req.url === "/send-venue") return handleSendVenue(req, res);

  res.writeHead(404);
  res.end();
});

function handleNotify(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();

    const { text } = parsed;
    if (!userChatId || !text) return;

    // Stop the relevant typing loop before sending the final status. Core sends
    // "Session restarted." without italic wrappers; wrap it here for consistency
    // with the other status messages.
    let sendText = text;
    if (text === "_Conversation saved._") {
      global.saveStop?.();
      global.saveStop = null;
    } else if (text === "Session restarted.") {
      global.restartStop?.();
      global.restartStop = null;
      sendText = "_Session restarted._";
    } else if (text === "_Compaction complete._") {
      global.compactStop?.();
      global.compactStop = null;
    }

    // Route through sendResponse for V2 conversion, chunking, and plain-text
    // fallback — same delivery path as routine pushes and normal answers.
    sendResponse(userChatId, sendText).catch((err) =>
      console.error("notify sendResponse failed:", err.message)
    );
    console.log("Notification sent:", sendText);
  });
}

// Core POSTs here when a routine fires: { text }. Delivered to the user via
// sendResponse (4000-char chunking + MarkdownV2). Unsolicited — there's no
// pending request on the bot side, so it just sends fresh message(s).
function handlePushMessage(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const reply = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: "Invalid JSON" });
    }
    const { text } = parsed;
    if (!text || typeof text !== "string") return reply(400, { error: "Missing 'text' string" });
    if (!userChatId) {
      queuePush(text);
      return reply(202, { queued: true, note: "No chat id yet; will deliver when the user next messages." });
    }
    try {
      await sendResponse(userChatId, text);
      reply(200, { sent: true });
    } catch (err) {
      console.error("push-message error:", err.message);
      reply(500, { error: err.message });
    }
  });
}

// Accepts { path, caption? }. path MUST resolve inside /app/vault/ — the only
// thing the bot has bind-mounted. Refuses anything else so core can't trick
// the bot into exfiltrating arbitrary container files. Max 50MB per Telegram
// Bot API upload limit. Images go as photos, everything else as documents.
function handleSendFile(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const reply = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: "Invalid JSON" });
    }

    const { path: filePath, caption } = parsed;

    if (!userChatId) return reply(503, { error: "No active chat yet — user must message the bot first." });
    if (!filePath || typeof filePath !== "string") return reply(400, { error: "Missing 'path' string" });

    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(VAULT_ROOT + path.sep) && resolved !== VAULT_ROOT) {
      return reply(400, { error: `Path must be inside ${VAULT_ROOT}` });
    }
    if (!fs.existsSync(resolved)) return reply(404, { error: "File not found" });

    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return reply(400, { error: "Not a regular file" });
    if (stat.size > TELEGRAM_SEND_MAX) {
      return reply(413, { error: `File is ${Math.round(stat.size / 1024 / 1024)}MB; Telegram bot upload cap is 50MB` });
    }

    const ext = path.extname(resolved).slice(1).toLowerCase();
    const opts = {};
    if (caption && typeof caption === "string") opts.caption = caption;

    try {
      const sendKind = IMAGE_EXT.has(ext) ? "photo" : "document";
      const sent = sendKind === "photo"
        ? await tg(() => bot.sendPhoto(userChatId, resolved, opts))
        : await tg(() => bot.sendDocument(userChatId, resolved, opts));

      if (!sent) return reply(502, { error: "Telegram call failed (rate-limit or similar — see bot logs)" });

      console.log(`send-file: ${sendKind} ${path.basename(resolved)} (${stat.size}B)`);
      reply(200, { sent: true, kind: sendKind, bytes: stat.size });
    } catch (err) {
      console.error("send-file error:", err.message);
      reply(500, { error: err.message });
    }
  });
}

// Accepts { lat, lng, title, address }. Calls bot.sendVenue to ship a pin
// card with title + address. Opens in the user's preferred maps app on tap.
function handleSendVenue(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    const reply = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return reply(400, { error: "Invalid JSON" });
    }

    const { lat, lng, title, address } = parsed;
    if (!userChatId) return reply(503, { error: "No active chat yet — user must message the bot first." });
    if (typeof lat !== "number" || typeof lng !== "number") {
      return reply(400, { error: "lat and lng must be numbers" });
    }
    if (!title || !address) return reply(400, { error: "title and address required" });

    try {
      const sent = await tg(() => bot.sendVenue(userChatId, lat, lng, title, address));
      if (!sent) return reply(502, { error: "Telegram call failed (rate-limit or similar)" });
      console.log(`send-venue: ${title} @ ${lat},${lng}`);
      reply(200, { sent: true });
    } catch (err) {
      console.error("send-venue error:", err.message);
      reply(500, { error: err.message });
    }
  });
}

notifyServer.listen(3001, () => {
  console.log("Notification server listening on port 3001");
});
