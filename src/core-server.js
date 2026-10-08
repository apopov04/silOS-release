import { query } from "@anthropic-ai/claude-agent-sdk";
import http from "http";
import fs from "fs";
import path from "path";
import indexer from "./vault-indexer.js";
import registry from "./registry.js";
import scheduler from "./scheduler.js";
import matter from "gray-matter";
import { writeGraph } from "./graph-export.js";
import modelCommand from "./model-command.cjs";

const PORT = 3000;
const BOT_NOTIFY_URL = "http://bot:3001/notify";
const BOT_PUSH_URL = "http://bot:3001/push-message";
const VAULT_PATH = "/app/vault";
const GRAPH_DIR = "/app/data/graph";
const CORE_DIR = path.join(VAULT_PATH, "core");
const ASSETS_INCOMING = path.join(VAULT_PATH, "assets", "incoming");
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// Bot-uploaded binaries (PDFs, images) land here as a staging area. If the
// Claude session decides to persist them, it `mv`s to `vault/assets/<slug>.<ext>`
// and writes a paired stub in vault/core/. Unclaimed files accumulate for later
// cleanup (see "hygiene reports" in BIG-FKN-PROBLEMS.md).
function sanitizeFilenamePart(name) {
  return String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
}

function defaultExtFor(mediaType) {
  if (mediaType === "application/pdf") return "pdf";
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/gif") return "gif";
  if (mediaType === "image/webp") return "webp";
  return "bin";
}

