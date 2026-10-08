---
title: Vault System
type: system
---

## Vault System

You have a persistent memory vault at `/app/vault/`. Use it to store and retrieve information across sessions.

### Structure (flat, not hierarchical)

- `vault/startup/` — standing orders and this file, read at session start
- `vault/core/` — your (the core session's) own notes, flat
- `vault/agents/<name>/memory/` — each agent's private memory namespace, flat
- `vault/agents/<name>/scripts/` — reusable scripts an agent has written for itself
- `vault/conversations/` — per-session summaries (written on /save, /restart, /compact)

There is **no** `notes/`, `entities/`, `projects/`, or `inbox/` folder. Don't try to categorize notes by directory — use frontmatter + links. A "project" is just a memory note with `type: project`; if it has work-files beyond markdown, point at them with a `workspace:` frontmatter field.

### Required frontmatter on every note

```yaml
---
id: lowercase-slug          # stable; a-z / 0-9 / -
title: Human Readable Title
type: person | place | project | fact | preference | decision | conversation | note | learning
aliases: [every name this should be [[linkable]] as]
tags: [freeform]
created: YYYY-MM-DD          # preserve on update/merge
updated: YYYY-MM-DD          # today
---

Body markdown. Link other notes with `[[wikilinks]]`.
```

The indexer's schema validator rejects writes missing any required field. Links resolve via the alias table: `[[Alex]]`, `[[alex rivera]]`, and `[[alex-rivera]]` all hit the `alex-rivera` note.

### Retrieval — query the graph with `vault` commands

**Primary retrieval primitive:**
- `vault activate "<query>"` — seeds from FTS + alias match, propagates weight across edges, returns top-K. Use this before `vault search` when you want *context*, not exact matches.

**Batched retrieval (use this before writing a new note):**
- `vault lookup "<query>"` — one call returns `resolved` (the id of the note matching the alias, if any) + `activation` (top-K related by spreading activation) + `backlinks` (if resolved). Designed to give you everything you need to decide create vs. update vs. merge in a single Bash invocation.

**Structured lookups:**
- `vault resolve "<text>"` — alias → id
- `vault search "<query>"` — raw FTS
- `vault tag <tag>` / `vault type <type>` / `vault property <key> <value>`
- `vault entity "<name>"` — notes that link to a name
- `vault backlinks <id>` — notes that link TO this id
- `vault neighbors <id> [--hops N]` — local subgraph
- `vault path <a> <b>` — shortest path
- `vault important [--type T] [--top N]` — PageRank-ranked
- `vault list` / `vault dangling` / `vault validate <file>` / `vault reindex`

## Saving memory notes (the inline workflow)

**You do this work yourself.** There is no "librarian agent" to delegate to. Filing memory is fast and you have all the tools you need (`vault lookup`, `Write`, `Read`, `Bash`).

### When to save
- When the user explicitly asks you to remember something.
- When a personal fact, preference, decision, or relationship comes up that's useful long-term.
- **NOT** for research results, web-lookup answers, or general information — those are responses, not memories.

### The workflow (aim for 2 turns total, not 10)

**Turn 1 — gather context in parallel.** Claude Code supports parallel Bash tool calls in a single turn. For each key entity/name in the draft, fire one `vault lookup "<name>"` call at the same time. Run them in parallel — do not sequence them. Examples:

```
vault lookup "Sam"
vault lookup "Zagreb"
vault lookup "graphic design studio"
```

All three fire together; you get three JSON blobs back before you reason again.

**Decide between turns:**
- If every lookup returns `resolved: null` and activations don't surface clearly-related notes → **create** a new note.
- If a lookup resolves to an existing note that's clearly about the same thing → **update** (edit that file with the new info; preserve its `created:`; bump `updated:`).
- If two or more existing notes look like duplicates of the same entity → **merge** (pick a winner, consolidate content, delete the losers).

**Turn 2 — write and confirm.** Format the new/updated note's content.

**Wikilink every mentioned entity, aggressively.** Any noun that could itself be a note — a person, place, neighborhood, city, country, company, project, product, event — should be wrapped in `[[...]]`, even if that target note doesn't exist yet. Dangling links are a *feature*: they surface on `vault dangling` as "this thing keeps getting mentioned, maybe it deserves its own note," and when the target note eventually gets created, every prior mention resolves automatically without touching the old files.

Examples of what to link:
- Cities, neighborhoods, countries: `[[Lisbon]]`, `[[Alfama]]`, `[[Portugal]]`
- People: `[[Alex]]`, `[[Sam]]`
- Companies / projects: `[[Acme Corp]]`, `[[the garden project]]`
- Named things (products, events, recurring topics): `[[the spring trip]]`

For mentions that already resolve to an existing note, use the canonical id rather than the pretty name: if "Sam" resolves to `sam` via `vault resolve`, write `[[sam]]`. If it doesn't resolve yet, write `[[Sam]]` as-is — the indexer records the text, and next rebuild it'll auto-resolve when the note exists.

Then use the `Write` tool to write to:
- `/app/vault/core/<id>.md` — for your own notes
- `/app/vault/agents/<agent>/memory/<id>.md` — when saving on behalf of an agent

For merge: write the merged content to the winner's path, then delete the loser's file with `Bash` + `rm`.

Respond to the user naturally — "saved as a new note about Sam" or "updated the note about Alex."

### Validation is optional
Malformed frontmatter will get flagged by the indexer the next time it rebuilds. You can run `vault validate <path>` after writing if you want an immediate check, but don't make it a mandatory step — it costs a turn you don't need.

## Asset notes (binaries: PDFs, images, text files)

Markdown is the only thing the indexer understands, but you can still *remember* a binary attachment by pairing it with a markdown stub. The stub is a bookmark; the binary is the file it points at.

### How attachments arrive

When a user uploads a file via Telegram, the `/message` payload includes a text block like:

> (Attachment staging info — if the user wants any of these persisted into the vault, see vault-instructions.md §"Asset notes". Otherwise ignore; staged files get cleaned up later.
> - document (application/pdf), original name: rulebook.pdf staged at /app/vault/assets/incoming/2026-04-21T14-30-22-123Z-rulebook.pdf
> )

The binary also arrives as a normal Claude content block (document/image) on the same turn — so you can *read* its contents natively to answer about it. Staging is only relevant if the user wants it remembered long-term.

### When to persist (and when not to)

**Persist** when the user signals they want this saved: "remember this," "save this rulebook," "add this to my notes," etc.

**Don't persist** when the user just wants you to *look at* a file — discuss it, answer questions, then let the staging file sit in `incoming/` unclaimed. Cleanup is someone else's job.

### The persist workflow

1. **Look up** the likely name of the thing the file is about — run one or two parallel `vault lookup` calls like always.
2. **Decide** the canonical slug id (`a-z`, `0-9`, `-` only). Must match the stub's `id:` frontmatter field *exactly*.
3. **Move** the binary: `mv /app/vault/assets/incoming/<staged-name> /app/vault/assets/<id>.<ext>` via Bash.
4. **Write** the paired stub to `/app/vault/core/<id>.md`:

```yaml
---
id: catan-rulebook
title: Catan rulebook
type: note
asset: assets/catan-rulebook.pdf
aliases: [catan rules, Settlers of Catan rulebook]
tags: [board-game, rulebook]
created: 2026-04-21
updated: 2026-04-21
---

Rulebook PDF for [[Catan]]. Covers setup, trading, building and the robber.
```

5. **Confirm** to the user naturally: "saved the Catan rulebook."

### Rules for good stubs

- **Keep the description to 1-2 sentences.** The stub is a catalog card, not a summary of the file's contents. If you need the actual contents later, re-read the file at the `asset:` path.
- **Include identifiable hooks** — people, places, events, entities mentioned in the file. Those are what will surface the stub via `vault activate` later. Aesthetic descriptions ("a photo of a whiteboard") don't help retrieval; contextual ones ("[[alex]]'s kitchen whiteboard showing the Q2 reno budget") do.
- **Wikilink aggressively** — same rule as any note. Dangling links are fine; they're a signal.
- **Slug = filename.** If the stub's id is `lease-2026`, the binary MUST be at `assets/lease-2026.pdf`. A mismatch breaks the `asset:` pointer.
- **Accepted binary types:** PDF, images (jpg/png/gif/webp). Anything else is rejected at the bot layer before it reaches you.
- **Text files** (.md, .txt, code) are inlined into the prompt as text — they don't need staging. If the user wants text content saved, just write it to a regular note; there's no binary to move.

### What NOT to do

- **Don't delegate this to a sub-agent.** There is no librarian agent in the registry. Doing this inline is 5-10× faster.
- **Don't retroactively edit old notes** to add forward links to new ones. Backlinks are computed from the index automatically — old notes "know" about new ones that link them without their files being touched.
- **Don't categorize by folder.** Everything in core/ is flat. Use frontmatter `type:` and `tags:` to organize.
- **Don't write notes before doing `vault lookup`** on the draft's main subject. You'll create duplicates.
- **Don't hardcode lists that duplicate what the graph already tracks.** A "Places in Lisbon" section in `lisbon.md` listing every restaurant will go stale immediately — every new Lisbon note requires updating that list. The graph already knows this: `vault backlinks lisbon` returns every note that wikilinks to it, dynamically. Keep notes short; describe the thing itself; let backlinks handle "what links here."
- **Don't conflate activation with specific relationships.** `vault activate "lisbon"` returns notes that are *related* to Lisbon via any graph path — not notes *located in* Lisbon. A high activation score just means "a path exists." Before writing a location/relationship fact like "X is in Y", "X works at Y", "X is Y's sister", verify from **X's own note** (check its `location:` frontmatter, `city:` field, or body text). If you can't verify, don't state the relationship. Graph proximity ≠ factual attribution.

### Before saying "I don't know"
Run `vault activate "<question>"` first. The answer may already be in the vault.
