#!/usr/bin/env node
// Post {text} to the bot's /push-message endpoint so it relays an unsolicited
// text message to the user via Telegram.
//
// A normal turn's reply travels back over the open HTTP request and is capped
// at one message per turn. Anything the session wants to say AFTER that turn
// has ended — a promised follow-up, the result of long work, a heads-up — has
// no channel unless it goes through here.
//
// Usage:
//   send-message "Checked your inbox — 3 new, nothing urgent."
//   echo "multi-line body" | send-message

const args = process.argv.slice(2);

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const text = args.length > 0 ? args.join(" ") : (await readStdin()).trim();

if (!text) {
  console.error("Usage: send-message <text...>   (or pipe the body on stdin)");
  process.exit(1);
}

try {
  const res = await fetch("http://bot:3001/push-message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  if (res.ok) {
    console.log(body || JSON.stringify({ sent: true }));
    process.exit(0);
  }
  console.error(`push-message failed (${res.status}): ${body}`);
  process.exit(1);
} catch (err) {
  console.error(`Connection error: ${err.message}`);
  process.exit(1);
}