function stageAsset(kind, attachment) {
  if (!attachment || !attachment.base64) return null;
  try {
    fs.mkdirSync(ASSETS_INCOMING, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const base = attachment.fileName
      ? sanitizeFilenamePart(attachment.fileName)
      : `${kind}.${defaultExtFor(attachment.mediaType)}`;
    const filename = `${ts}-${base}`;
    const fullPath = path.join(ASSETS_INCOMING, filename);
    fs.writeFileSync(fullPath, Buffer.from(attachment.base64, "base64"));
    return { kind, path: fullPath, fileName: attachment.fileName || null, mediaType: attachment.mediaType };
  } catch (err) {
    console.error("Failed to stage asset:", err.message);
    return null;
  }
}

const SUMMARY_PROMPT = `The session is about to restart. Before it ends, save a conversation summary to the vault.

Write a file to /app/vault/conversations/ with a filename based on the current date and time (e.g., 2026-04-09-1730.md).

The file MUST have:
- Frontmatter: title, type: conversation, entities (people mentioned), tags, created, updated
- A concise summary of what was discussed this session
- Key facts, decisions, preferences, or action items mentioned
- Anything the user might expect you to remember next session

Do this NOW using the Write tool. Do not ask for confirmation. Do not respond with anything else.`;

// Vault instructions moved to vault/startup/vault-instructions.md so they're
// editable without a redeploy. buildStartupContext() already reads all .md
// files from vault/startup/ so the content flows in automatically.

function buildStartupContext() {
  let context = "";

  const startupDir = path.join(VAULT_PATH, "startup");
  try {
    if (fs.existsSync(startupDir)) {
      const files = fs.readdirSync(startupDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        context += fs.readFileSync(path.join(startupDir, file), "utf8") + "\n\n";
      }
    }
  } catch (err) {
    console.error("Failed to read startup files:", err.message);
  }

  const convDir = path.join(VAULT_PATH, "conversations");
  try {
    if (fs.existsSync(convDir)) {
      const files = fs.readdirSync(convDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .slice(-3);
      if (files.length > 0) {
        context += "\n## Recent Conversation Summaries\nThese are summaries from your most recent sessions. Use them to maintain continuity.\n\n";
        for (const file of files) {
          context += fs.readFileSync(path.join(convDir, file), "utf8") + "\n\n";
        }
      }
    }
  } catch (err) {
    console.error("Failed to read conversation summaries:", err.message);
  }

  // Include the (auto-generated) agent/root registry directly in startup so the
  // model sees installed specialists up-front instead of having to go read the
  // file on its own. Without this, it tends to reach for Claude Code's built-in
  // /mcp integrations rather than delegate to local agents.
  const registryPath = path.join(VAULT_PATH, "agents", "registry.md");
  try {
    if (fs.existsSync(registryPath)) {
      context += "\n" + fs.readFileSync(registryPath, "utf8") + "\n";
    }
  } catch (err) {
    console.error("Failed to read agent registry:", err.message);
  }

  return context;
}

// Message queue
const RESTART_SIGNAL = Symbol("restart");
const COMPACT_SIGNAL = Symbol("compact");
const SAVE_SIGNAL = Symbol("save");
const SWITCH_SIGNAL = Symbol("switch");
let messageQueue = [];
let messageResolver = null;

function pushMessage(msg) {
  if (messageResolver) {
    const resolve = messageResolver;
    messageResolver = null;
    resolve(msg);
  } else {
    messageQueue.push(msg);
  }
}

function waitForMessage() {
  if (messageQueue.length > 0) {
    return Promise.resolve(messageQueue.shift());
  }
  return new Promise((resolve) => {
    messageResolver = resolve;
  });
}

let userRequestedRestart = false;

// A /restart first asks the model to write a conversation summary, so the
// process stays alive for seconds before it actually recycles. If it dies in
// that window the in-memory flag dies with it, the replacement process starts
// with sessionRestartCount back at 0, and the confirmation is never sent --
// leaving the bot's typing loop running forever. Persist the intent instead.
// /tmp is tmpfs, so it survives a process restart inside the same container
// (which is exactly the crash case) and is discarded on a real recreate.
const RESTART_MARKER = "/tmp/silos-restart-requested";

function markRestartRequested() {
  try { fs.writeFileSync(RESTART_MARKER, String(Date.now())); } catch { /* best effort */ }
}

function consumeRestartMarker() {
  try {
    if (fs.existsSync(RESTART_MARKER)) {
      fs.unlinkSync(RESTART_MARKER);
      return true;
    }
  } catch { /* best effort */ }
  return false;
}

function triggerRestart() {
  userRequestedRestart = true;
  markRestartRequested();
  // Explicit user restart supersedes any prior /cancel — otherwise a leaked
  // pendingCancel could cause the after-loop logic to resume instead of
  // fresh-restarting.
  pendingCancel = false;
  messageQueue = [];
  turnRouting = [];
  // Hold new turns until the fresh session is up. Without this, a message sent
  // while the model writes its restart summary is merged into that summary
  // turn: its answer is swallowed and the bot's request hangs forever.
  restarting = true;
  // Whatever turn was in flight just lost its routing descriptor, so its result
  // can never reach this response. Close it so the bot's queue moves on.
  abandonPendingResponse();
  pushMessage(RESTART_SIGNAL);
}

let restarting = false;

// Turns (user messages and routine fires) that arrive while the session can't
// take them -- still initializing, or writing its restart summary -- wait here
// and are enqueued in arrival order once the session is ready. Feeding them in
// earlier merges them into the init/summary turn, where they vanish.
let heldTurns = [];

function enqueueTurn(turn) {
  if (!sessionReady || restarting) {
    heldTurns.push(turn);
    return;
  }
  // A user turn owns the HTTP channel from the moment it is enqueued.
  if (turn.res) pendingResponse = turn.res;
  // Routing descriptor must precede the turn's result in FIFO order.
  turnRouting.push({ routineFire: turn.routineFire || null });
  pushMessage(turn.msg);
}

function releaseHeldTurns() {
  const held = heldTurns;
  heldTurns = [];
  if (held.length > 0) console.log(`Releasing ${held.length} held turn(s).`);
  for (const turn of held) enqueueTurn(turn);
}

function abandonPendingResponse() {
  if (!pendingResponse) return;
  try {
    pendingResponse.writeHead(200, { "Content-Type": "application/json" });
    pendingResponse.end(JSON.stringify({
      response: "_The session restarted before I could answer that. Please send it again._",
    }));
  } catch { /* connection already gone */ }
  pendingResponse = null;
}

// Track pending HTTP responses
let pendingResponse = null;

// FIFO of routing descriptors, one per genuine turn (a user message or a routine
// fire), in enqueue order. The SDK emits exactly one `result` per turn in that
// same order, so the result handler shifts the head to learn where THIS turn's
// response goes: a user turn -> the open HTTP response (pendingResponse); a
// routine fire -> the bot's /push-message endpoint (unsolicited delivery).
// Lifecycle signals (save/restart/compact/switch) and the init turn are handled
// by earlier `continue` branches and never push or shift, so alignment holds.
// Cleared on cancel/switch/restart so a dropped turn can't misalign later ones.
let turnRouting = [];

// Reference to the active SDK query — used by /cancel to call .interrupt()
let currentQuery = null;

// Set by /cancel. After the for-await loop exits, we resume the session to
// preserve conversation context (fresh startSession would lose it).
let pendingCancel = false;

// Session management
let sessionReady = false;
let sessionRestartCount = 0;
let compactWarned = false;
let sessionModel = "unknown";
let sessionEffort = "default";
let sessionStartTime = null;
let sessionMessageCount = 0;
let currentSessionId = null;
let pendingSwitch = null;
// Model / effort chosen via /switch (undefined = Claude Code's default). Passed
// on EVERY session start -- resume and fresh -- so changing one never silently
// resets the other, and a /restart keeps the user's choice.
let chosenModel;
let chosenEffort;
const CONTEXT_LIMIT = 1000000;
const WARN_THRESHOLD = 0.7;

const ALLOWED_TOOLS = [
  "Bash", "Read", "Write", "Edit", "Glob", "Grep",
  "WebFetch", "WebSearch", "Agent",
];

async function notifyBot(text) {
  try {
    await fetch(BOT_NOTIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Failed to notify bot:", err.message);
  }
}

// Deliver a routine's response to the user unsolicited (the bot chunks +
// MarkdownV2-converts via its /push-message handler).
async function pushToBot(text) {
  try {
    await fetch(BOT_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error("Failed to push routine message to bot:", err.message);
  }
}

// scheduler's onFire callback: build the prompt (with a late notice for missed
// one-shots), record the routing descriptor, and enqueue it like a user turn.
// The descriptor MUST be pushed before pushMessage so it lands ahead of the
// turn's result in FIFO order.
function onRoutineFire(routine, meta = {}) {
  let prompt = routine.prompt || "";
  if (meta.late && meta.scheduledFor) {
    const sched = new Date(meta.scheduledFor);
    const mins = Math.max(1, Math.round((Date.now() - sched.getTime()) / 60000));
    prompt = `(This routine was scheduled for ${sched.toISOString()} but core was offline; firing now, ~${mins}m late.)\n\n${prompt}`;
  }
  console.log(`[routine-fire] enqueue ${routine.id}${meta.late ? " (late)" : ""}`);
  enqueueTurn({ routineFire: routine.id, msg: { text: prompt } });
}

// Routine note file helpers (core has rw vault access; the bot's mount is
// read-only). The scheduler's file-watcher reacts to these writes/removals.
function readRoutineNotes() {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(CORE_DIR);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const { data: fm } = matter(fs.readFileSync(path.join(CORE_DIR, f), "utf8"));
      if (fm.type !== "routine") continue;
      out.push({
        id: fm.id,
        title: fm.title,
        schedule: fm.schedule instanceof Date ? fm.schedule.toISOString() : fm.schedule,
        kind: fm.kind,
        enabled: fm.enabled !== false,
        last_fired: fm.last_fired || "",
        fire_count: Number(fm.fire_count) || 0,
      });
    } catch {
      /* skip unreadable note */
    }
  }
  return out;
}

function toggleRoutineFile(id) {
  if (!SLUG_RE.test(id)) return { ok: false, error: "invalid id" };
  const p = path.join(CORE_DIR, `${id}.md`);
  if (!fs.existsSync(p)) return { ok: false, error: "not found" };
  const { data: fm, content } = matter(fs.readFileSync(p, "utf8"));
  if (fm.type !== "routine") return { ok: false, error: "not a routine" };
  fm.enabled = fm.enabled === false ? true : false;
  fm.updated = new Date().toISOString().slice(0, 10);
  if (fm.schedule instanceof Date) fm.schedule = fm.schedule.toISOString();
  fs.writeFileSync(p, matter.stringify(content, fm));
  return { ok: true, id, enabled: fm.enabled };
}

function deleteRoutineFile(id) {
  if (!SLUG_RE.test(id)) return { ok: false, error: "invalid id" };
  const p = path.join(CORE_DIR, `${id}.md`);
  if (!fs.existsSync(p)) return { ok: false, error: "not found" };
  const { data: fm } = matter(fs.readFileSync(p, "utf8"));
  if (fm.type !== "routine") return { ok: false, error: "not a routine" };
  fs.unlinkSync(p);
  return { ok: true, id };
}

async function startSession(resumeOptions) {
  sessionReady = false;
  compactWarned = false;
  // Reset in case a prior interrupt left it set but the for-await loop never exited
  // (e.g. interrupt was a no-op because the query had already completed)
  pendingCancel = false;
  // No turn is in flight at (re)start; drop any descriptors from the old loop.
  turnRouting = [];

  const isResume = !!resumeOptions?.sessionId;

  if (!isResume) {
    sessionStartTime = Date.now();
    sessionMessageCount = 0;
    // A fresh session has no memory of any turn the old one was running.
    abandonPendingResponse();

    // The marker check must come first: after a crash mid-restart this is a
    // brand-new process, so sessionRestartCount is 0 and the old guard skipped
    // the notify entirely -- no "Session restarted.", no "Session crashed.",
    // and a bot left typing forever.
    // Consume unconditionally -- `flag || consume()` would short-circuit on the
    // healthy in-process path and strand the marker, so the next unrelated
    // restart would read it and falsely report a user-requested restart.
    const markerPresent = consumeRestartMarker();
    const restartWasRequested = userRequestedRestart || markerPresent;

    if (restartWasRequested) {
      await notifyBot("Session restarted.");
      userRequestedRestart = false;
    } else if (sessionRestartCount > 0) {
      await notifyBot("Session crashed.");
    }
    sessionRestartCount++;
  }

  if (resumeOptions?.model) sessionModel = resumeOptions.displayModel || resumeOptions.model;
  if (resumeOptions?.effort) sessionEffort = resumeOptions.effort;

  const startupContext = buildStartupContext();

  let summaryPending = false;
  let compactPending = false;
  let savePending = false;

  async function* messageGenerator() {
    // Only inject init message on fresh sessions, not resumes
    if (!isResume) {
      yield {
        type: "user",
        message: {
          role: "user",
          content: "Read and acknowledge your standing orders and vault instructions. Do not respond to the user yet — just confirm you understand by saying 'Session initialized.'\n\n" + startupContext,
        },
      };
    }

    while (true) {
      const msg = await waitForMessage();

      if (msg === SWITCH_SIGNAL) {
        // A stray signal with no switch pending (e.g. one that landed in the
        // queue while a previous switch was resuming) must not end this
        // session: the after-loop fallback would start a FRESH session and
        // drop the conversation.
        if (!pendingSwitch) continue;
        // End the generator cleanly — no summary, session will be resumed
        return;
      }

      if (msg === RESTART_SIGNAL) {
        if (!summaryPending) {
          summaryPending = true;
          yield {
            type: "user",
            message: { role: "user", content: SUMMARY_PROMPT },
          };
          continue;
        }
        summaryPending = false;
        return;
      }

      if (msg === SAVE_SIGNAL) {
        savePending = true;
        yield {
          type: "user",
          message: { role: "user", content: SUMMARY_PROMPT },
        };
        continue;
      }

      if (msg === COMPACT_SIGNAL) {
        if (!compactPending) {
          compactPending = "summary";
          yield {
            type: "user",
            message: { role: "user", content: SUMMARY_PROMPT },
          };
          continue;
        }
        if (compactPending === "compact") {
          compactPending = false;
          console.log("Compaction complete.");
          continue;
        }
      }

      let content;
      if (msg.image || msg.document) {
        content = [{ type: "text", text: msg.text }];
        if (msg.document) {
          content.push({
            type: "document",
            source: {
              type: "base64",
              media_type: msg.document.mediaType,
              data: msg.document.base64,
            },
          });
        }
        if (msg.image) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: msg.image.mediaType,
              data: msg.image.base64,
            },
          });
        }
        if (msg.stagedAssets && msg.stagedAssets.length > 0) {
          const lines = msg.stagedAssets
            .map((a) => `- ${a.kind} (${a.mediaType || "unknown"})${a.fileName ? `, original name: ${a.fileName}` : ""} staged at ${a.path}`)
            .join("\n");
          content.push({
            type: "text",
            text: `\n(Attachment staging info — if the user wants any of these persisted into the vault, see vault-instructions.md §"Asset notes". Otherwise ignore; staged files get cleaned up later.\n${lines}\n)`,
          });
        }
      } else {
        content = msg.text;
      }

      yield {
        type: "user",
        message: { role: "user", content },
      };
    }
  }

  try {
    let lastAssistantText = "";
    let initResponseHandled = isResume; // Skip init handling on resume

    const queryOptions = {
      permissionMode: "bypassPermissions",
      allowedTools: ALLOWED_TOOLS,
    };

    if (isResume) {
      queryOptions.resume = resumeOptions.sessionId;
      console.log(`Resuming session ${resumeOptions.sessionId} with model=${chosenModel || "default"}, effort=${chosenEffort || "default"}`);
    } else {
      queryOptions.appendSystemPrompt = startupContext;
      console.log(`Starting fresh Claude session (model=${chosenModel || "default"}, effort=${chosenEffort || "default"})...`);
    }
    if (chosenModel) queryOptions.model = chosenModel;
    if (chosenEffort) queryOptions.effort = chosenEffort;

    sessionReady = isResume; // Resume is immediately ready (no init message to wait for)
    if (isResume) releaseHeldTurns();

    currentQuery = query({
      prompt: messageGenerator(),
      options: queryOptions,
    });

    for await (const message of currentQuery) {
      // Capture session ID and model from SDK system message
      if (message.type === "system") {
        if (message.session_id) currentSessionId = message.session_id;
        // The init message reports what Claude Code actually runs, so it is
        // the source of truth for /info (not what was requested).
        if (message.model) {
          sessionModel = message.model.replace(/\[.*?\]/g, "").trim();
          console.log(`Session model: ${message.model}`);
        }
        if (message.effort) sessionEffort = message.effort;
      }

      if (message.type === "assistant" && message.message?.content) {
        const textBlocks = message.message.content
          .filter((b) => b.type === "text")
          .map((b) => b.text);
        lastAssistantText = textBlocks.join("\n");
      }

      if (message.type === "result") {
        if (!initResponseHandled) {
          initResponseHandled = true;
          sessionReady = true;
          restarting = false;
          console.log("Claude session ready. Standing orders loaded.");
          releaseHeldTurns();
          continue;
        }

        if (savePending) {
          console.log("Conversation saved.");
          savePending = false;
          notifyBot("_Conversation saved._");
          continue;
        }

        if (summaryPending) {
          console.log("Conversation summary saved.");
          pushMessage(RESTART_SIGNAL);
          continue;
        }

        if (compactPending === "summary") {
          console.log("Conversation summary saved. Triggering compaction...");
          compactPending = "compact";
          pushMessage({ text: "/compact" });
          continue;
        }

        if (compactPending === "compact") {
          console.log("Compaction complete.");
          compactPending = false;
          notifyBot("_Compaction complete._");
          continue;
        }

        // This turn's routing descriptor (FIFO with the order it was enqueued).
        const routing = turnRouting.shift();
        const responseText = message.result || lastAssistantText || "";
        lastAssistantText = "";

        if (message.usage && !compactWarned) {
          const totalTokens = (message.usage.input_tokens || 0) + (message.usage.output_tokens || 0)
            + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0);
          if (totalTokens > CONTEXT_LIMIT * WARN_THRESHOLD) {
            compactWarned = true;
            notifyBot("_Autocompact due soon..._");
          }
        }

        if (routing && routing.routineFire) {
          // Routine fire — deliver unsolicited via the bot. Never touches the
          // user's HTTP channel, so a concurrent user turn keeps its connection.
          console.log(`[routine-fire] ${routing.routineFire} -> /push-message`);
          if (responseText) pushToBot(responseText);
        } else {
          // User turn — resolve the open HTTP request.
          if (pendingResponse && responseText) {
            console.log("[user-turn] -> pendingResponse");
            pendingResponse.writeHead(200, {
              "Content-Type": "application/json",
            });
            pendingResponse.end(JSON.stringify({ response: responseText }));
            pendingResponse = null;
          } else if (responseText) {
            // No open HTTP channel for this turn. Happens when turnRouting was
            // reset mid-flight (restart/cancel/switch), when the bot's request
            // already timed out, or when a later turn overwrote pendingResponse.
            // The old code dropped the text on the floor with no log -- the
            // "it never sent the follow-up" failure. Deliver it unsolicited.
            console.log("[user-turn] no pendingResponse -> /push-message fallback");
            pushToBot(responseText);
          }
        }
      }
    }
  } catch (err) {
    // interrupt() may surface as AbortError — that's expected on /cancel, not a real crash
    if (err?.name === "AbortError") {
      console.log("Query interrupted.");
    } else {
      console.error("Session error:", err.message);
    }
  }

  currentQuery = null;

  // After query loop ends — decide what to do next. Switch takes priority
  // because it's an explicit user action (different model); cancel just preserves
  // context on the current model.
  if (pendingSwitch) {
    const switchOpts = pendingSwitch;
    pendingSwitch = null;
    console.log(`Switching to model=${switchOpts.model || sessionModel}, effort=${switchOpts.effort || sessionEffort}`);
    startSession({
      sessionId: currentSessionId,
      model: switchOpts.model,
      displayModel: switchOpts.displayModel,
      effort: switchOpts.effort,
    });
  } else if (pendingCancel) {
    pendingCancel = false;
    console.log("Cancel complete. Resuming session to preserve context.");
    startSession({ sessionId: currentSessionId });
  } else {
    setTimeout(startSession, 1000);
  }
}

