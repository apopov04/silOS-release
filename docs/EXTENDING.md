# Extending silOS

## Agents (apps)

An agent is a folder in `vault/agents/`:

```
vault/agents/weather/
  SKILL.md      # frontmatter + instructions (the agent's system prompt)
  memory/       # the only place this agent may write (keep a .gitkeep)
  scripts/      # optional helper scripts the agent can run
```

`SKILL.md`:

```markdown
---
title: Weather Agent
type: skill
version: 0.1
name: weather
description: "Answers weather questions and forecasts for any city."
requires: []            # roots this agent needs, e.g. [gmail]
tools: [Bash, Read, Write]
---

## Purpose
You're the weather specialist for silOS. ...

## Memory
Write user-specific preferences (home city, units) to /app/vault/agents/weather/memory/.
```

On every core start, `src/registry.js` scans `vault/agents/*/SKILL.md` and `roots/*/manifest.yaml` and regenerates `vault/agents/registry.md`. The core reads the registry to decide when to delegate. After you add an agent, send `/restart` in Telegram.

**Writing good agents:**
- Make `description` a single sentence about *when* to use the agent. The core routes requests on it.
- Read `vault/agents/_rules.md`. It holds the universal rules, such as the memory schema and write isolation, and the core passes them to every agent.
- An agent's write access ends at its own `memory/` folder. If it needs to put something elsewhere, it asks the core to do it.

Bundled agents:
- `email`: needs the gmail root
- `github`: needs the github root
- `routines`: scheduled prompts through the `routine` CLI

Delete any agent's folder to uninstall it, memory included.

## Roots (integrations)

A root is a folder in `roots/` with a CLI and a manifest:

```
roots/weather/
  manifest.yaml
  cli.js
  package.json   # optional; deps are installed at image build time
  .env.example   # document required credentials; the real .env is git-ignored
```

`manifest.yaml`:

```yaml
name: weather
version: 0.1
description: Open-Meteo forecast lookups. No auth.
requires_env: []
commands:
  - name: forecast
    usage: node /app/roots/weather/cli.js forecast "<city>"
    description: 3-day forecast as JSON.
```

Conventions:
- Each command prints JSON to stdout. On failure it writes to stderr and exits non-zero.
- Credentials go in `roots/<name>/.env`. That file is never committed or baked into images.
- If the root needs credentials, mount its `.env` read-only into the `core` service in `docker-compose.yml`, the same way gmail and github are mounted.
- Rebuild the core after adding a root: `docker compose build core && docker compose up -d`.

`roots/echo/` is the smallest possible working example.

## Startup instructions

Every markdown file in `vault/startup/` goes into the system prompt of every session:
- `standing-orders.md` sets identity, response rules, Telegram formatting and delegation rules.
- `vault-instructions.md` covers how to read and write memory.

You can add your own files there too, for example `about-me.md`.

## Helper CLIs available inside the core

- `vault`: query the memory graph with `activate`, `lookup`, `search`, `backlinks` and more. Run `vault` alone for help.
- `routine`: create, list, toggle, remove and fire-now scheduled prompts.
- `send-message "<text>"`: push an unsolicited Telegram message.
- `send-to-user <path-in-vault> [caption]`: send a file.
- `send-location <note-id>`: send a map pin for a note with `maps_url:` or `coords:`.
