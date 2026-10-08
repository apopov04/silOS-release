# silOS setup guide

This guide takes you from a blank server to a working assistant in your Telegram, in about 30 minutes. Steps marked *(optional)* can be skipped.

## 1. Get a server

Any always-on Linux box works: a VPS (DigitalOcean, Hetzner, Hostinger, …), a home server or a Raspberry Pi 5.

Recommended:
- Ubuntu 24.04 LTS
- 2 GB RAM, 1 vCPU and 25 GB or more of disk. The core is limited to about 1.3 GB, and the bot image builds whisper.cpp.
- A region close to you, for lower latency.
- SSH-key login only.

## 2. Harden the server (recommended)

Run these as root on a fresh machine.

```bash
adduser silos && usermod -aG sudo silos
rsync --archive --chown=silos:silos ~/.ssh /home/silos
```

Open a **new** terminal and check that `ssh silos@YOUR_SERVER_IP` works. **Don't continue until it does.** Then:

```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo systemctl restart ssh

sudo ufw default deny incoming && sudo ufw default allow outgoing
sudo ufw allow OpenSSH && sudo ufw enable

sudo apt update && sudo apt install -y fail2ban git
sudo systemctl enable --now fail2ban
```

silOS needs **no inbound ports**. The bot polls Telegram, and the optional viewer uses an outbound Cloudflare Tunnel.

## 3. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker silos     # log out and back in afterwards
docker compose version            # must print v2.x
```

## 4. Create your Telegram bot

1. In Telegram, open **@BotFather** and send `/newbot`.
2. Pick a display name and a username that ends in `bot`.
3. Copy the **bot token**.
4. Make sure your own Telegram account has a **username** (Settings → Username). silOS uses it to recognize you.

## 5. Get the code and configure

```bash
git clone https://github.com/apopov04/silOS-release.git ~/silos
cd ~/silos
./scripts/setup.sh
nano .env
```

Fill in `.env`:

```
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_ALLOWED_USERNAME=<your Telegram username, no @>
TZ=<your timezone, e.g. Europe/London>
```

`setup.sh` also creates empty `roots/gmail/.env` and `roots/github/.env`. Docker needs those files to exist even if you don't use the roots. It also creates `vault/`, `workspace/` and `data/` owned by uid 1000, the user the containers run as.

## 6. Build and sign in to Claude

```bash
docker compose build        # the first build takes a few minutes (whisper.cpp compiles)
docker compose run --rm -it core claude
```

Claude Code starts inside the core container. Sign in with `/login` and follow the link from any browser. Then type `/exit`. The credentials are stored in the `claude-auth` Docker volume, so you only do this once.

## 7. Start it

```bash
docker compose up -d
docker compose ps           # bot and core should be "running"; core becomes "healthy"
docker compose logs -f core # Ctrl+C to stop following
```

Message your bot on Telegram. The first reply can take a little longer while the session starts.

**Personalize it.** Tell it your name and a few things about yourself, and ask it to remember them. To change how it behaves for everyone, edit `vault/startup/standing-orders.md` and send `/restart`.

## 8. Gmail root *(optional)*

This lets the email agent read, search and send mail from one Gmail account.

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Under **APIs & Services → OAuth consent screen**, set the app up as *External* and add your Gmail address as a test user.
3. Under **Credentials → Create credentials → OAuth client ID**, choose the type **Desktop app**.
4. Authorize on a machine **with a browser**, such as your laptop:
   ```bash
   git clone https://github.com/apopov04/silOS-release.git && cd silOS-release/roots/gmail
   npm install
   cp .env.example .env     # paste GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET
   node authorize.js        # opens a Google consent page and writes GMAIL_REFRESH_TOKEN to .env
   scp .env silos@YOUR_SERVER_IP:~/silos/roots/gmail/.env
   ```
5. On the server: `chmod 600 roots/gmail/.env && docker compose restart core`.

> Apps left in "Testing" mode get refresh tokens that expire after 7 days. Publish the consent screen (it's fine to leave it unverified for personal use) to keep the token working.

## 9. GitHub root *(optional)*

This lets the github agent list and read issues and PRs, comment, and clone repos into `workspace/`.

1. A **dedicated bot account** is recommended. Add it as a collaborator on the repos silOS should reach.
2. Create a classic personal access token with `repo` scope.
3. On the server:
   ```bash
   echo "GH_TOKEN=ghp_..." > roots/github/.env && chmod 600 roots/github/.env
   docker compose restart core
   ```

## 10. `/status` admin service *(optional)*

`/status` shows fail2ban stats, CPU, RAM, disk and container health. That data lives on the host, so a tiny service runs outside Docker on port 3002. The bot reaches it through `host.docker.internal`.

```bash
sudo apt install -y nodejs        # any Node 18+
sudo tee /etc/systemd/system/silos-admin.service >/dev/null <<'UNIT'
[Unit]
Description=silOS admin status service
After=network.target docker.service

