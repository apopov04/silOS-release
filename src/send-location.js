#!/usr/bin/env node
// send-location <note-id> — send the note's venue (pin + title + address) to
// the user via Telegram. Reads coords from the note's frontmatter. If coords
// are missing but maps_url is present, unfurls the short link to extract
// coordinates and caches them back into the file so future calls skip the HTTP
// round-trip.
//
// Usage:
//   send-location ramen-place
//   send-location city-library

import fs from "fs";
import path from "path";
import matter from "gray-matter";

const VAULT = "/app/vault";

const id = process.argv[2];
if (!id) {
  console.error("Usage: send-location <note-id>");
  process.exit(1);
}

// Notes live flat in core/ or each agent's memory/. Try core first, then agents.
function findNoteFile(noteId) {
  const candidates = [path.join(VAULT, "core", `${noteId}.md`)];
  const agentsDir = path.join(VAULT, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const agent of fs.readdirSync(agentsDir)) {
      candidates.push(path.join(agentsDir, agent, "memory", `${noteId}.md`));
    }
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function parseCoords(raw) {
  if (!raw) return null;
  const m = String(raw).match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
}

// Google Maps short URLs redirect to full place URLs. The path contains two
// coord pairs: "@LAT,LNG,zoom" is the viewport center at share time; "!3dLAT!4dLNG"
// is the explicit place location. Prefer the explicit one — viewports drift if
// the user panned before sharing.
async function coordsFromMapsUrl(url) {
  try {
    const r = await fetch(url, { method: "GET", redirect: "follow" });
    const final = r.url;
    let m = final.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
    if (!m) m = final.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
    return m ? { lat: parseFloat(m[1]), lng: parseFloat(m[2]) } : null;
  } catch {
    return null;
  }
}

const filePath = findNoteFile(id);
if (!filePath) {
  console.error(`Note not found: ${id}`);
  process.exit(1);
}

const raw = fs.readFileSync(filePath, "utf8");
const parsedFile = matter(raw);
const fm = parsedFile.data;

let coords = parseCoords(fm.coords);

if (!coords) {
  if (!fm.maps_url) {
    console.error(`${id}: no coords and no maps_url to unfurl`);
    process.exit(1);
  }
  coords = await coordsFromMapsUrl(fm.maps_url);
  if (!coords) {
    console.error(`${id}: couldn't extract coords from maps_url`);
    process.exit(1);
  }
  fm.coords = `${coords.lat},${coords.lng}`;
  fm.updated = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(filePath, matter.stringify(parsedFile.content, fm));
}

if (!fm.title || !fm.address) {
  console.error(`${id}: both title and address required in frontmatter`);
  process.exit(1);
}

try {
  const res = await fetch("http://bot:3001/send-venue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      lat: coords.lat,
      lng: coords.lng,
      title: fm.title,
      address: fm.address,
    }),
  });
  const text = await res.text();
  if (res.ok) {
    console.log(text || JSON.stringify({ sent: true }));
    process.exit(0);
  }
  console.error(`send-venue failed (${res.status}): ${text}`);
  process.exit(1);
} catch (err) {
  console.error(`Connection error: ${err.message}`);
  process.exit(1);
}
