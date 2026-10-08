import crypto from "node:crypto";

// Telegram Mini App initData verification.
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret_key = HMAC_SHA256(key="WebAppData", msg=bot_token)
//   hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
// The viewer is only ever given secret_key, never the bot token, so a
// compromised viewer can check signatures but cannot act as the bot.

export const MAX_AGE_SEC = 24 * 60 * 60;
const MAX_FUTURE_SEC = 300;
const HEX64 = /^[0-9a-f]{64}$/;

export function deriveSecretKey(botToken) {
  return crypto.createHmac("sha256", "WebAppData").update(String(botToken)).digest("hex");
}

const fail = (reason) => ({ ok: false, reason });

export function verifyInitData(initData, secretKeyHex, ownerId, nowSec = Math.floor(Date.now() / 1000)) {
  if (!HEX64.test(String(secretKeyHex || ""))) return fail("server-key");
  if (!/^\d+$/.test(String(ownerId ?? ""))) return fail("server-owner");
  if (!Number.isInteger(nowSec)) return fail("server-clock");
  if (typeof initData !== "string" || initData.length === 0 || initData.length > 4096) return fail("missing");

  const params = new URLSearchParams(initData);
  const fields = new Map();
  for (const [k, v] of params) {
    if (fields.has(k)) return fail("duplicate-field");
    fields.set(k, v);
  }

  const hash = fields.get("hash");
  if (!hash || !HEX64.test(hash)) return fail("bad-hash");
  fields.delete("hash");

  const dataCheckString = [...fields.keys()].sort().map((k) => `${k}=${fields.get(k)}`).join("\n");
  const expected = crypto.createHmac("sha256", Buffer.from(secretKeyHex, "hex")).update(dataCheckString).digest();
  if (!crypto.timingSafeEqual(expected, Buffer.from(hash, "hex"))) return fail("bad-signature");

  const authDate = Number(fields.get("auth_date"));
  if (!Number.isInteger(authDate)) return fail("bad-auth-date");
  if (nowSec - authDate > MAX_AGE_SEC || authDate - nowSec > MAX_FUTURE_SEC) return fail("expired");

  let user;
  try { user = JSON.parse(fields.get("user") || ""); } catch { return fail("bad-user"); }
  if (!user || String(user.id) !== String(ownerId)) return fail("not-owner");

  return { ok: true };
}