[Service]
User=silos
WorkingDirectory=/home/silos/silos
ExecStart=/usr/bin/node src/admin-service.js
Restart=always

[Install]
WantedBy=multi-user.target
UNIT
echo 'silos ALL=(root) NOPASSWD: /usr/bin/fail2ban-client status sshd, /usr/bin/journalctl -u ssh *' | sudo tee /etc/sudoers.d/silos-admin
sudo systemctl daemon-reload && sudo systemctl enable --now silos-admin
```

Keep port 3002 closed in UFW. Only the bot uses it, over the Docker bridge. If UFW blocks the bridge, allow it with `sudo ufw allow from 172.16.0.0/12 to any port 3002`.

## 11. Memory viewer *(optional)*

The memory viewer is a Telegram Mini App that draws your vault as an interactive graph. It is the only internet-reachable piece of silOS, so it is locked down hard:
- It only sees a structure-only snapshot (titles, types, links), never note bodies.
- It sits on a network with no route to the core or the internet.
- It checks Telegram's signed `initData` and only accepts your user id.

You need a domain on Cloudflare (the free plan is fine).

1. **Secrets.** Get your numeric Telegram id from @userinfobot, then run:
   ```bash
   ./scripts/viewer-env.sh <your-telegram-id>     # writes .env.viewer without printing the bot token
   ```
2. **Tunnel.** In Cloudflare **Zero Trust → Networks → Tunnels**, create a *cloudflared* tunnel. Add a public hostname such as `vault.example.com` and point it at service `HTTP` → `viewer:3003`. Copy the token, then:
   ```bash
   cp .env.tunnel.example .env.tunnel && chmod 600 .env.tunnel && nano .env.tunnel
   ```
3. **Start:**
   ```bash
   docker compose --profile viewer up -d
   ```
4. **Menu button.** Add a "Memory" button to your chat with the bot. Replace the id and URL:
   ```bash
   set -a; . ./.env; set +a
   curl -s "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setChatMenuButton" \
     -H 'Content-Type: application/json' \
     -d '{"chat_id": <your-telegram-id>, "menu_button": {"type":"web_app","text":"Memory","web_app":{"url":"https://vault.example.com"}}}'
   ```

Check it: `curl https://vault.example.com/api/graph` should return **401**.

## Updating

```bash
cd ~/silos && git pull
docker compose build && docker compose up -d     # add --profile viewer if you use it
```

Your vault, workspace, credentials and Claude login all live outside the images, so updates don't touch them.

## Backups

Everything personal is in `vault/` (plain markdown plus a rebuildable index), `workspace/`, `.env*` and `roots/*/.env`. Back these up, for example with a nightly `tar` to off-site storage or provider snapshots. The repo deliberately keeps them out of git.

## Troubleshooting

- **The bot never answers.**
  - Run `docker compose logs bot`.
  - `TELEGRAM_ALLOWED_USERNAME is not set` means you need to fill in `.env`.
  - If there are no errors, check that the username matches yours exactly, without the `@`.
- **The bot answers "core unavailable" or times out.**
  - Run `docker compose logs core`.
  - Usually Claude isn't logged in. Repeat step 6.
- **`roots/gmail/.env` is a directory.**
  - Docker created it because the file was missing.
  - Fix: `sudo rm -r roots/gmail/.env && ./scripts/setup.sh`.
- **Permission denied writing to the vault.**
  - Fix: `sudo chown -R 1000:1000 vault workspace data`.
- **Routines fire at the wrong time.**
  - Set `TZ` in `.env`, then run `docker compose up -d`.
- **Voice notes fail.**
  - The bot image builds whisper.cpp and downloads the tiny model at build time.
  - Rebuild with `docker compose build --no-cache bot`.
