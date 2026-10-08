import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { deriveSecretKey, verifyInitData } from "../auth.js";
import { signInitData, ownerFields, OWNER, NOW } from "./helpers.mjs";

const KEY = deriveSecretKey("123456:TEST-TOKEN");

test("deriveSecretKey matches Telegram's definition", () => {
  const expected = crypto.createHmac("sha256", "WebAppData").update("123456:TEST-TOKEN").digest("hex");
  assert.equal(KEY, expected);
  assert.match(KEY, /^[0-9a-f]{64}$/);
});

test("valid owner initData passes", () => {
  assert.deepEqual(verifyInitData(signInitData(ownerFields(), KEY), KEY, OWNER, NOW), { ok: true });
});

test("tampered field fails", () => {
  const s = signInitData(ownerFields(), KEY).replace("AAHtest", "AAHtesu");
  assert.equal(verifyInitData(s, KEY, OWNER, NOW).ok, false);
});

test("signed with another key fails", () => {
  const other = deriveSecretKey("999:OTHER");
  assert.equal(verifyInitData(signInitData(ownerFields(), other), KEY, OWNER, NOW).ok, false);
});

test("validly signed but different user fails", () => {
  const f = ownerFields({ user: JSON.stringify({ id: 42, first_name: "Eve" }) });
  assert.deepEqual(verifyInitData(signInitData(f, KEY), KEY, OWNER, NOW), { ok: false, reason: "not-owner" });
});

test("stale auth_date fails, fresh passes", () => {
  const old = ownerFields({ auth_date: String(NOW - 86401) });
  assert.equal(verifyInitData(signInitData(old, KEY), KEY, OWNER, NOW).ok, false);
  const edge = ownerFields({ auth_date: String(NOW - 86400) });
  assert.equal(verifyInitData(signInitData(edge, KEY), KEY, OWNER, NOW).ok, true);
});

test("auth_date far in the future fails", () => {
  const fut = ownerFields({ auth_date: String(NOW + 301) });
  assert.equal(verifyInitData(signInitData(fut, KEY), KEY, OWNER, NOW).ok, false);
});

test("missing / empty / garbage inputs fail", () => {
  for (const bad of [undefined, null, "", "hash=", "a=b", 123]) {
    assert.equal(verifyInitData(bad, KEY, OWNER, NOW).ok, false, String(bad).slice(0, 20));
  }
});

test("initData too long fails with reason missing", () => {
  const s = signInitData(ownerFields(), KEY);
  const toolong = s + "&" + "x".repeat(5000);
  assert.deepEqual(verifyInitData(toolong, KEY, OWNER, NOW), { ok: false, reason: "missing" });
});

test("hash of wrong length or non-hex fails without throwing", () => {
  const s = signInitData(ownerFields(), KEY);
  const short = s.replace(/hash=[0-9a-f]{64}/, "hash=abcd");
  const nonhex = s.replace(/hash=[0-9a-f]{64}/, "hash=" + "z".repeat(64));
  assert.equal(verifyInitData(short, KEY, OWNER, NOW).ok, false);
  assert.equal(verifyInitData(nonhex, KEY, OWNER, NOW).ok, false);
});

test("duplicated hash or field is rejected", () => {
  const s = signInitData(ownerFields(), KEY);
  const hash = new URLSearchParams(s).get("hash");
  assert.equal(verifyInitData(s + "&hash=" + hash, KEY, OWNER, NOW).ok, false);
  assert.equal(verifyInitData(s + "&query_id=AAHtest", KEY, OWNER, NOW).ok, false);
});

test("misconfigured server key or owner fails closed", () => {
  const s = signInitData(ownerFields(), KEY);
  assert.equal(verifyInitData(s, "", OWNER, NOW).ok, false);
  assert.equal(verifyInitData(s, "nothex", OWNER, NOW).ok, false);
  assert.equal(verifyInitData(s, KEY, "", NOW).ok, false);
  assert.equal(verifyInitData(s, KEY, undefined, NOW).ok, false);
});

test("bad server clock (NaN or non-integer nowSec) fails closed", () => {
  const s = signInitData(ownerFields({ auth_date: String(1) }), KEY);
  assert.deepEqual(verifyInitData(s, KEY, OWNER, NaN), { ok: false, reason: "server-clock" });
  assert.deepEqual(verifyInitData(s, KEY, OWNER, "abc"), { ok: false, reason: "server-clock" });
});

test("user field that is not JSON fails", () => {
  const f = ownerFields({ user: "not-json" });
  assert.equal(verifyInitData(signInitData(f, KEY), KEY, OWNER, NOW).ok, false);
});
