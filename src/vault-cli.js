#!/usr/bin/env node

import fs from "fs";
import matter from "gray-matter";
import indexer from "./vault-indexer.js";
import { validateNote } from "./schema-validator.js";

const VAULT_PATH = "/app/vault";
const args = process.argv.slice(2);
const command = args[0];

// Minimal flag parser — pulls --key val / --key=val out of args, leaves positionals
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > -1) {
        out[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { out[a.slice(2)] = next; i++; }
        else out[a.slice(2)] = true;
      }
    } else out._.push(a);
  }
  return out;
}

const parsed = parseArgs(args.slice(1));

indexer.init(VAULT_PATH);

function printNotes(rows) {
  if (!rows || rows.length === 0) { console.log("No results."); return; }
  for (const r of rows) {
    const type = r.type ? ` [${r.type}]` : "";
    console.log(`${r.id}${type} — ${r.title || ""}`);
  }
}

function printActivate(rows) {
  if (!rows || rows.length === 0) { console.log("No results."); return; }
  for (const r of rows) {
    const type = r.type ? ` [${r.type}]` : "";
    console.log(`${r.weight.toFixed(3)}  ${r.id}${type} — ${r.title || ""}`);
  }
}

function usage() {
  console.log(`vault - silOS memory vault CLI

Retrieval:
  vault activate "<query>" [--hops N] [--top K]
      Primary retrieval primitive. Seeds from FTS + alias match, runs
      spreading activation, returns top-K by accumulated weight.

  vault lookup "<query>" [--hops N] [--top K]
      Batched: resolve + activate + backlinks in a single JSON blob.
      Use this when filing a new note — one call gets you everything
      needed to decide create vs update vs merge.

  vault neighbors <id> [--hops N]
      k-hop neighborhood of a note.

  vault path <a> <b>
      Shortest path between two note ids (undirected).

  vault important [--type T] [--top N]
      Top-N most central notes by precomputed PageRank.

Lookup:
  vault resolve "<text>"     Resolve a [[link]] text to a note id via aliases.
  vault search "<query>"     Full-text search (bm25-ranked).
  vault entity "<name>"      Notes that link to a given entity.
  vault tag <tag>            Notes with a tag.
  vault type <type>          Notes of a given type.
  vault property <key> <val> Notes with a matching property.
  vault range <key> <min> <max> [--type T] [--top N]
                             Numeric-range query over a property. Values cast to
                             REAL; non-numeric properties excluded. Sorted DESC.
  vault backlinks <id>       Notes that link to this id.
  vault list                 All notes, most recent first.

Maintenance:
  vault dangling             Links that didn't resolve to any note.
  vault validate <file>      Check a note file's frontmatter against the schema.
  vault reindex              Force a full rebuild of the index.`);
}

