# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is silOS

silOS is a **framework** for building an AOS (Agentic Operating System). It is critically important to understand this distinction: silOS is **not an app** — it is the platform that makes apps (agents) possible. Think of it like iOS or Android — the OS itself doesn't send your emails or manage your calendar. It provides the runtime, memory, and communication layer so that apps can do those things. silOS is the same concept for AI agents.

The end-user experience is simple: you message your AI assistant on Telegram from your phone, and it handles everything. Behind the scenes, a persistent AI session (the "core") runs on a remote server, orchestrating specialized agents, reading/writing a persistent memory vault, and connecting to external services. The user sees a chat. The system sees a full operating environment.

Built by Silicairn. The name "silOS" combines "Silicairn" + "OS", and evokes "silo" — reflecting the project's emphasis on security and containment. Everything stays on the server; nothing leaks.

The north star vision: **a second brain** — an always-on assistant on your server that you can message anytime, that remembers everything, that gets better over time, and that can act on your behalf. Not a chatbot you talk at, but a collaborator that is always running, always aware, and always up to date.

## Competitive Positioning

silOS's closest competitor is **OpenClaw** (formerly Clawdbot) — an open-source personal AI agent with 350k+ GitHub stars, 20+ messaging platform integrations, Docker sandboxing, voice mode, and a large community. OpenClaw is a mature, feature-rich product.

**silOS does NOT compete on features or breadth.** OpenClaw has more platforms, more integrations, more deployment options, and a massive head start. Competing on surface area would be a losing strategy.

**silOS competes on security.** This is the core differentiator and the identity of the project.

OpenClaw's security model is permissive by default — it gives agents broad access and relies on Docker containers to limit blast radius after the fact. silOS takes the opposite approach: **deny by default, grant minimally, prevent damage before it happens.**

### Security as Identity

The "silo" in silOS is not decorative. Security and containment are the defining characteristics of the framework:

**1. Least Privilege for Agents**
Agents only get access to what they explicitly need. An email agent can access the email root but cannot touch the filesystem, other roots, or other agents' vault namespaces unless explicitly granted. Access is declared, not assumed. This is enforced in code by default — not a best-practices suggestion.

**2. Prompt Injection Defense**
When silOS fetches external content (web pages, emails, API responses, documents), that content passes through a sanitization layer before entering the agent's context. External content is a primary injection vector — a malicious web page could contain instructions that hijack the agent. silOS screens for this at the framework level. OpenClaw does not have this.

**3. Rogue Agent Containment**
An agent can go rogue for any reason — prompt injection, hallucination, buggy code, malicious design. The cause is irrelevant. What matters is that the system limits the damage a rogue agent can do. This is achieved through:
- Write isolation (agents can only write to their own vault namespace)
- Access scoping (agents only get the tools/roots they were granted)
- Core as gatekeeper (all cross-boundary actions go through core)
- Framework-level enforcement (these constraints are in the code, not configuration)