// Check a model ID works before moving the live session onto it. A switch to a
// nonexistent model would otherwise leave every later message failing. Costs
// one tiny one-turn request. Resolves { ok, model } (the ID Claude Code
// reports, [1m]-style suffixes stripped) or { ok: false, error }.
const PROBE_TIMEOUT_MS = 60000;
async function probeModel(model) {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), PROBE_TIMEOUT_MS);
  let resolved = null;
  try {
    const q = query({
      prompt: "Reply with exactly: OK",
      options: { model, maxTurns: 1, allowedTools: [], abortController },
    });
    for await (const m of q) {
      if (m.type === "system" && m.model) resolved = m.model.replace(/\[.*?\]/g, "").trim();
      if (m.type === "result") {
        if (m.is_error || m.subtype !== "success") {
          return { ok: false, error: String(m.result || m.subtype || "model check failed") };
        }
        return { ok: true, model: resolved || model };
      }
    }
    return { ok: false, error: "model check returned no result" };
  } catch (err) {
    return { ok: false, error: err?.name === "AbortError" ? "model check timed out" : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

let switching = false;
let chosenModelDisplay = null;
const SWITCH_READY_TIMEOUT_MS = 30000;

function waitForSessionReady(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    (function check() {
      if (sessionReady) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 100);
    })();
  });
}