try {
  switch (command) {
    case "activate": {
      const q = parsed._[0];
      if (!q) { console.log(`Usage: vault activate "<query>" [--hops N] [--top K]`); break; }
      const results = indexer.activate(q, {
        hops: parseInt(parsed.hops || "3", 10),
        topK: parseInt(parsed.top || "20", 10),
      });
      printActivate(results);
      break;
    }

    case "neighbors": {
      const id = parsed._[0];
      if (!id) { console.log("Usage: vault neighbors <id> [--hops N]"); break; }
      const hops = parseInt(parsed.hops || "2", 10);
      printNotes(indexer.neighbors(id, hops));
      break;
    }

    case "path": {
      const a = parsed._[0], b = parsed._[1];
      if (!a || !b) { console.log("Usage: vault path <a> <b>"); break; }
      const result = indexer.shortestPath(a, b);
      if (!result) { console.log("No path found."); break; }
      printNotes(result);
      break;
    }

    case "important": {
      const type = parsed.type || null;
      const limit = parseInt(parsed.top || "10", 10);
      const rows = indexer.topByCentrality({ type, limit });
      if (!rows.length) { console.log("No results."); break; }
      for (const r of rows) {
        const t = r.type ? ` [${r.type}]` : "";
        console.log(`${r.pagerank.toFixed(4)}  in=${r.degree_in} out=${r.degree_out}  ${r.id}${t} — ${r.title || ""}`);
      }
      break;
    }

    case "resolve": {
      const text = parsed._[0];
      if (!text) { console.log(`Usage: vault resolve "<text>"`); break; }
      const id = indexer.resolveAlias(text);
      if (!id) { console.log("Unresolved."); process.exit(2); }
      console.log(id);
      break;
    }

    case "search": {
      const q = parsed._.join(" ");
      if (!q) { console.log(`Usage: vault search "<query>"`); break; }
      printNotes(indexer.searchFts(q));
      break;
    }

    case "entity": {
      const name = parsed._.join(" ");
      if (!name) { console.log(`Usage: vault entity "<name>"`); break; }
      printNotes(indexer.listByEntity(name));
      break;
    }

    case "tag": {
      const tag = parsed._[0];
      if (!tag) { console.log("Usage: vault tag <tag>"); break; }
      printNotes(indexer.listByTag(tag));
      break;
    }

    case "type": {
      const type = parsed._[0];
      if (!type) { console.log("Usage: vault type <type>"); break; }
      printNotes(indexer.listByType(type));
      break;
    }

    case "property": {
      const key = parsed._[0], value = parsed._[1];
      if (!key || !value) { console.log("Usage: vault property <key> <value>"); break; }
      printNotes(indexer.listByProperty(key, value));
      break;
    }

    case "range": {
      const key = parsed._[0];
      const min = parseFloat(parsed._[1]);
      const max = parseFloat(parsed._[2]);
      if (!key || Number.isNaN(min) || Number.isNaN(max)) {
        console.log("Usage: vault range <key> <min> <max> [--type <type>] [--top N]");
        break;
      }
      const rows = indexer.listByPropertyRange(key, min, max, {
        type: parsed.type || null,
        limit: parseInt(parsed.top || "50", 10),
      });
      if (!rows.length) { console.log("No results."); break; }
      for (const r of rows) {
        const t = r.type ? ` [${r.type}]` : "";
        console.log(`${r.value}  ${r.id}${t} — ${r.title || ""}`);
      }
      break;
    }

    case "backlinks": {
      const id = parsed._[0];
      if (!id) { console.log("Usage: vault backlinks <id>"); break; }
      printNotes(indexer.backlinks(id));
      break;
    }

    case "list":
      printNotes(indexer.listAll());
      break;

    case "dangling": {
      const rows = indexer.danglingLinks();
      if (!rows.length) { console.log("No dangling links."); break; }
      for (const r of rows) {
        console.log(`${r.source_id} — ${r.source_title} -> [[${r.target_text}]]`);
      }
      break;
    }

    case "lookup": {
      const q = parsed._.join(" ");
      if (!q) { console.log(`Usage: vault lookup "<query>" [--hops N] [--top K]`); break; }
      const resolvedId = indexer.resolveAlias(q);
      const resolvedNote = resolvedId ? indexer.getNote(resolvedId) : null;
      const activation = indexer.activate(q, {
        hops: parseInt(parsed.hops || "3", 10),
        topK: parseInt(parsed.top || "10", 10),
      });
      const backlinks = resolvedId ? indexer.backlinks(resolvedId, 20) : [];
      console.log(JSON.stringify({
        query: q,
        resolved: resolvedNote ? {
          id: resolvedNote.id,
          title: resolvedNote.title,
          type: resolvedNote.type,
          path: resolvedNote.path,
        } : null,
        activation,
        backlinks,
      }, null, 2));
      break;
    }

    case "validate": {
      const file = parsed._[0];
      if (!file) { console.log("Usage: vault validate <file>"); process.exit(1); }
      try {
        const raw = fs.readFileSync(file, "utf8");
        const { data: fm } = matter(raw);
        const result = validateNote(fm);
        if (result.ok) {
          console.log("valid");
          break;
        }
        for (const e of result.errors) console.error(`- ${e}`);
        process.exit(1);
      } catch (err) {
        console.error(`Failed to read or parse ${file}: ${err.message}`);
        process.exit(1);
      }
    }

    case "reindex":
      console.log("Reindexing vault...");
      indexer.reindex();
      console.log("Done.");
      break;

    default:
      usage();
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}

process.exit(0);
