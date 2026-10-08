#!/usr/bin/env bash
# Writes .env.viewer for the optional memory viewer, deriving VIEWER_SECRET_KEY
# from the bot token in .env without ever printing the token.
# Usage: ./scripts/viewer-env.sh <your numeric Telegram user id>
set -euo pipefail
cd "$(dirname "$0")/.."
[ $# -eq 1 ] || { echo "usage: $0 <telegram-user-id>"; exit 1; }
umask 077
docker run --rm --env-file .env -e OWNER="$1" node:24-alpine node -e '
const c = require("crypto");
const key = c.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN).digest("hex");
process.stdout.write("VIEWER_SECRET_KEY=" + key + "\nOWNER_TELEGRAM_ID=" + process.env.OWNER + "\n");
' > .env.viewer
echo "Wrote .env.viewer"
