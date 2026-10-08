import { test } from "node:test";
import assert from "node:assert/strict";
import mc from "./model-command.cjs";

const { parseModelCommand, parseEffortCommand, isValidModelId, isValidEffort } = mc;

test("non-matching text is not a command", () => {
  for (const t of ["hello", "/models", "/modelx opus", "/effortless", "model opus", "", "/session", " /model opus"]) {
    assert.equal(parseModelCommand(t), null, t);
    assert.equal(parseEffortCommand(t.replace("model", "effort")), null, t);
  }
});

test("/model alone shows current", () => {
  assert.deepEqual(parseModelCommand("/model"), { kind: "show" });
  assert.deepEqual(parseModelCommand("/model   "), { kind: "show" });
  assert.deepEqual(parseModelCommand("/model@my_silos_bot"), { kind: "show" });
});

test("/model with full IDs and aliases", () => {
  assert.deepEqual(parseModelCommand("/model claude-opus-4-6"), { kind: "set", model: "claude-opus-4-6" });
  assert.deepEqual(parseModelCommand("/model claude-opus-5-5[1m]"), { kind: "set", model: "claude-opus-5-5[1m]" });
  assert.deepEqual(parseModelCommand("/model claude-haiku-4-5-20251001"), { kind: "set", model: "claude-haiku-4-5-20251001" });
  assert.deepEqual(parseModelCommand("/model opus"), { kind: "set", model: "opus" });
  assert.deepEqual(parseModelCommand("/MODEL  Sonnet "), { kind: "set", model: "sonnet" });
  assert.deepEqual(parseModelCommand("/model@my_silos_bot haiku"), { kind: "set", model: "haiku" });
});

test("/model rejects junk and injection-looking input", () => {
  for (const bad of [
    "/model claude opus",            // spaces
    "/model claude-opus;rm -rf /",   // shell metachar
    "/model $(whoami)",
    "/model ../../etc/passwd",
    "/model -opus",                  // leading dash (flag-like)
    "/model " + "a".repeat(80),      // too long
    "/model claude-opus-5-5[2m]",
    "/model claude_opus",
  ]) {
    const r = parseModelCommand(bad);
    assert.equal(r.kind, "invalid", bad);
    assert.ok(r.reason.length > 0);
  }
});

test("/effort show, set, invalid", () => {
  assert.deepEqual(parseEffortCommand("/effort"), { kind: "show" });
  for (const e of ["low", "medium", "high", "max"]) {
    assert.deepEqual(parseEffortCommand("/effort " + e), { kind: "set", effort: e });
  }
  assert.deepEqual(parseEffortCommand("/effort HIGH"), { kind: "set", effort: "high" });
  assert.deepEqual(parseEffortCommand("/effort@my_silos_bot max"), { kind: "set", effort: "max" });
  for (const bad of ["/effort extreme", "/effort high now", "/effort 3"]) {
    assert.equal(parseEffortCommand(bad).kind, "invalid", bad);
  }
});

test("validators used by core", () => {
  assert.equal(isValidModelId("claude-opus-4-6"), true);
  assert.equal(isValidModelId("opus"), true);
  assert.equal(isValidModelId(""), false);
  assert.equal(isValidModelId(undefined), false);
  assert.equal(isValidModelId("a b"), false);
  assert.equal(isValidModelId(42), false);
  assert.equal(isValidEffort("max"), true);
  assert.equal(isValidEffort("MAX"), false);
  assert.equal(isValidEffort(undefined), false);
});
