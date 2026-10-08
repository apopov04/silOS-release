#!/usr/bin/env node
// GitHub root CLI. Agents invoke this via Bash; each run is stateless.
//
// Commands:
//   repo-list [--limit N]
//   repo-clone <owner/repo>                           Idempotent: pulls if already cloned.
//   file-read <owner/repo> <path> [--ref <ref>]
//   issue-list <owner/repo> [--state open|closed|all] [--limit N]
//   issue-read <owner/repo> <number>
//   issue-create <owner/repo> --title "<t>" --body "<b>" [--label <l>]
//   issue-comment <owner/repo> <number> --body "<b>"
//   pr-list <owner/repo> [--state open|closed|all] [--limit N]
//   pr-read <owner/repo> <number>
//   pr-diff <owner/repo> <number>
//   pr-comment <owner/repo> <number> --body "<b>"
//
// stdout: JSON on success. stderr + non-zero exit on error.
// Auth: GH_TOKEN read from ./.env, injected into every gh/git subprocess.

import { readFileSync, existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, ".env");
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/app/workspace";
const MAX_BUFFER = 50 * 1024 * 1024; // 50 MB — room for large PR diffs and API payloads.

// --- env loading ---------------------------------------------------------

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

if (!existsSync(ENV_PATH)) die(`Missing ${ENV_PATH}. Paste your classic PAT as GH_TOKEN=<pat>.`);
const env = parseEnv(readFileSync(ENV_PATH, "utf8"));
const { GH_TOKEN } = env;
if (!GH_TOKEN) die(`.env is missing GH_TOKEN.`);

// --- subprocess helpers --------------------------------------------------

function childEnv() {
  // Pass GH_TOKEN into the child; gh reads it automatically for API calls,
  // and `gh auth git-credential` uses it for git operations.
  return { ...process.env, GH_TOKEN };
}

