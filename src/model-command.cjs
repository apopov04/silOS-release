// Parsing and validation for the /model and /effort Telegram commands.
// CommonJS (.cjs) so both the CommonJS bot and the ESM core can load it:
// the bot parses what the user typed, core re-validates whatever reaches
// /switch (it is not the only possible caller).

const EFFORTS = ["low", "medium", "high", "max"];

// Full IDs (claude-opus-4-6, claude-haiku-4-5-20251001, claude-opus-5-5[1m])
// and Claude Code aliases (opus, sonnet, haiku). Must start alphanumeric so it
// can never look like a CLI flag; no spaces or shell metacharacters.
const MODEL_RE = /^[a-z0-9][a-z0-9.-]{0,63}(\[1m\])?$/;

function isValidModelId(s) {
  return typeof s === "string" && MODEL_RE.test(s);
}

function isValidEffort(s) {
  return typeof s === "string" && EFFORTS.includes(s);
}

// Returns the argument string ("" when absent) if `text` is exactly
// /<name> or /<name>@botname optionally followed by an argument; else null.
function commandArg(text, name) {
  const m = /^\/([a-z]+)(@\w+)?(?:\s+([\s\S]*))?$/i.exec(typeof text === "string" ? text : "");
  if (!m || m[1].toLowerCase() !== name) return null;
  return (m[3] || "").trim();
}

function parseModelCommand(text) {
  const arg = commandArg(text, "model");
  if (arg === null) return null;
  if (arg === "") return { kind: "show" };
  const model = arg.toLowerCase();
  if (!isValidModelId(model)) {
    return { kind: "invalid", reason: "That doesn't look like a model ID. Use something like claude-opus-4-6, or opus / sonnet / haiku." };
  }
  return { kind: "set", model };
}

function parseEffortCommand(text) {
  const arg = commandArg(text, "effort");
  if (arg === null) return null;
  if (arg === "") return { kind: "show" };
  const effort = arg.toLowerCase();
  if (!isValidEffort(effort)) {
    return { kind: "invalid", reason: `Effort must be one of: ${EFFORTS.join(", ")}.` };
  }
  return { kind: "set", effort };
}

module.exports = { EFFORTS, isValidModelId, isValidEffort, parseModelCommand, parseEffortCommand };