**4. Baked In, Not Opt-In**
Security constraints are enforced by default in the framework code. Users CAN remove them (it's open source), but out of the box, silOS is locked down. This is the opposite of OpenClaw's approach, which is permissive by default and requires users to configure restrictions.

### What silOS Does NOT Compete On

- Platform breadth (OpenClaw supports 20+ platforms; silOS does Telegram)
- Voice, Canvas, browser control, device integrations
- Community size or ecosystem maturity
- Deployment flexibility (Docker, Fly.io, Tailscale, etc.)

These may come later, but they are not the differentiator.

## Architecture Overview

The system has four layers:

```
User (phone)
    |
    | Telegram
    v
Core Session (remote server)
    |
    |--- Agents (specialized sub-sessions, like apps)
    |--- Memory Vault (persistent markdown knowledge graph)
    |--- Roots (external integrations: Gmail, APIs, services)
```

The user only ever talks to the core session via Telegram. Everything below that line is invisible to them.

## Core Session

The core is a persistent Claude Code session running on the remote server. It is the brain of silOS — the central orchestrator that everything flows through.

**What the core does:**
- Receives all user messages from Telegram (it is the ONLY thing the user talks to)
- Understands intent and decides which agent(s) to invoke, if any
- Calls agents as sub-sessions, passing them context and receiving results
- Reads and writes to the memory vault directly
- Acts as the sole gatekeeper for cross-namespace writes in the vault (see Memory Isolation below)
- Manages roots (external integrations)
- Returns responses to the user via Telegram

**What the core does NOT do:**
- It does not handle domain-specific tasks itself if a specialized agent exists — it delegates
- It does not expose any internal architecture to the user — the user's experience is just a Telegram conversation

The core is currently built with Claude Code and Claude as the model. The long-term vision is model-agnostic (any AI could power the core), but for now, all development assumes Claude Code and Claude specifically.

## Agents (Apps)

Agents are the "apps" of silOS. Just as a phone OS runs apps for specific tasks, silOS runs agents — specialized Claude Code sub-agent sessions that the core calls in when needed.

**What an agent is, concretely:**
An agent is a Claude Code skill or sub-agent. It has a specialized system prompt and potentially specific tools/configurations that make it good at a particular domain (email management, scheduling, code review, research, etc.). When the core needs specialized help, it spawns the agent as a sub-session, gives it context, receives the result, and continues.

**Key properties:**
- **Invisible to users** — users don't know or care which agent handled their request. They talk to core. Core decides. After initial install/setup, users never interact with agent infrastructure directly.
- **Can come from anywhere** — agents can be custom-built by the user, downloaded from GitHub, shared by the community, or pulled from any source. There is no centralized marketplace (yet).
- **Can trigger each other** — agents can invoke other agents when their task requires it. For example, a "morning briefing" agent might call the email agent and the calendar agent to compile its summary. Under the hood, this is the Claude Code Agent tool.
- **Listed in a registry** — the core session references a structured list of all installed agents so it knows what's available and when to invoke each one. The exact format of this registry is an open design question.
- **Eventually a community ecosystem** — the long-term vision includes people building, sharing, and downloading agents freely. But this is a later concern. For now, the focus is on the framework that makes agents possible, not building a store.

**What we are building vs. what we are NOT building:**
We are building the framework — the agent runtime, the registry system, the invocation mechanism, the memory isolation model. We are NOT building the agents themselves (email agent, calendar agent, etc.). Those are apps that users or the community will create. This distinction is fundamental to every design decision.

## Memory System

The memory system is the most critical component of silOS. It is what makes the agent persistent rather than ephemeral. Without it, every session starts from zero. With it, knowledge compounds over time.

### Design Philosophy

The memory system is modeled after Obsidian (obsidian.md), a knowledge management app built on local markdown files with bidirectional linking. However, silOS does NOT depend on Obsidian — it implements the same concepts from scratch, purpose-built for AI consumption rather than human browsing.

**Why Obsidian's model was chosen as inspiration:**
- **Plain markdown files** — no proprietary format, no database dependency, fully portable
- **Bidirectional linking** — notes reference each other, creating a navigable knowledge graph rather than a flat file dump
- **Frontmatter/properties** — structured metadata on every note enables programmatic querying
- **Compounding value** — the more notes you add, the more connections emerge. The system gets smarter over time.

### Core Concepts

**Vault:** The vault is simply a directory of markdown files on the server. It is the agent's entire long-term memory. Every decision, project, conversation summary, piece of context, and historical record lives here as a markdown file.

**Bidirectional Linking:** Notes reference each other using `[[wikilink]]` syntax. If Note A links to Note B, the system also knows that Note B is linked FROM Note A (a backlink). This creates a navigable graph — the agent can start at any note and follow links to find related context, rather than doing brute-force searches through every file.

This is the key architectural advantage: the agent doesn't need to re-read the entire vault every session. It can query the index, find relevant entry points, and follow links to navigate to what it needs. The linking structure IS the agent's associative memory.

**Properties/Frontmatter:** Every note has YAML frontmatter at the top containing structured metadata:
```yaml
---
title: Project Alpha Status
type: project
tags: [active, client-work]
created: 2026-03-15
aliases: [Alpha, Project A]
---
```
This enables filtering and querying by type, tag, date, etc. without reading file contents.

**Index/Cache:** A metadata index that tracks all links, backlinks, tags, properties, and aliases across the vault. This enables fast lookups without scanning every file. The index is rebuilt when files change.

**Queryable Mid-Session:** The vault is NOT bulk-loaded into context at session start. That would be wasteful and would not scale. Instead, the agent queries the index to find relevant notes, reads those specific notes, and follows links to navigate deeper. The linking structure allows on-demand, targeted retrieval — the agent looks up what it needs, when it needs it.

**Unlinked Mentions:** The system can surface potential connections — places where a note's name or alias appears in other notes but isn't explicitly linked yet. This helps the agent discover relationships it hasn't formally established.

### Memory Isolation Model

The vault uses a **namespaced shared vault** architecture (this was a deliberate design decision over two alternatives):

**How it works:**
- There is ONE vault. All agents can **read** the entire vault — this maximizes cross-agent context.
- Each agent can only **write** to its own namespace directory (e.g., `vault/agents/email/`, `vault/agents/calendar/`).
- The core session has **full write access** to the entire vault. It manages a core area (e.g., `vault/core/`) and can write anywhere.
- If an agent needs to write outside its namespace, it requests the write through the core session. Core is the gatekeeper and decides whether to allow it.
- **Clean uninstall**: to remove an agent and all its data, delete its namespace folder. Gone.

**Why this model was chosen (over alternatives):**

*Option A (fully shared vault — rejected):* All agents read and write everywhere. Maximum context, but a poorly written or malicious third-party agent could overwrite or corrupt other agents' notes. Too dangerous.

*Option B (fully isolated vaults — rejected):* Each agent has its own separate vault. Safe, but agents can't see each other's context. Duplicated information everywhere. The calendar agent stores contact info that the email agent also needs. Loses the compounding benefit.

*Option C (namespaced shared vault — chosen):* Best of both worlds. Cross-agent context available for reading, write isolation prevents agents from stepping on each other, core acts as gatekeeper for cross-namespace writes, and clean uninstall is trivial. This mirrors how mobile OS apps work — each has its own data directory but can read shared resources.

### What the Memory System is NOT

- It is NOT a chat history or conversation log
- It is NOT Obsidian (no dependency on the Obsidian app)
- It is NOT designed for human browsing (though users CAN open the markdown files directly since they're just files — they just shouldn't be editing them while the agent is running)
- It is NOT a traditional database — it's a knowledge graph made of linked markdown files

## Communication: Telegram

Telegram is the sole interface between the user and silOS. It is currently a **hard dependency** of the framework.

**Why Telegram:**
- Works on any phone
- Has a robust bot API
- Supports rich messages (text, images, files)
- Easy to set up
- The user's experience is just a chat — the simplest possible UX

**What Telegram is NOT:**
- It is not the interface to agents — it only connects to the core session
- It is not a UI for managing silOS internals — all orchestration is invisible to the user
- It is not the only possible interface forever — but it is the only one being built right now

## Extensibility: Roots

Roots are external integrations — Gmail accounts, APIs, third-party services, databases, etc. Each root is treated as its own project within the vault, meaning it has its own notes, its own context, and its own history.

Roots expand the agent's capabilities incrementally. Want silOS to manage your email? Add a Gmail root. Want it to monitor a GitHub repo? Add a GitHub root. Each integration is additive — it doesn't alter the core architecture.

## User Configuration

silOS ships with **no hardcoded personality, tone, or behavioral restrictions** beyond what the underlying model (Claude) already has. Instead, there is a setup/configuration file where each user defines:

- How the AI should interact with them (formal, casual, terse, verbose, etc.)
- Any behavioral boundaries or preferences
- Standing orders or recurring instructions

This makes silOS feel personal to each user without baking personality into the framework itself. The framework is neutral; the user shapes their experience.

The long-term vision for setup is that it's as simple as answering a few questions, and the system configures itself. But this is a later concern — the framework comes first.

## Design Principles

These principles should guide every design and implementation decision:

1. **Framework, not app** — We are building the platform, not the apps. Every design decision should ask: "Does this belong in the OS, or is this an app concern?" If it's an app concern, it should be an agent, not core framework code.

2. **Persistence over sessions** — The agent is always running, always aware, always up to date. Session boundaries should be invisible. Context carries forward through the vault.

3. **Compounding knowledge** — Every interaction should enrich the vault. The system should get smarter over time, not reset. Information written today should be discoverable and useful months from now.

4. **Local and private** — Everything stays on the server. No data sent to external services unless the user explicitly configures a root for that purpose.

5. **Collaborator, not tool** — silOS should behave like a teammate with full project continuity and deep context, not a tool you invoke and dismiss.

6. **AI-first design** — The memory system, agent model, and architecture are designed for AI consumers. Human-friendly features (like graph visualization) are nice-to-haves, not requirements. Optimize for how an AI reads, writes, and navigates — not how a human would.

7. **Simplicity for the user** — All complexity lives on the server. The user's experience is just messaging on Telegram. They should never need to think about agents, vaults, namespaces, or indices.

## Hosting & Deployment

silOS runs on a remote hosted server (any always-on Linux box with Docker). It is designed for always-on remote deployment, not local desktop use. The server is where the core session runs, where the vault lives, and where agents execute. Deployment is `docker compose` (services: `bot`, `core`, and the optional `viewer` + `cloudflared` profile). See `docs/SETUP.md`.

## Target User & Release Plan

- **Current phase**: single-user, built for the creator's personal use. Success means it works well day-to-day as a personal AI assistant.
- **Next phase**: given to friends to test. Success means easy setup and demonstrably useful.
- **Eventually**: open source release. Monetization through the ecosystem built around it (agent marketplace, integrations) and enterprise integration consulting.

## Open Design Questions

These are known unknowns that will be resolved as development progresses:

- **Session persistence**: How does the core session stay "always on"? Options include a daemon/wrapper, a Telegram bot process that spawns sessions on message, or a reconnection strategy. TBD.
- **Agent registry format**: Where does the list of installed agents live (vault note? config file?) and what is its schema? TBD.
- **Security implementation**: The security principles are decided (least privilege, sanitization, rogue containment, baked-in enforcement — see Competitive Positioning section). The open question is the specific implementation: how access grants are declared per agent, how the sanitization layer works technically, and how framework-level enforcement is structured in code. TBD.
- **Conflict safeguards**: What happens if the user manually edits a vault note while an agent is also writing to it? Ideally users don't do this, but safeguards may be needed. TBD.