// HTTP server
const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/info") {
    const uptimeMs = Date.now() - (sessionStartTime || Date.now());
    const hours = Math.floor(uptimeMs / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      model: sessionModel,
      effort: sessionEffort,
      uptime: `${hours}h ${minutes}m`,
      messages: sessionMessageCount,
    }));
    return;
  }

  if (req.method === "GET" && req.url === "/registry") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      roots: registry.getRoots(),
      agents: registry.getAgents(),
    }, null, 2));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ ready: sessionReady, restarts: sessionRestartCount })
    );
    return;
  }

  if (req.method === "POST" && req.url === "/restart") {
    console.log("Restart requested.");
    triggerRestart();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "restarting" }));
    return;
  }

  if (req.method === "POST" && req.url === "/save") {
    console.log("Save requested.");
    pushMessage(SAVE_SIGNAL);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "saving" }));
    return;
  }

  if (req.method === "POST" && req.url === "/compact") {
    console.log("Compact requested.");
    pushMessage(COMPACT_SIGNAL);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "compacting" }));
    return;
  }

  if (req.method === "POST" && req.url === "/cancel") {
    console.log("Cancel requested.");
    // Drain the pending HTTP response so the bot's callClaude resolves immediately
    if (pendingResponse) {
      try {
        pendingResponse.writeHead(200, { "Content-Type": "application/json" });
        pendingResponse.end(JSON.stringify({ cancelled: true }));
      } catch {}
      pendingResponse = null;
    }
    // Drop any queued user messages — they shouldn't survive a cancel
    messageQueue = [];
    for (const t of heldTurns) {
      if (!t.res) continue;
      try {
        t.res.writeHead(200, { "Content-Type": "application/json" });
        t.res.end(JSON.stringify({ cancelled: true }));
      } catch {}
    }
    heldTurns = heldTurns.filter((t) => !t.res);
    // Drop routing descriptors too — their turns are being abandoned, and a
    // leaked descriptor would misroute the next genuine turn's result.
    turnRouting = [];
    // Interrupt the SDK; interrupt() is a Promise but we fire-and-forget
    pendingCancel = true;
    if (currentQuery) {
      currentQuery.interrupt().catch((err) => {
        console.error("Interrupt failed:", err?.message || err);
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "cancelling" }));
    return;
  }

  if (req.method === "POST" && req.url === "/switch") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", async () => {
      const reply = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      let model, effort;
      try {
        ({ model, effort } = JSON.parse(body));
      } catch {
        return reply(400, { ok: false, error: "Invalid JSON" });
      }
      // Re-validate here: the bot is not the only possible caller.
      if (model !== undefined && !modelCommand.isValidModelId(model)) return reply(400, { ok: false, error: "Invalid model ID" });
      if (effort !== undefined && !modelCommand.isValidEffort(effort)) return reply(400, { ok: false, error: "Invalid effort" });
      if (model === undefined && effort === undefined) return reply(400, { ok: false, error: "Nothing to switch" });
      if (switching) return reply(409, { ok: false, error: "A switch is already in progress" });

      switching = true;
      try {
        console.log(`Switch requested: model=${model || "-"}, effort=${effort || "-"}`);
        let displayModel;
        if (model !== undefined) {
          const probe = await probeModel(model);
          if (!probe.ok) {
            console.log(`Switch rejected: model ${model} failed check (${probe.error.slice(0, 200)})`);
            return reply(400, { ok: false, error: probe.error.slice(0, 300), current: sessionModel });
          }
          displayModel = probe.model;
        }
        if (model !== undefined) { chosenModel = model; chosenModelDisplay = displayModel; }
        if (effort !== undefined) chosenEffort = effort;
        pendingSwitch = { model: chosenModel, effort: chosenEffort, displayModel };
        // Explicit switch supersedes any prior /cancel (same reason as triggerRestart)
        pendingCancel = false;
        messageQueue = [];
        turnRouting = [];
        // Hold turns until the resumed session is up (startSession's resume path
        // releases them), so nothing is fed into the session being torn down.
        sessionReady = false;
        pushMessage(SWITCH_SIGNAL);
        // Answer only once the resumed session is up. This also keeps
        // `switching` set until then, so back-to-back switches run one at a
        // time instead of signalling a session that is still being torn down.
        const ready = await waitForSessionReady(SWITCH_READY_TIMEOUT_MS);
        if (!ready) console.log("Switch: session not ready after 30s");
        reply(200, { ok: true, model: chosenModelDisplay || sessionModel, effort: chosenEffort || sessionEffort });
      } finally {
        switching = false;
      }
    });
    return;
  }

  if (req.method === "GET" && req.url === "/routines") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(readRoutineNotes()));
    return;
  }

  if (req.method === "POST" && req.url === "/routine/reload") {
    let result = { ok: false, error: "scheduler not ready" };
    try {
      result = scheduler.reload();
    } catch (err) {
      result = { ok: false, error: err.message };
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (
    req.method === "POST" &&
    (req.url === "/routine/toggle" || req.url === "/routine/delete" || req.url === "/routine/fire")
  ) {
    const url = req.url;
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      let id;
      try {
        id = JSON.parse(body).id;
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }
      if (!id || typeof id !== "string") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing id" }));
        return;
      }
      let result;
      if (url === "/routine/toggle") {
        result = toggleRoutineFile(id);
      } else if (url === "/routine/delete") {
        result = deleteRoutineFile(id);
      } else {
        result = SLUG_RE.test(id) ? scheduler.fireNow(id) : { ok: false, error: "invalid id" };
      }
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (req.method !== "POST" || req.url !== "/message") {
    res.writeHead(404);
    res.end();
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    try {
      const { text, image, document: docAttachment } = JSON.parse(body);
      if (!text) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing text field" }));
        return;
      }

      const attachmentTag = [image && "[+image]", docAttachment && `[+doc ${docAttachment.mediaType}]`].filter(Boolean).join(" ");
      console.log("Received:", text.substring(0, 100), attachmentTag);
      sessionMessageCount++;

      // Stage any binary attachments to vault/assets/incoming/ so the Claude
      // session can `mv` them to their canonical path if the user asks to remember.
      const stagedAssets = [
        stageAsset("document", docAttachment),
        stageAsset("image", image),
      ].filter(Boolean);

      // Response goes back over this open HTTP connection. Held, not refused,
      // if the session is mid-restart or still starting up.
      enqueueTurn({ res, msg: { text, image: image || null, document: docAttachment || null, stagedAssets } });
      // No server-side timeout: connection stays open until Claude responds or
      // bot POSTs /cancel. Long-running tasks (research, agent loops) are fine.
    } catch (err) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
    }
  });
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, shutting down.`);
  // better-sqlite3 registers a Node environment cleanup hook per Database.
  // Exiting with a live handle leaves that hook to fire during teardown, which
  // aborts with `RemoveEnvironmentCleanupHook ... (env) != nullptr`. Closing
  // here removes it while the environment still exists.
  try { indexer.close(); } catch (err) { console.error("indexer close failed:", err.message); }
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

server.listen(PORT, () => {
  console.log("silOS core listening on port " + PORT);

  try {
    indexer.init(VAULT_PATH, {
      rebuild: true,
      watch: true,
      // Structure-only snapshot for the memory viewer (see graph-export.js).
      onRebuilt: (db) => writeGraph(db, GRAPH_DIR),
    });
  } catch (err) {
    console.error("Vault indexer failed to initialize:", err.message);
  }

  try {
    registry.init();
  } catch (err) {
    console.error("Registry failed to initialize:", err.message);
  }

  scheduler
    .init({ vaultDir: VAULT_PATH, onFire: onRoutineFire })
    .then((s) => console.log(`Scheduler initialized (${s.listJobs().length} job(s) registered).`))
    .catch((err) => console.error("Scheduler failed to initialize:", err.message));

  startSession();
});
