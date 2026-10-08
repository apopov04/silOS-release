#!/usr/bin/env node
const [, , cmd, ...args] = process.argv;

if (cmd === "echo") {
  console.log(args.join(" "));
  process.exit(0);
}

console.error(`Unknown command: ${cmd || "(none)"}. Expected: echo <text>`);
process.exit(1);
