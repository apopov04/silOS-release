// Deterministic frontmatter validation for vault notes. Cheap, no LLM calls.
// Runs before any vault write to catch structural errors the librarian (or a
// direct writer) might produce.
//
// Returns { ok: true } or { ok: false, errors: [...] }.
// `errors` are strings meant for logs / agent feedback.

const ALLOWED_TYPES = new Set([
  "person",
  "place",
  "project",
  "fact",
  "preference",
  "decision",
  "conversation",
  "note",
  "learning",
  "system",
  "skill",
  "entity",
  "routine",
]);

const REQUIRED_FIELDS = ["id", "type", "created", "updated"];

function isIsoDateLike(v) {
  // YAML parses `2026-04-20` as a JS Date; accept that too.
  if (v instanceof Date) return !isNaN(v.getTime());
  if (typeof v !== "string") return false;
  // Accept YYYY-MM-DD (minimum) or full ISO-8601 including fractional seconds
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(v);
}

function slugLike(v) {
  return typeof v === "string" && /^[a-z0-9][a-z0-9-]*$/.test(v);
}

export function validateNote(frontmatter) {
  const errors = [];
  const fm = frontmatter || {};

  for (const f of REQUIRED_FIELDS) {
    if (fm[f] === undefined || fm[f] === null || fm[f] === "") {
      errors.push(`missing required field: ${f}`);
    }
  }

  if (fm.id !== undefined && !slugLike(fm.id)) {
    errors.push(`id must be a lowercase slug (a-z, 0-9, -); got ${JSON.stringify(fm.id)}`);
  }

  if (fm.type !== undefined && !ALLOWED_TYPES.has(fm.type)) {
    errors.push(`type '${fm.type}' not in allowed set: ${[...ALLOWED_TYPES].join(", ")}`);
  }

  if (fm.created !== undefined && !isIsoDateLike(fm.created)) {
    errors.push(`created must be YYYY-MM-DD or ISO-8601; got ${JSON.stringify(fm.created)}`);
  }
  if (fm.updated !== undefined && !isIsoDateLike(fm.updated)) {
    errors.push(`updated must be YYYY-MM-DD or ISO-8601; got ${JSON.stringify(fm.updated)}`);
  }

  if (fm.aliases !== undefined && !Array.isArray(fm.aliases)) {
    errors.push(`aliases must be an array; got ${typeof fm.aliases}`);
  }
  if (fm.tags !== undefined && !Array.isArray(fm.tags)) {
    errors.push(`tags must be an array; got ${typeof fm.tags}`);
  }
  if (fm.entities !== undefined && !Array.isArray(fm.entities)) {
    errors.push(`entities must be an array; got ${typeof fm.entities}`);
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// Slugify a title or filename into a stable id. Lowercase, [a-z0-9-], collapses
// runs of non-alphanumerics into a single dash.
export function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export const ALLOWED_TYPES_LIST = [...ALLOWED_TYPES];
