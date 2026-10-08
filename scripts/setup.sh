#!/usr/bin/env bash
# First-time setup for silOS. Safe to re-run: it never overwrites existing files.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }

command -v docker >/dev/null || { echo "Docker is not installed. See docs/SETUP.md step 3."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "Docker Compose v2 is missing (docker compose ...)."; exit 1; }

if [ ! -f .env ]; then
  cp .env.example .env && chmod 600 .env
  say "Created .env - edit it now: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USERNAME, TZ"
else
  say ".env already exists, leaving it alone"
fi

# docker-compose mounts each root's .env as a file. If the file doesn't exist,
# Docker would create a *directory* in its place, so make empty ones up front.
for r in gmail github; do
  if [ ! -f "roots/$r/.env" ]; then
    : > "roots/$r/.env" && chmod 600 "roots/$r/.env"
    say "Created empty roots/$r/.env (fill it in later if you want the $r root)"
  fi
done

# Runtime directories. Containers run as the `node` user (uid 1000).
mkdir -p vault/core vault/conversations vault/assets/incoming \
         workspace data/bot data/graph
if [ "$(id -u)" = "0" ]; then
  chown -R 1000:1000 vault workspace data
else
  sudo chown -R 1000:1000 vault workspace data
fi
say "Prepared vault/, workspace/ and data/ (owned by uid 1000)"

cat <<'NEXT'

Next steps:
  1. Edit .env
  2. docker compose build
  3. docker compose run --rm -it core claude      # log in to Claude once, then /exit
  4. docker compose up -d
  5. Message your bot on Telegram.
Full guide: docs/SETUP.md
NEXT
