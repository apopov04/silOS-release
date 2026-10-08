import crypto from "node:crypto";

// Builds initData exactly the way Telegram signs it.
export function signInitData(fields, secretKeyHex) {
  const dcs = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const hash = crypto.createHmac("sha256", Buffer.from(secretKeyHex, "hex")).update(dcs).digest("hex");
  const p = new URLSearchParams(fields);
  p.set("hash", hash);
  return p.toString();
}

export const OWNER = "123456789";
export const NOW = 1790900000;
export function ownerFields(overrides = {}) {
  return {
    auth_date: String(NOW - 60),
    query_id: "AAHtest",
    user: JSON.stringify({ id: Number(OWNER), first_name: "Alex", username: "alex_example" }),
    ...overrides,
  };
}
