#!/usr/bin/env node
// Post {path, caption?} to the bot's /send-file endpoint so it relays the file
// to the user via Telegram. Path must be inside /app/vault/.
//
// Usage:
//   send-to-user /app/vault/assets/dune-rulebook.pdf
//   send-to-user /app/vault/assets/whiteboard.jpg "Kitchen whiteboard from earlier"

const [, , filePath, ...captionParts] = process.argv;

if (!filePath) {
  console.error("Usage: send-to-user <path> [caption...]");
  process.exit(1);
}

const caption = captionParts.length > 0 ? captionParts.join(" ") : undefined;

try {
  const res = await fetch("http://bot:3001/send-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: filePath, caption }),
  });
  const text = await res.text();
  if (res.ok) {
    console.log(text || JSON.stringify({ sent: true }));
    process.exit(0);
  }
  console.error(`send-file failed (${res.status}): ${text}`);
  process.exit(1);
} catch (err) {
  console.error(`Connection error: ${err.message}`);
  process.exit(1);
}