function runGh(args) {
  try {
    return execFileSync("gh", args, {
      env: childEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || "";
    const stdout = err.stdout?.toString().trim() || "";
    die(`gh ${args.slice(0, 2).join(" ")} failed: ${stderr || stdout || err.message}`);
  }
}

function runGit(args) {
  // Delegate HTTPS credentials to gh — it reads GH_TOKEN from env.
  // Avoids persisting the token in any on-disk git config.
  const fullArgs = [
    "-c", "credential.https://github.com.helper=",
    "-c", "credential.https://github.com.helper=!gh auth git-credential",
    ...args,
  ];
  try {
    return execFileSync("git", fullArgs, {
      env: childEnv(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
    });
  } catch (err) {
    const stderr = err.stderr?.toString().trim() || "";
    const stdout = err.stdout?.toString().trim() || "";
    die(`git failed: ${stderr || stdout || err.message}`);
  }
}

// --- arg parsing ---------------------------------------------------------

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
        if (next !== undefined && !next.startsWith("--")) {
          out[a.slice(2)] = next;
          i++;
        } else {
          out[a.slice(2)] = true;
        }
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function requireRepo(positional) {
  const repo = positional[0];
  if (!repo || !repo.includes("/")) {
    die(`Expected <owner/repo> as first positional argument (got: ${repo || "(missing)"}).`);
  }
  return repo;
}

function clampLimit(raw, def = 30, max = 100) {
  const n = parseInt(raw ?? def, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, 1), max);
}

// --- commands ------------------------------------------------------------

// `gh repo list` shows only repos OWNED by the authenticated user. Our account
// is a collaborator on repos it doesn't own, so we use the REST API with the
// collaborator affiliation filter instead.
function cmdRepoList(args) {
  const limit = clampLimit(args.limit);
  const out = runGh([
    "api",
    `/user/repos?per_page=${limit}&affiliation=owner,collaborator,organization_member&sort=updated`,
  ]);
  const raw = JSON.parse(out);
  const repos = raw.map((r) => ({
    nameWithOwner: r.full_name,
    description: r.description,
    visibility: r.private ? "private" : "public",
    isPrivate: r.private,
    defaultBranch: r.default_branch,
    updatedAt: r.updated_at,
    url: r.html_url,
  }));
  console.log(JSON.stringify({ count: repos.length, repos }, null, 2));
}

function cmdRepoClone(args) {
  const repo = requireRepo(args._);
  const slug = repo.split("/")[1]; // preserve GitHub's capitalization for the workspace dir
  if (!slug) die(`Malformed <owner/repo>: ${repo}`);
  const target = path.join(WORKSPACE_DIR, slug);

  const alreadyCloned = existsSync(path.join(target, ".git"));
  if (alreadyCloned) {
    runGit(["-C", target, "pull", "--ff-only"]);
    console.log(JSON.stringify({
      action: "pull",
      repo,
      workspace: `workspace/${slug}`,
      absolutePath: target,
    }, null, 2));
    return;
  }

  runGh(["repo", "clone", repo, target]);
  console.log(JSON.stringify({
    action: "clone",
    repo,
    workspace: `workspace/${slug}`,
    absolutePath: target,
  }, null, 2));
}

function cmdFileRead(args) {
  const repo = requireRepo(args._);
  const filePath = args._[1];
  if (!filePath) die(`Usage: file-read <owner/repo> <path> [--ref <ref>]`);
  const ref = args.ref;

  const apiPath = `/repos/${repo}/contents/${encodeURI(filePath)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
  const raw = runGh(["api", apiPath]);
  const data = JSON.parse(raw);

  if (Array.isArray(data)) {
    // Path pointed at a directory, not a file — return the listing.
    console.log(JSON.stringify({
      type: "directory",
      path: filePath,
      entries: data.map((e) => ({ name: e.name, type: e.type, size: e.size, path: e.path })),
    }, null, 2));
    return;
  }
  if (data.type !== "file") {
    die(`Unexpected response type '${data.type}' for path '${filePath}'.`);
  }
  const content = data.encoding === "base64"
    ? Buffer.from(data.content, "base64").toString("utf8")
    : (data.content || "");
  console.log(JSON.stringify({
    type: "file",
    path: data.path,
    size: data.size,
    sha: data.sha,
    encoding: data.encoding,
    content,
  }, null, 2));
}

function cmdIssueList(args) {
  const repo = requireRepo(args._);
  const state = args.state || "open";
  const limit = clampLimit(args.limit);
  const out = runGh([
    "issue", "list",
    "--repo", repo,
    "--state", state,
    "--limit", String(limit),
    "--json", "number,title,state,author,createdAt,updatedAt,labels,url",
  ]);
  const issues = JSON.parse(out);
  console.log(JSON.stringify({ repo, state, count: issues.length, issues }, null, 2));
}

function cmdIssueRead(args) {
  const repo = requireRepo(args._);
  const number = args._[1];
  if (!number) die(`Usage: issue-read <owner/repo> <number>`);
  const out = runGh([
    "issue", "view", number,
    "--repo", repo,
    "--json", "number,title,body,state,author,createdAt,updatedAt,labels,comments,url",
  ]);
  // Already well-formed JSON from gh — re-emit as-is.
  console.log(out.trim());
}

function cmdIssueCreate(args) {
  const repo = requireRepo(args._);
  const { title, body, label } = args;
  if (!title || body === undefined) {
    die(`Usage: issue-create <owner/repo> --title "<t>" --body "<b>" [--label <l>]`);
  }
  const ghArgs = ["issue", "create", "--repo", repo, "--title", String(title), "--body", String(body)];
  if (label) ghArgs.push("--label", String(label));
  const out = runGh(ghArgs).trim();
  // gh prints the new issue URL as the last line of stdout.
  const url = out.split("\n").filter(Boolean).pop();
  console.log(JSON.stringify({ created: true, url, repo }, null, 2));
}

function cmdIssueComment(args) {
  const repo = requireRepo(args._);
  const number = args._[1];
  if (!number) die(`Usage: issue-comment <owner/repo> <number> --body "<b>"`);
  const { body } = args;
  if (body === undefined) die(`Missing --body "<b>"`);
  const out = runGh([
    "issue", "comment", number,
    "--repo", repo,
    "--body", String(body),
  ]).trim();
  const url = out.split("\n").filter(Boolean).pop();
  console.log(JSON.stringify({ commented: true, url, repo, issue: Number(number) }, null, 2));
}

function cmdPrList(args) {
  const repo = requireRepo(args._);
  const state = args.state || "open";
  const limit = clampLimit(args.limit);
  const out = runGh([
    "pr", "list",
    "--repo", repo,
    "--state", state,
    "--limit", String(limit),
    "--json", "number,title,state,author,headRefName,baseRefName,isDraft,createdAt,updatedAt,url",
  ]);
  const prs = JSON.parse(out);
  console.log(JSON.stringify({ repo, state, count: prs.length, pullRequests: prs }, null, 2));
}

function cmdPrRead(args) {
  const repo = requireRepo(args._);
  const number = args._[1];
  if (!number) die(`Usage: pr-read <owner/repo> <number>`);
  const out = runGh([
    "pr", "view", number,
    "--repo", repo,
    "--json", "number,title,body,state,author,headRefName,baseRefName,isDraft,mergeable,createdAt,updatedAt,comments,url",
  ]);
  console.log(out.trim());
}

function cmdPrDiff(args) {
  const repo = requireRepo(args._);
  const number = args._[1];
  if (!number) die(`Usage: pr-diff <owner/repo> <number>`);
  const diff = runGh(["pr", "diff", number, "--repo", repo]);
  console.log(JSON.stringify({ repo, pr: Number(number), diff }, null, 2));
}

function cmdPrComment(args) {
  const repo = requireRepo(args._);
  const number = args._[1];
  if (!number) die(`Usage: pr-comment <owner/repo> <number> --body "<b>"`);
  const { body } = args;
  if (body === undefined) die(`Missing --body "<b>"`);
  const out = runGh([
    "pr", "comment", number,
    "--repo", repo,
    "--body", String(body),
  ]).trim();
  const url = out.split("\n").filter(Boolean).pop();
  console.log(JSON.stringify({ commented: true, url, repo, pr: Number(number) }, null, 2));
}

// --- dispatch ------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

const handlers = {
  "repo-list": cmdRepoList,
  "repo-clone": cmdRepoClone,
  "file-read": cmdFileRead,
  "issue-list": cmdIssueList,
  "issue-read": cmdIssueRead,
  "issue-create": cmdIssueCreate,
  "issue-comment": cmdIssueComment,
  "pr-list": cmdPrList,
  "pr-read": cmdPrRead,
  "pr-diff": cmdPrDiff,
  "pr-comment": cmdPrComment,
};

const handler = handlers[cmd];
if (!handler) {
  die(`Unknown command: ${cmd || "(none)"}. Expected one of: ${Object.keys(handlers).join(", ")}`);
}

try {
  handler(args);
} catch (err) {
  die(`Error: ${err?.message || String(err)}`);
}
