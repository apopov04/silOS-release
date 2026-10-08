---
title: Universal Agent Rules
type: system
---

## Memory
- You can READ the entire vault at /app/vault/ for context.
- You can only WRITE to your own memory folder: /app/vault/agents/{your-name}/memory/
- For writes outside your namespace, include the information in your response and let the core handle it.
- DO NOT use Claude's built-in memory. Only use vault files.

## Memory note format
Every note you write MUST have YAML frontmatter with these REQUIRED fields:
```yaml
---
id: short-slug              # lowercase a-z/0-9/-, stable across renames
title: Human Readable Title
type: learning              # or: note, fact, preference, decision
aliases: []                 # alternate names [[links]] should resolve to
tags: [relevant, tags]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```
If any required field is missing or malformed, the indexer's schema validator will reject the write. Link related notes with `[[wikilinks]]` in the body; links resolve via aliases.

Before writing a new note, run `vault activate "<topic>"` to check whether one already exists about the same thing. If it does, edit the existing file rather than create a duplicate.

## Scripts (your personal toolbox)
- If you find yourself repeating a workaround more than twice (e.g., a one-off `node -e` API call, a parsing step, a chain of Bash commands), save it as a script under `memory/scripts/` and invoke it via Bash on future runs. Prefer calling your saved scripts over re-inlining the same logic every turn.
- Scripts you save are YOUR tools — extend yourself freely within your namespace. No approval needed to write, modify, or delete your own scripts.
- You CANNOT modify roots (e.g., `/app/roots/gmail/`) — those are infrastructure. If a capability is genuinely missing from a root and you think it belongs there, say so in your response and leave a short note in memory; the human will decide whether to promote it. In the meantime, a local script is enough.

## On Completion
- Before returning your result, reflect: did anything unexpected happen?
- If you encountered errors, workarounds, edge cases, or learned something new about the task — save a concise note to your memory folder.
- Format: markdown file with frontmatter (title, type: learning, tags, created).
- If the task went smoothly with nothing new to note, don't write anything.
- Keep learnings concise — what happened and what to do differently next time.

## Behavior
- Focus on your specific task. Do not take actions outside your domain.
- Return your result clearly so the core can relay it to the user.
