// In-process routine scheduler for silOS core.
//
// Reads routine notes (type: routine) from <vault>/core/, registers each with
// node-schedule, and watches the folder (chokidar, 500ms debounce — same shape
// as vault-indexer.js) so notes created/edited/removed by the `routine` CLI are
// picked up on the fly. When a routine fires it:
//   1. updates the note (last_fired, fire_count, enabled:false for one-shots),
//   2. hands a synthetic prompt to the injected onFire(routine, meta) callback.
//
// Decoupled from core on purpose (Stage 0 affordance): it takes an onFire
// callback and a vault dir instead of importing core's pushMessage, so the
// timing/parsing logic can be exercised in isolation with a spy + temp vault.
//
// node-schedule and chokidar are imported lazily inside init() so this module
// can be imported purely for classifySchedule / isMissedOneShot (e.g. by the
// routine CLI) without those packages being installed.

import fs from "fs";
import path from "path";
import matter from "gray-matter";

const DEFAULT_VAULT = process.env.VAULT_PATH || "/app/vault";

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit checks — no timers, no fs, no deps)
// ---------------------------------------------------------------------------

// One cron field: *, n, n-m, optionally /step, comma-listed. Numeric only —
// the routines agent always emits numeric cron (no month/day names).
const CRON_FIELD = /^(\*|\d+|\d+-\d+)(\/\d+)?(,(\*|\d+|\d+-\d+)(\/\d+)?)*$/;

// Classify a schedule string (or Date) as a one-shot datetime or a recurring
// cron expression. Throws on anything it can't recognize.
//
// gray-matter/js-yaml will parse an *unquoted* ISO datetime in frontmatter back
// into a JS Date; we accept that directly so a note round-trips even if the
// quoting ever slips.
export function classifySchedule(input) {
  if (input instanceof Date) {
    if (isNaN(input.getTime())) throw new Error("invalid Date schedule");
    return { kind: "one-shot", when: input };
  }
  const str = String(input ?? "").trim();
  if (!str) throw new Error("empty schedule");

  // Cron = whitespace-separated 5 or 6 fields, each a valid cron field.
  if (/\s/.test(str)) {
    const parts = str.split(/\s+/);
    if ((parts.length === 5 || parts.length === 6) && parts.every((p) => CRON_FIELD.test(p))) {
      return { kind: "recurring", cron: str };
    }
    throw new Error(`invalid cron expression: ${str}`);
  }

  // One-shot = ISO-8601 datetime.
  const when = new Date(str);
  if (!isNaN(when.getTime())) return { kind: "one-shot", when };

  throw new Error(`unrecognized schedule (expected ISO datetime or cron): ${str}`);
}

// A one-shot whose time has already passed and which never fired. These fire
// immediately on boot (tagged late). Recurring routines just resume their next
// slot — no backfill — so they return false.
export function isMissedOneShot(routine, now = new Date()) {
  if (!routine) return false;
  if (routine.last_fired) return false;        // already fired
  if (routine.enabled === false) return false; // disabled
  let c;
  try {
    c = classifySchedule(routine.schedule);
  } catch {
    return false;                              // malformed — skipped, not missed
  }
  if (c.kind !== "one-shot") return false;
  return c.when.getTime() < now.getTime();
}

// ---------------------------------------------------------------------------
// Stateful scheduler
// ---------------------------------------------------------------------------

let schedule;          // node-schedule (lazy)
let watchFn;           // chokidar.watch (lazy)
let vaultDir;
let coreDir;
let onFireCb = () => {};
let watcher = null;
let reconcileTimer = null;
const jobs = new Map(); // routine id -> node-schedule Job

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function routinePath(id) {
  return path.join(coreDir, `${id}.md`);
}

function normalizeRoutine(fm, filePath, content) {
  return {
    ...fm,
    id: fm.id,
    title: fm.title,
    schedule: fm.schedule,
    prompt: fm.prompt,
    kind: fm.kind,
    enabled: fm.enabled !== false,
    created: fm.created,
    updated: fm.updated,
    last_fired: fm.last_fired || "",
    fire_count: Number(fm.fire_count) || 0,
    _path: filePath,
    _content: content ?? "",
  };
}

function loadRoutineFiles() {
  const out = [];
  let files;
  try {
    files = fs.readdirSync(coreDir);
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(".md")) continue;
    const filePath = path.join(coreDir, f);
    try {
      const { data: fm, content } = matter(fs.readFileSync(filePath, "utf8"));
      if (fm.type !== "routine") continue;
      out.push(normalizeRoutine(fm, filePath, content));
    } catch (e) {
      console.error(`[scheduler] failed to read ${f}: ${e.message}`);
    }
  }
  return out;
}

function readRoutine(id) {
  const p = routinePath(id);
  if (!fs.existsSync(p)) return null;
  try {
    const { data: fm, content } = matter(fs.readFileSync(p, "utf8"));
    if (fm.type !== "routine") return null;
    return normalizeRoutine(fm, p, content);
  } catch (e) {
    console.error(`[scheduler] failed to read ${id}: ${e.message}`);
    return null;
  }
}

