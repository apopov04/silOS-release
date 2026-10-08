#!/usr/bin/env node
// `routine` CLI — create / list / remove / toggle / fire-now scheduled prompts.
//
// Routines are plain vault notes (type: routine) in <vault>/core/. This CLI
// writes them; the in-process scheduler (scheduler.js) watches the folder and
// (re)registers jobs within ~500ms. Symlinked to /usr/local/bin/routine in the
// core container. Honors VAULT_PATH so it can run against a throwaway vault on a
// dev machine (default /app/vault in the container).
//
// All commands print JSON on stdout; errors print to stderr and exit non-zero.
//
// Usage:
//   routine create --title "Call Mom" --schedule "2026-05-29T15:00:00+02:00" \
//                  --prompt "Tell the user it's time to call Mom." [--kind one-shot] \
//                  [--id call-mom] [--body "..."] [--allow-past]
//   routine create --title "Briefing" --schedule "0 8 * * 1-5" --prompt "..."
//   routine list
//   routine toggle <id>
//   routine remove <id>
//   routine fire-now <id>

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { validateNote, slugify } from "./schema-validator.js";
import { classifySchedule } from "./scheduler.js";

const VAULT = process.env.VAULT_PATH || "/app/vault";
const CORE_DIR = path.join(VAULT, "core");
const CORE_URL = process.env.CORE_URL || "http://core:3000";

function fail(msg) {
  console.error(`[routine] ${msg}`);
  process.exit(1);
}

function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function scheduleToString(v) {
  return v instanceof Date ? v.toISOString() : String(v);
}

function usage() {
  console.log(
    [
      "routine — manage scheduled prompts",
      "",
      "Commands:",
      "  create --title T --schedule S --prompt P [--kind one-shot|recurring]",
      "         [--id slug] [--body text] [--allow-past]",
      "  list",
      "  toggle <id>",
      "  remove <id>",
      "  fire-now <id>",
      "",
      "Schedule S is either an ISO-8601 datetime (one-shot) or a cron string (recurring).",
    ].join("\n")
  );
}

// Minimal flag parser: --key value, or --key (boolean). Positionals collect in _.
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out.flags[key] = true;
      } else {
        out.flags[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function loadAll() {
  let files;
  try {
    files = fs.readdirSync(CORE_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    try {
      const { data: fm } = matter(fs.readFileSync(path.join(CORE_DIR, f), "utf8"));
      if (fm.type !== "routine") continue;
      out.push({
        id: fm.id,
        title: fm.title,
        schedule: scheduleToString(fm.schedule),
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

// Best-effort nudge to core's scheduler for near-term one-shots (the watcher
// debounce is 500ms; a sub-second one-shot would otherwise miss its window).
// Never fails the CLI — the watcher is the primary path.
async function maybeReloadCore(c) {
  if (!c || c.kind !== "one-shot") return;
  if (c.when.getTime() - Date.now() > 60000) return;
  try {
    await fetch(CORE_URL + "/routine/reload", { method: "POST", signal: AbortSignal.timeout(1000) });
  } catch {
    /* core unreachable (e.g. dev machine) — watcher will pick it up */
  }
}

async function cmdCreate(flags) {
  const { title, schedule: scheduleStr, prompt } = flags;
  if (!title || typeof title !== "string") fail("create requires --title");
  if (!scheduleStr || typeof scheduleStr !== "string") fail("create requires --schedule");
  if (!prompt || typeof prompt !== "string") fail("create requires --prompt");

  let c;
  try {
    c = classifySchedule(scheduleStr);
  } catch (e) {
    fail(`invalid schedule: ${e.message}`);
  }

  if (c.kind === "one-shot" && c.when.getTime() <= Date.now() && !flags["allow-past"]) {
    fail(`schedule is in the past (${c.when.toISOString()}); pass --allow-past to override`);
  }

  const kind = c.kind;
  if (flags.kind && flags.kind !== kind) {
    console.error(`[routine] note: --kind "${flags.kind}" overridden by detected kind "${kind}"`);
  }

  const id = flags.id ? String(flags.id) : slugify(title);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`invalid id slug: "${id}"`);

  const filePath = path.join(CORE_DIR, `${id}.md`);
  if (fs.existsSync(filePath)) {
    fail(`routine already exists: ${id} (remove it first, or pass a distinct --id)`);
  }

  const today = todayStr();
  const fm = {
    id,
    title,
    type: "routine",
    schedule: scheduleStr,
    kind,
    prompt,
    enabled: true,
    created: today,
    updated: today,
    last_fired: "",
    fire_count: 0,
  };

  const check = validateNote(fm);
  if (!check.ok) fail(`schema validation failed:\n  - ${check.errors.join("\n  - ")}`);

  const body = flags.body ? String(flags.body) : "";
  fs.mkdirSync(CORE_DIR, { recursive: true });
  fs.writeFileSync(filePath, matter.stringify(body, fm));

  await maybeReloadCore(c);
  printJson({ created: id, path: filePath, kind, schedule: scheduleStr, enabled: true });
}

function cmdList() {
  printJson(loadAll());
}

function cmdToggle(id) {
  if (!id) fail("toggle requires <id>");
  const filePath = path.join(CORE_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) fail(`routine not found: ${id}`);
  const { data: fm, content } = matter(fs.readFileSync(filePath, "utf8"));
  if (fm.type !== "routine") fail(`${id} is not a routine note (type: ${fm.type})`);
  fm.enabled = fm.enabled === false ? true : false;
  fm.updated = todayStr();
  fm.schedule = scheduleToString(fm.schedule); // keep as string so it round-trips
  fs.writeFileSync(filePath, matter.stringify(content, fm));
  printJson({ toggled: id, enabled: fm.enabled });
}

function cmdRemove(id) {
  if (!id) fail("remove requires <id>");
  const filePath = path.join(CORE_DIR, `${id}.md`);
  if (!fs.existsSync(filePath)) fail(`routine not found: ${id}`);
  const { data: fm } = matter(fs.readFileSync(filePath, "utf8"));
  if (fm.type !== "routine") fail(`${id} is not a routine note (type: ${fm.type})`);
  fs.unlinkSync(filePath);
  printJson({ removed: id });
}

async function cmdFireNow(id) {
  if (!id) fail("fire-now requires <id>");
  try {
    const res = await fetch(CORE_URL + "/routine/fire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(5000),
    });
    const text = await res.text();
    if (!res.ok) fail(`core /routine/fire failed (${res.status}): ${text}`);
    console.log(text || JSON.stringify({ fired: id }));
  } catch (e) {
    fail(`could not reach core to fire "${id}": ${e.message}`);
  }
}

async function main() {
  const { _: pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos[0];
  switch (cmd) {
    case "create":
      await cmdCreate(flags);
      break;
    case "list":
      cmdList();
      break;
    case "toggle":
      cmdToggle(pos[1]);
      break;
    case "remove":
      cmdRemove(pos[1]);
      break;
    case "fire-now":
      await cmdFireNow(pos[1]);
      break;
    default:
      usage();
      process.exit(cmd ? 1 : 0);
  }
}

main();