// Rewrite a routine note with a stable frontmatter field order. schedule is
// coerced to a string so js-yaml quotes it (an unquoted ISO datetime would
// round-trip as a Date).
function writeRoutine(routine) {
  const scheduleStr =
    routine.schedule instanceof Date ? routine.schedule.toISOString() : String(routine.schedule);
  const fm = {
    id: routine.id,
    title: routine.title,
    type: "routine",
    schedule: scheduleStr,
    kind: routine.kind,
    prompt: routine.prompt,
    enabled: routine.enabled !== false,
    created: routine.created,
    updated: routine.updated || todayStr(),
    last_fired: routine.last_fired || "",
    fire_count: Number(routine.fire_count) || 0,
  };
  fs.writeFileSync(routine._path || routinePath(routine.id), matter.stringify(routine._content ?? "", fm));
}

// Fire a routine: bump metadata, disable if one-shot, then hand the prompt to
// the consumer. Metadata is updated *before* onFire so the watcher-triggered
// reconcile sees the new state (a fired one-shot is now disabled and won't be
// re-registered). `late` marks a missed one-shot fired on boot.
function fire(id, { late = false } = {}) {
  const routine = readRoutine(id);
  if (!routine) return;
  if (routine.enabled === false && !late) return;

  let c;
  try {
    c = classifySchedule(routine.schedule);
  } catch (e) {
    console.error(`[scheduler] fire ${id}: bad schedule — ${e.message}`);
    return;
  }

  const scheduledFor = c.kind === "one-shot" ? c.when : null;
  routine.fire_count = (Number(routine.fire_count) || 0) + 1;
  routine.last_fired = new Date().toISOString();
  if (c.kind === "one-shot") routine.enabled = false;
  routine.updated = todayStr();
  writeRoutine(routine);

  try {
    onFireCb({ ...routine }, { late, scheduledFor });
  } catch (e) {
    console.error(`[scheduler] onFire error for ${id}: ${e.message}`);
  }
}

function registerRoutine(routine) {
  if (routine.enabled === false) return;
  let c;
  try {
    c = classifySchedule(routine.schedule);
  } catch (e) {
    console.error(`[scheduler] skipping ${routine.id}: ${e.message}`);
    return;
  }

  if (c.kind === "recurring") {
    const job = schedule.scheduleJob(c.cron, () => fire(routine.id));
    if (job) jobs.set(routine.id, job);
    else console.error(`[scheduler] could not schedule cron for ${routine.id}: ${routine.schedule}`);
    return;
  }

  // one-shot — past datetimes are handled by the missed-fire path, not here
  if (c.when.getTime() <= Date.now()) return;
  const job = schedule.scheduleJob(c.when, () => fire(routine.id));
  if (job) jobs.set(routine.id, job);
}

// Cancel everything and re-read from disk. Used on boot and on every (debounced)
// watcher event. Missed one-shots fire immediately (tagged late); future
// one-shots and recurring routines get (re)registered.
function registerAll() {
  for (const job of jobs.values()) job.cancel();
  jobs.clear();

  const now = new Date();
  for (const r of loadRoutineFiles()) {
    if (r.enabled === false) continue;
    if (isMissedOneShot(r, now)) {
      fire(r.id, { late: true });
      continue;
    }
    registerRoutine(r);
  }
}

function scheduleReconcile() {
  if (reconcileTimer) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    try {
      registerAll();
    } catch (e) {
      console.error("[scheduler] reconcile failed:", e.message);
    }
  }, 500);
}

// Manually fire a routine now (CLI fire-now / core's /routine/fire). Same path
// as a scheduled fire: a one-shot gets disabled, a recurring one keeps running.
export function fireNow(id) {
  if (!coreDir) throw new Error("scheduler not initialized");
  const routine = readRoutine(id);
  if (!routine) return { ok: false, error: `routine not found: ${id}` };
  fire(id);
  return { ok: true };
}

export function reload() {
  if (!coreDir) throw new Error("scheduler not initialized");
  registerAll();
  return { ok: true, jobs: jobs.size };
}

export function listJobs() {
  return [...jobs.keys()];
}

export function stop() {
  if (reconcileTimer) {
    clearTimeout(reconcileTimer);
    reconcileTimer = null;
  }
  for (const job of jobs.values()) job.cancel();
  jobs.clear();
  if (watcher) {
    watcher.close();
    watcher = null;
  }
}

export async function init({ vaultDir: dir = DEFAULT_VAULT, onFire } = {}) {
  // Lazy deps so importing this module for the pure helpers needs neither.
  if (!schedule) schedule = (await import("node-schedule")).default;
  if (!watchFn) watchFn = (await import("chokidar")).watch;

  vaultDir = dir;
  coreDir = path.join(vaultDir, "core");
  onFireCb = typeof onFire === "function" ? onFire : () => {};
  fs.mkdirSync(coreDir, { recursive: true });

  registerAll();

  watcher = watchFn(coreDir, {
    ignored: /(^|[/\\])\../, // dotfiles
    persistent: true,
    ignoreInitial: true,
  });
  watcher.on("add", scheduleReconcile);
  watcher.on("change", scheduleReconcile);
  watcher.on("unlink", scheduleReconcile);

  // Wait for the watcher to finish its initial scan before returning — otherwise
  // a file created right after init() can land during chokidar's startup and be
  // silently swallowed (notably on Windows fs.watch over a fresh directory).
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    watcher.once("ready", finish);
    setTimeout(finish, 2000); // safety net if 'ready' never arrives
  });

  console.error(`[scheduler] initialized. Watching ${coreDir}. ${jobs.size} job(s) registered.`);
  return { stop, reload, fireNow, listJobs };
}

export default { init, stop, reload, fireNow, listJobs, classifySchedule, isMissedOneShot };
