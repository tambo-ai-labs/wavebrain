// WaveBrain auto-capture, shared by every agent plugin. No dependencies (Node >= 18).
//
// Hooks call two verbs:
//   observe: after a tool call. Records high-stakes actions (deploys, pushes, publishes,
//            payments, emails, database writes) to a local queue. Never touches the network
//            unless the queue has been waiting a long time.
//   flush:   at the end of a turn. Sends queued actions to WaveBrain, skipping any the agent
//            already logged itself with log_action during that turn.
//
// Capture is local-first: a failed upload stays in ~/.wavebrain/queue and is retried next turn.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_URL = "https://getwavebrain.com/api/v1/actions";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // drop queued items older than a week
const STALE_MS = 10 * 60 * 1000; // flush from observe if something has waited this long
const MAX_PER_FLUSH = 25;

export function home(env = process.env) {
  return env.WAVEBRAIN_HOME || path.join(env.HOME || os.homedir(), ".wavebrain");
}

export function loadRules(file = path.join(HERE, "rules.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    shell: raw.shell.map((r) => ({ ...r, re: new RegExp(r.pattern, "i") })),
    mcpWriteVerbs: raw.mcp_write_verbs,
    mcpSkipServers: new Set(raw.mcp_skip_servers),
    friendly: raw.friendly || {},
  };
}

export function loadConfig(env = process.env) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(home(env), "config.json"), "utf8"));
  } catch {}
  return {
    // Claude Code plugin: the key from the plugin's own prompt, stored in the system keychain.
    apiKey: env.WAVEBRAIN_API_KEY || env.CLAUDE_PLUGIN_OPTION_API_KEY || cfg.apiKey || null,
    apiUrl: env.WAVEBRAIN_API_URL || cfg.apiUrl || DEFAULT_API_URL,
    enabled: env.WAVEBRAIN_HOOKS !== "off" && cfg.autoCapture !== false,
  };
}

// ---------- secrets ----------

const SECRET_PATTERNS = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bal_[A-Za-z0-9_-]{16,}/g, // WaveBrain keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(sk-(proj-|ant-)?)[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, // user:pass@ in URLs
  /((?:password|passwd|secret|token|api[_-]?key|apikey|auth|access[_-]?key|private[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /(--(?:password|token|api-key|secret|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // long opaque blobs
];

export function redact(text) {
  let s = String(text ?? "");
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, a, b) => {
      if (re.source.startsWith("((?:password") || re.source.startsWith("(--(")) return `${a}[redacted]`;
      if (re.source.startsWith("(Bearer")) return `${a} [redacted]`;
      if (re.source.startsWith("\\b([a-z]")) return `${a}[redacted]@`;
      return "[redacted]";
    });
  }
  return s;
}

// ---------- classification ----------

export function shellCommand(input) {
  const c = input?.command ?? input?.cmd;
  if (Array.isArray(c)) return c.join(" ");
  return typeof c === "string" ? c : "";
}

const SHELL_TOOLS = new Set(["bash", "shell", "local_shell", "exec", "terminal", "run_terminal_cmd", "execute_command"]);

/** Splits "mcp__server__tool" (Claude Code, Codex) or "mcp_server_tool" (Hermes) into parts. */
export function mcpParts(name) {
  let m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] };
  m = name.match(/^mcp_([a-z0-9-]+)_(.+)$/i);
  if (m) return { server: m[1], tool: m[2] };
  // Cursor: "MCP:<tool>", without the server name.
  m = name.match(/^MCP:(.+)$/);
  if (m) return { server: "mcp", tool: m[1], noServer: true };
  return null;
}

/** WaveBrain's own MCP tools; skipped (or treated as the agent's own log) when the server name is missing. */
const WAVEBRAIN_TOOLS = new Set(["log_action", "start_session", "end_session", "list_actions", "list_recent_actions"]);

export function isAgentLog(toolName, toolInput) {
  const n = String(toolName || "");
  if (/wavebrain.*log_action$/i.test(n)) return true;
  if (/^MCP:log_action$/.test(n)) return true; // Cursor drops the server name
  // Cursor reports MCP calls as tool "MCP" with the real name inside the input.
  const inner = toolInput?.toolName || toolInput?.tool_name || toolInput?.name;
  return /^mcp$/i.test(n) && /log_action$/i.test(String(inner || "")) && /wavebrain/i.test(JSON.stringify(toolInput));
}

const firstLine = (s, n = 140) => {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};
// ---------- readable entries ----------
//
// Each rule gets a describer that turns the command plus cheap local context (git, config files
// in the folder, the command's own output) into a work-log entry: WHAT changed, WHERE, and the
// RESULT. Every lookup is local, has a 2 s timeout, and failures fall back to the rule's title.
// Keep in sync with plugins/hermes/__init__.py (test/fixtures/describe.json runs against both).

const strip = (s) => String(s ?? "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** Shell-like word split (quotes group words; no expansion). */
export function words(s) {
  const out = [];
  let cur = null;
  let q = null;
  for (const ch of String(s)) {
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur = cur ?? "";
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? "") + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

/** Value of a flag: `--x v`, `--x=v`, `-x v`. */
function opt(w, names) {
  for (let i = 0; i < w.length; i++) {
    for (const n of names) {
      if (w[i] === n && i + 1 < w.length) return w[i + 1];
      if (n.startsWith("--") && w[i].startsWith(n + "=")) return w[i].slice(n.length + 1);
    }
  }
  return null;
}
const has = (w, names) => w.some((x) => names.some((n) => x === n || (n.startsWith("--") && x.startsWith(n + "="))));

/** Words after `after` (e.g. "push") that aren't flags or flag values. */
function positionals(w, after, valueFlags = []) {
  const i = w.indexOf(after);
  const out = [];
  for (let j = i + 1; j < w.length; j++) {
    if (valueFlags.includes(w[j])) j++;
    else if (!w[j].startsWith("-")) out.push(w[j]);
  }
  return out;
}

function jsonOf(s) {
  try {
    return s == null ? null : JSON.parse(s);
  } catch {
    return null;
  }
}

/** "3 files changed, 10 insertions(+), 2 deletions(-)" -> "+10/−2 lines in 3 files". */
function statLine(s) {
  const f = /(\d+) files? changed/.exec(s || "");
  if (!f) return null;
  const ins = /(\d+) insertions?/.exec(s)?.[1] ?? "0";
  const del = /(\d+) deletions?/.exec(s)?.[1] ?? "0";
  return `+${ins}/−${del} lines in ${plural(Number(f[1]), "file")}`;
}

/** The most useful error line from a command's output, redacted; or "exited with code N". */
export function failureReason(output, exitCode) {
  const lines = strip(output).split("\n").map((l) => l.trim()).filter(Boolean);
  const bad = /\b(error|fatal|failed|failure|rejected|denied|not found|invalid|unauthori[sz]ed|forbidden|cannot|unable|refused|conflict|exception)\b|ERR!/i;
  const l = [...lines].reverse().find((x) => bad.test(x)) ?? lines[lines.length - 1];
  if (l) return firstLine(redact(l), 200);
  return typeof exitCode === "number" && exitCode !== 0 ? `exited with code ${exitCode}` : null;
}

/** { repo, branch } via the context's git runner (repo = main checkout's folder, also from a worktree). */
function repoInfo(c) {
  try {
    const common = path.resolve(c.dir, c.git(["rev-parse", "--git-common-dir"]));
    const repo = path.basename(common) === ".git" ? path.basename(path.dirname(common)) : path.basename(common).replace(/\.git$/, "");
    let branch = "";
    try {
      branch = c.git(["rev-parse", "--abbrev-ref", "HEAD"]);
    } catch {}
    return repo ? { repo, branch: branch === "HEAD" ? "" : branch } : null;
  } catch {
    return null;
  }
}

const tryGit = (c, args) => {
  try {
    return c.git(args);
  } catch {
    return null;
  }
};

/** "Commits:" bullet list (max 10). */
function commitLines(subjects, count) {
  if (!subjects.length) return [];
  const out = ["Commits:", ...subjects.slice(0, 10).map((s) => `- ${firstLine(redact(s), 120)}`)];
  if (count > 10) out.push(`- …and ${count - 10} more`);
  return out;
}

function describePush(c) {
  const w = words(c.segment);
  const args = w.slice(w.indexOf("push") + 1);
  const pos = positionals(w, "push", ["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);
  const out = strip(c.output);
  const g = repoInfo(c);
  let remote = pos[0] ?? null;
  let branch = pushedBranch(c.segment) ?? (pos[1]?.startsWith(":") ? pos[1].slice(1) : null);
  if (!remote || !branch) {
    const up = tryGit(c, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const m = up && /^([^/]+)\/(.+)$/.exec(up);
    remote = remote ?? m?.[1] ?? "origin";
    branch = branch ?? m?.[2] ?? g?.branch ?? null;
  }
  const repo = g?.repo ?? (c.dir ? path.basename(c.dir) : null);
  const where = repo ? (branch ? `${repo}/${branch}` : repo) : branch ? `${remote}/${branch}` : null;
  if (!where) return null;

  const rejected = /\[(remote )?rejected\]|error: failed to push/.test(out);
  if (c.failed || rejected) {
    const r = /\[(?:remote )?rejected\][^\n]*\(([^)]+)\)/.exec(out);
    const reason = r ? `rejected (${r[1]})` : failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Push to ${where} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  if (has(args, ["-d", "--delete"]) || pos[1]?.startsWith(":")) {
    return { title: `Deleted branch ${branch} from ${remote}${repo ? ` (${repo})` : ""}`, lines: [] };
  }

  let force = has(args, ["-f", "--force", "--force-with-lease", "--force-if-includes"]) || pos.slice(1).some((p) => p.startsWith("+")) || /\(forced update\)/.test(out);
  let oldRev = null;
  let newRev = null;
  let isNew = /\[new branch\]/.test(out);
  // 1. The push output: "   abc1234..def5678  main -> main" (or "+ abc...def main -> main (forced update)").
  const ranges = [...out.matchAll(/^\s*[+ ]?\s*([0-9a-f]{7,40})(\.\.\.?)([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/gm)];
  const hit = ranges.find((m) => m[5] === branch || m[5].endsWith(`/${branch}`)) ?? ranges[0];
  if (hit) {
    [oldRev, newRev] = [hit[1], hit[3]];
    if (hit[2] === "...") force = true;
  }
  // 2. Else the remote-tracking ref's reflog, if this push just moved it.
  if (!newRev && !isNew && branch && /^[\w.-]+$/.test(remote) && !/Everything up-to-date/.test(out)) {
    const log = tryGit(c, ["log", "-g", "-n", "2", "--date=unix", "--format=%H %gd %gs", `refs/remotes/${remote}/${branch}`]);
    const rows = (log || "").split("\n").filter(Boolean).map((l) => /^([0-9a-f]+) \S*@\{(\d+)\} (.*)$/.exec(l)).filter(Boolean);
    if (rows[0] && rows[0][3].startsWith("update by push") && Math.abs(c.now / 1000 - Number(rows[0][2])) <= 300) {
      newRev = rows[0][1];
      oldRev = rows[1]?.[1] ?? null;
      isNew = !oldRev;
    }
  }
  const tags = [...out.matchAll(/\[new tag\]\s+(\S+)/g)].map((m) => m[1]);
  if (!newRev && !isNew) {
    if (/Everything up-to-date/.test(out)) return { title: `Pushed to ${where}: already up to date`, lines: ["Nothing new to push; the remote already had these commits."] };
    if (tags.length) return { title: `Pushed ${tags.length === 1 ? "tag" : "tags"} ${tags.slice(0, 3).join(", ")} to ${repo ?? remote}`, lines: [] };
    // No range: name the latest commit on the branch (the previous behaviour).
    const subject = tryGit(c, ["log", "-1", "--format=%s", branch && g?.branch !== branch ? branch : "HEAD"]);
    return subject ? { title: `Pushed to ${where}: ${subject}`, lines: [] } : null;
  }

  let subjects = [];
  let count = 0;
  let stat = null;
  if (newRev && oldRev) {
    subjects = (tryGit(c, ["log", "--format=%s", "-n", "11", `${oldRev}..${newRev}`]) || "").split("\n").filter(Boolean);
    count = Number(tryGit(c, ["rev-list", "--count", `${oldRev}..${newRev}`]) ?? subjects.length);
    stat = statLine(tryGit(c, ["diff", "--shortstat", oldRev, newRev]));
    // Not an ancestor means history was rewritten; only trust that when the range itself was readable.
    if (!force && subjects.length && tryGit(c, ["merge-base", "--is-ancestor", oldRev, newRev]) === null) force = true;
  } else if (isNew) {
    const tip = newRev ?? branch;
    const not = ["--not", `--exclude=refs/remotes/${remote}/${branch}`, `--remotes=${remote}`];
    subjects = (tryGit(c, ["log", "--format=%s", "-n", "11", tip, ...not]) || "").split("\n").filter(Boolean);
    count = Number(tryGit(c, ["rev-list", "--count", tip, ...not]) ?? subjects.length);
  }
  const newest = subjects[0] ?? tryGit(c, ["log", "-1", "--format=%s", newRev ?? branch]) ?? "";
  const verb = force ? "Force-pushed" : "Pushed";
  let title;
  if (isNew) title = `${verb} new branch ${where}${count ? ` (${plural(count, "commit")})` : ""}`;
  else if (count === 1) title = `${verb} to ${where}`;
  else if (count > 1) title = `${verb} ${count} commits to ${where}`;
  else title = `${verb} to ${where}`;
  if (newest) title += `: ${newest}`;
  const lines = [...commitLines(subjects, count)];
  if (stat) lines.push(stat);
  if (force) lines.push(`Force push: the remote branch was rewritten${oldRev && newRev ? ` (was ${oldRev.slice(0, 7)}, now ${newRev.slice(0, 7)})` : ""}.`);
  else if (oldRev && newRev) lines.push(`Range: ${oldRev.slice(0, 7)}..${newRev.slice(0, 7)}`);
  if (tags.length) lines.push(`Tags: ${tags.join(", ")}`);
  return { title, lines };
}

function describeCommit(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const g = repoInfo(c);
  const repo = g?.repo ?? (c.dir ? path.basename(c.dir) : null);
  const m = /^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$/m.exec(out);
  const branch = m?.[1] && m[1] !== "detached" ? m[1] : g?.branch;
  const where = repo ? (branch ? `${repo}/${branch}` : repo) : null;
  if (!where) return null;
  if (c.failed) {
    const reason = /nothing (added )?to commit|no changes added to commit/.test(out) ? "nothing to commit" : failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Commit to ${where} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const head = tryGit(c, ["log", "-1", "--format=%H%x09%s", m?.[2] ?? "HEAD"]);
  const [hash, subject] = head ? [head.split("\t")[0], head.split("\t").slice(1).join("\t")] : [m?.[2], m?.[3]];
  if (!subject) return null;
  const lines = [];
  const stat = hash && statLine(tryGit(c, ["show", "--shortstat", "--format=", hash]));
  if (stat) lines.push(stat);
  const files = hash ? (tryGit(c, ["show", "--name-only", "--format=", hash]) || "").split("\n").filter(Boolean) : [];
  if (files.length) lines.push(`Files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? ` (+${files.length - 10} more)` : ""}`);
  if (hash) lines.push(`Commit: ${hash.slice(0, 7)}`);
  return { title: `${has(w, ["--amend"]) ? "Amended the last commit on" : "Committed to"} ${where}: ${subject}`, lines };
}

const GH_REPO = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|releases\/tag)\/(\S+)/;

function ghRepo(c, w) {
  const r = opt(w, ["-R", "--repo"]);
  if (r) return r.split("/").pop();
  return repoInfo(c)?.repo ?? (c.dir ? path.basename(c.dir) : null);
}

function describePrCreate(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const u = GH_REPO.exec(out);
  const repo = u?.[2] ?? ghRepo(c, w);
  const t = opt(w, ["-t", "--title"]);
  const draft = has(w, ["-d", "--draft"]) ? "draft " : "";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Opening a pull request in ${repo} failed${reason ? `: ${reason}` : ""}`, lines: u ? [`Existing PR: ${u[0]}`] : [] };
  }
  const what = u ? `${draft}PR #${u[4]}` : `a ${draft}pull request`;
  const title = `Opened ${what}${repo ? ` in ${repo}` : ""}${t ? `: ${t}` : ""}`;
  const lines = [];
  if (u) lines.push(`URL: ${u[0]}`);
  const base = opt(w, ["-B", "--base"]);
  const head = opt(w, ["-H", "--head"]) ?? repoInfo(c)?.branch;
  if (head || base) lines.push(`Branch: ${head ?? "?"} → ${base ?? "default branch"}`);
  return { title, lines };
}

function describePrMerge(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const pos = positionals(w, "merge", ["-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"]);
  const arg = pos[0] ?? "";
  const num = /^\d+$/.test(arg) ? arg : /\/pull\/(\d+)/.exec(arg)?.[1] ?? null;
  const m = /(Squashed and merged|Rebased and merged|Merged) pull request (?:([\w.-]+)\/([\w.-]+))?#(\d+) \((.+)\)/.exec(out);
  const repo = m?.[3] ?? /github\.com\/[\w.-]+\/([\w.-]+)\/pull/.exec(arg)?.[1] ?? ghRepo(c, w);
  const n = m?.[4] ?? num;
  const pr = n ? `PR #${n}` : arg && !arg.startsWith("http") ? `the PR for ${arg}` : "a pull request";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Merging ${pr}${repo ? ` in ${repo}` : ""} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const how = has(w, ["-s", "--squash"]) ? "squash" : has(w, ["-r", "--rebase"]) ? "rebase" : has(w, ["-m", "--merge"]) ? "merge commit" : null;
  const lines = [];
  if (how) lines.push(`Method: ${how}`);
  if (has(w, ["-d", "--delete-branch"])) lines.push("Deleted the branch after merging.");
  if (has(w, ["--auto"]) && !m) return { title: `Turned on auto-merge for ${pr}${repo ? ` in ${repo}` : ""}`, lines };
  return { title: `Merged ${pr}${repo ? ` in ${repo}` : ""}${m?.[5] ? `: ${m[5]}` : ""}`, lines };
}

function describeRelease(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const tag = positionals(w, "create", ["-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "-R", "--repo", "--discussion-category", "--notes-start-tag"])[0];
  if (!tag) return null;
  const u = GH_REPO.exec(out);
  const repo = u?.[2] ?? ghRepo(c, w);
  const t = opt(w, ["-t", "--title"]);
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Creating GitHub release ${tag}${repo ? ` in ${repo}` : ""} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const kind = has(w, ["-d", "--draft"]) ? "draft GitHub release" : has(w, ["-p", "--prerelease"]) ? "GitHub pre-release" : "GitHub release";
  const lines = u ? [`URL: ${u[0]}`] : [];
  return { title: `Created ${kind} ${tag}${repo ? ` in ${repo}` : ""}${t && t !== tag ? `: ${t}` : ""}`, lines };
}

/** Folder a CLI acts on: its --cwd flag (relative to the command's dir) or the command's dir. */
const cliDir = (c, w, names = ["--cwd"]) => {
  const d = opt(w, names);
  return d && c.dir ? path.resolve(c.dir, d) : c.dir;
};

function vercelProject(c, w) {
  const d = cliDir(c, w);
  const p = d ? jsonOf(c.readFile(path.join(d, ".vercel", "project.json"))) : null;
  return opt(w, ["--project"]) ?? p?.projectName ?? (d ? path.basename(d) : null);
}

function describeVercel(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const sub = ["deploy", "redeploy", "promote", "rollback"].find((s) => w.includes(s)) ?? "deploy";
  const project = vercelProject(c, w);
  const target = sub === "promote" ? "production" : has(w, ["--prod"]) ? "production" : opt(w, ["--target"]) ?? "preview";
  // Text output ("Production: https://…"), or the JSON agents get ("url": "x.vercel.app", "aliases": [...]).
  const bare = /\b([\w-]+\.vercel\.app)\b/.exec(out)?.[1];
  const deployed = /(?:^|\s)(Production|Preview):\s*(https:\/\/\S+)/m.exec(out)?.[2] ?? /https:\/\/[\w.-]+\.vercel\.app/.exec(out)?.[0] ?? (bare ? `https://${bare}` : null);
  const jsonAlias = /"alias(?:es)?"\s*:\s*\[?\s*"(?:https:\/\/)?([^"]+)"/.exec(out)?.[1];
  const alias = /Aliased:\s*(https:\/\/\S+)/.exec(out)?.[1] ?? (jsonAlias ? `https://${jsonAlias}` : null);
  const inspect = /Inspect:\s*(https:\/\/\S+)/.exec(out)?.[1] ?? null;
  const on = project ? ` ${project}` : "";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    const what = sub === "promote" ? `Promoting a deployment of${on || " the project"} to production` : `Vercel ${target} deploy of${on || " the project"}`;
    return { failed: true, reason, title: `${what} failed${reason ? `: ${reason}` : ""}`, lines: inspect ? [`Inspect: ${inspect}`] : [] };
  }
  const host = (u) => u && u.replace(/^https:\/\//, "").replace(/\/$/, "");
  const lines = [];
  if (deployed) lines.push(`Deployment: ${deployed}`);
  if (alias) lines.push(`Live at: ${alias}`);
  if (inspect) lines.push(`Inspect: ${inspect}`);
  if (has(w, ["--prebuilt"])) lines.push("Deployed a prebuilt output.");
  let title;
  if (sub === "promote") {
    const arg = positionals(w, "promote", ["--scope", "--token", "-t", "--timeout"])[0];
    title = `Promoted ${arg ? host(arg.startsWith("http") ? arg : arg) : "a deployment"} to production${on ? ` for${on}` : ""} on Vercel`;
  } else if (sub === "rollback") title = `Rolled back${on || " the project"} on Vercel`;
  else if (sub === "redeploy") title = `Redeployed${on || " the project"} on Vercel (${target})`;
  else title = `Deployed${on || " the project"} to ${target} on Vercel${alias || deployed ? ` (${host(alias ?? deployed)})` : ""}`;
  return { title, lines };
}

function describeVercelEnv(c) {
  const w = words(c.segment);
  const i = w.indexOf("env");
  const act = w[i + 1];
  const pos = positionals(w.slice(i + 1), act, ["--scope", "--token", "-t", "--cwd"]);
  const name = pos[0];
  const env = pos[1] ?? null;
  if (!name) return null;
  const project = vercelProject(c, w);
  const verb = act === "add" ? "Added" : act === "update" ? "Updated" : "Removed";
  const prep = act === "add" ? "to" : act === "update" ? "in" : "from";
  const scope = env ? `${prep} ${env}` : `${prep} ${act === "add" ? "the chosen environments" : "all environments"}`;
  if (c.failed) {
    const reason = failureReason(c.output, c.exitCode);
    return { failed: true, reason, title: `${act === "add" ? "Adding" : act === "update" ? "Updating" : "Removing"} Vercel env var ${name} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  return { title: `${verb} Vercel env var ${name} ${scope}${project ? ` (${project})` : ""}`, lines: ["The value is never recorded."] };
}

function describeRailway(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const cfg = jsonOf(c.readFile(path.join(c.home || "/", ".railway", "config.json")));
  let link = null;
  if (cfg?.projects && c.dir) {
    const keys = Object.keys(cfg.projects).filter((k) => c.dir === k || c.dir.startsWith(k.endsWith("/") ? k : k + "/")).sort((a, b) => b.length - a.length);
    link = keys[0] ? cfg.projects[keys[0]] : null;
  }
  const service = opt(w, ["-s", "--service"]);
  const env = opt(w, ["-e", "--environment"]) ?? link?.environmentName ?? null;
  const name = service ?? link?.name ?? (c.dir ? path.basename(c.dir) : "the project");
  const inEnv = env ? ` (${env})` : "";
  const isVars = /\bvariables?\b/.test(c.segment);
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `${isVars ? "Setting Railway variables on" : "Railway deploy of"} ${name} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  if (isVars) {
    const keys = w.flatMap((x, j) => ((w[j - 1] === "--set" || w[j - 1] === "set") && x.includes("=") ? [x.split("=")[0]] : []));
    return { title: `Set Railway ${keys.length === 1 ? "variable" : "variables"} ${keys.join(", ") || ""} on ${name}${inEnv}`.replace(/  +/g, " "), lines: ["Values are never recorded."] };
  }
  const logs = /https:\/\/railway\.(?:com|app)\/project\/\S+/.exec(out)?.[0];
  const lines = [];
  if (link?.name && service) lines.push(`Project: ${link.name}`);
  if (logs) lines.push(`Build logs: ${logs}`);
  return { title: `Deployed ${name} to Railway${inEnv}`, lines };
}

function describeFly(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const conf = opt(w, ["-c", "--config"]);
  const toml = c.dir ? c.readFile(path.resolve(c.dir, conf ?? "fly.toml")) : null;
  const app = opt(w, ["-a", "--app"]) ?? /^\s*app\s*=\s*["']([^"']+)["']/m.exec(toml || "")?.[1] ?? (c.dir ? path.basename(c.dir) : "the app");
  const secrets = w.includes("secrets");
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `${secrets ? "Setting Fly.io secrets on" : "Fly.io deploy of"} ${app} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  if (secrets) {
    const keys = positionals(w, "set", ["-a", "--app", "-c", "--config"]).filter((x) => x.includes("=")).map((x) => x.split("=")[0]);
    return { title: `Set Fly.io ${keys.length === 1 ? "secret" : "secrets"} ${keys.join(", ")} on ${app}`, lines: ["Values are never recorded."] };
  }
  const url = /https:\/\/[\w.-]+\.fly\.dev\S*/.exec(out)?.[0];
  return { title: `Deployed ${app} to Fly.io`, lines: url ? [`URL: ${url}`] : [] };
}

function describeWrangler(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const conf = opt(w, ["-c", "--config"]);
  let name = opt(w, ["--name"]);
  if (!name && c.dir) {
    for (const f of conf ? [conf] : ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
      const text = c.readFile(path.resolve(c.dir, f));
      if (!text) continue;
      name = (f.endsWith(".toml") ? /^\s*name\s*=\s*["']([^"']+)["']/m : /"name"\s*:\s*"([^"]+)"/).exec(text)?.[1] ?? null;
      if (name) break;
    }
  }
  name = name ?? (c.dir ? path.basename(c.dir) : "the worker");
  const env = opt(w, ["-e", "--env"]);
  const inEnv = env ? ` (${env})` : "";
  const secret = w.includes("secret");
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `${secret ? "Setting a secret on" : "Deploying"} Cloudflare Worker ${name} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  if (secret) {
    const key = positionals(w, "put", ["-c", "--config", "-e", "--env", "--name"])[0];
    return { title: `Set Cloudflare Worker secret ${key ?? ""} on ${name}${inEnv}`.replace(/  +/g, " "), lines: ["The value is never recorded."] };
  }
  const lines = [];
  const url = /https:\/\/[\w.-]+\.workers\.dev\S*/.exec(out)?.[0];
  const version = /Current Version ID:\s*(\S+)/.exec(out)?.[1];
  if (url) lines.push(`URL: ${url}`);
  if (version) lines.push(`Version: ${version}`);
  return { title: `Deployed Cloudflare Worker ${name}${inEnv}`, lines };
}

function describeNetlify(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const site = opt(w, ["--site", "-s"]);
  const name = c.dir ? path.basename(cliDir(c, w)) : site ?? "the site";
  const target = has(w, ["--prod", "-p"]) ? "production" : "a draft URL";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Netlify deploy of ${name} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const live = /Website (?:draft )?URL:\s*(https:\/\/\S+)/.exec(out)?.[1];
  const unique = /Unique deploy URL:\s*(https:\/\/\S+)/.exec(out)?.[1];
  const lines = [];
  if (live) lines.push(`URL: ${live}`);
  if (unique) lines.push(`Deploy: ${unique}`);
  return { title: `Deployed ${name} to ${target} on Netlify`, lines };
}

function describeKubectl(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const i = w.indexOf("kubectl");
  const verb = w[i + 1];
  const ns = opt(w, ["-n", "--namespace"]);
  const ctx = opt(w, ["--context"]);
  const file = opt(w, ["-f", "--filename"]);
  const pos = positionals(w, verb, ["-n", "--namespace", "--context", "-f", "--filename", "-l", "--selector", "-o", "--output", "--replicas", "-c", "--container"]);
  const what = file ?? pos.join(" ");
  const where = `${ns ? ` in namespace ${ns}` : ""}${ctx ? ` (${ctx})` : ""}`;
  const Verb = { apply: "Applied", delete: "Deleted", scale: "Scaled", set: "Updated", rollout: "Ran rollout" }[verb] ?? "Changed";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `kubectl ${verb} ${what} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const replicas = opt(w, ["--replicas"]);
  const changed = strip(out).split("\n").filter((l) => /\b(created|configured|deleted|scaled|restarted|rolled back|image updated)\b/.test(l)).map((l) => l.trim());
  const lines = changed.length ? ["Changed:", ...changed.slice(0, 10).map((l) => `- ${l}`)] : [];
  return { title: `${Verb} ${what}${replicas ? ` to ${replicas} replicas` : ""} on Kubernetes${where}`.replace(/  +/g, " "), lines };
}

function describeTerraform(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const tool = w.find((x) => x === "terraform" || x === "tofu") ?? "terraform";
  const destroy = w.includes("destroy");
  const chdir = w.find((x) => x.startsWith("-chdir="))?.slice(7);
  const name = c.dir ? path.basename(chdir ? path.resolve(c.dir, chdir) : c.dir) : null;
  const res = /(Apply|Destroy) complete! Resources: ([^.]+)\./.exec(out)?.[2];
  const Tool = tool === "tofu" ? "OpenTofu" : "Terraform";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `${Tool} ${destroy ? "destroy" : "apply"}${name ? ` in ${name}` : ""} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  return { title: `${destroy ? "Destroyed" : "Applied"} ${Tool} infrastructure${name ? ` in ${name}` : ""}${res ? `: ${res}` : ""}`, lines: [] };
}

function describeDocker(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const image = w.includes("buildx") ? opt(w, ["-t", "--tag"]) : positionals(w, "push", ["--platform"])[0];
  if (!image) return null;
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Pushing Docker image ${image} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const digest = /digest: (sha256:[0-9a-f]{12})/.exec(out)?.[1];
  return { title: `${w.includes("buildx") ? "Built and pushed" : "Pushed"} Docker image ${image}`, lines: digest ? [`Digest: ${digest}…`] : [] };
}

function describePublish(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const pm = w.find((x) => ["npm", "pnpm", "yarn", "bun"].includes(x)) ?? "npm";
  const dirArg = positionals(w, "publish", ["--tag", "--access", "--otp", "--registry", "--filter", "-F"]).find((x) => x.startsWith(".") || x.startsWith("/"));
  const pkgDir = c.dir ? (dirArg ? path.resolve(c.dir, dirArg) : c.dir) : null;
  const pkg = pkgDir ? jsonOf(c.readFile(path.join(pkgDir, "package.json"))) : null;
  const fromOut = /^\+ (\S+@\S+)$/m.exec(out)?.[1];
  const id = fromOut ?? (pkg?.name ? `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}` : null);
  const tag = opt(w, ["--tag"]);
  const dry = has(w, ["--dry-run"]);
  const what = id ?? (pkgDir ? path.basename(pkgDir) : "a package");
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Publishing ${what} to npm failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const lines = [];
  if (tag) lines.push(`Dist-tag: ${tag}`);
  const access = opt(w, ["--access"]);
  if (access) lines.push(`Access: ${access}`);
  if (pm !== "npm") lines.push(`Published with ${pm}.`);
  return { title: dry ? `Dry-ran publishing ${what} (nothing was published)` : `Published ${what} to npm${tag && tag !== "latest" ? ` (${tag})` : ""}`, lines };
}

/** App name, bundle id and versions from app.json / app.config.* in dir. */
function expoApp(c, dir) {
  const j = jsonOf(c.readFile(path.join(dir, "app.json")));
  const e = j?.expo ?? j;
  if (e && (e.name || e.slug)) {
    return { name: e.name ?? e.slug, ios: e.ios?.bundleIdentifier, android: e.android?.package, version: e.version, build: e.ios?.buildNumber, code: e.android?.versionCode };
  }
  for (const f of ["app.config.ts", "app.config.js"]) {
    const t = c.readFile(path.join(dir, f));
    if (!t) continue;
    const g = (k) => new RegExp(`\\b${k}:\\s*["'\`]([^"'\`]+)["'\`]`).exec(t)?.[1];
    return { name: g("name") ?? g("slug"), ios: g("bundleIdentifier"), android: g("package"), version: g("version") };
  }
  return null;
}

const PLATFORM = { ios: "iOS", android: "Android", all: "iOS and Android" };

function describeEas(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const sub = ["build", "submit", "update"].find((s) => w.includes(s));
  const app = c.dir ? expoApp(c, c.dir) : null;
  const name = app?.name ?? (c.dir ? path.basename(c.dir) : "the app");
  const p = opt(w, ["-p", "--platform"]);
  const plat = p ? PLATFORM[p] ?? p : null;
  const profile = opt(w, ["-e", "--profile"]);
  const lines = [];
  const ids = [app?.ios && p !== "android" ? `iOS ${app.ios}` : null, app?.android && p !== "ios" ? `Android ${app.android}` : null].filter(Boolean);
  if (ids.length) lines.push(`App: ${ids.join(", ")}`);
  const ver = /Version:\s*(\S+)/.exec(out)?.[1] ?? app?.version;
  const build = /Build number:\s*(\S+)/.exec(out)?.[1] ?? /Version code:\s*(\S+)/.exec(out)?.[1] ?? app?.build ?? app?.code;
  if (ver || build) lines.push(`Version ${ver ?? "?"}${build ? ` (build ${build})` : ""}`);
  if (profile) lines.push(`Profile: ${profile}`);
  const url = /https:\/\/expo\.dev\/\S+/.exec(out)?.[0];
  if (url) lines.push(`EAS: ${url}`);
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `EAS ${sub}${plat ? ` (${plat})` : ""} for ${name} failed${reason ? `: ${reason}` : ""}`, lines };
  }
  if (sub === "update") {
    const branch = opt(w, ["--branch"]) ?? opt(w, ["--channel"]);
    const msg = opt(w, ["-m", "--message"]);
    return { title: `Published an EAS update for ${name}${branch ? ` to ${branch}` : ""}${msg ? `: ${msg}` : ""}`, lines };
  }
  if (sub === "submit") {
    const store = p === "android" ? "Google Play" : p === "ios" ? "App Store Connect" : "the app stores";
    return { title: `Submitted ${name}${plat ? ` ${plat}` : ""} build to ${store} with EAS`, lines };
  }
  const done = /Build finished|✔ Build/.test(out);
  const verb = done ? "Built" : has(w, ["--no-wait"]) || out ? "Started" : "Ran";
  return { title: `${verb} ${plat ? `${plat} ` : ""}${profile ? `${profile} ` : ""}build of ${name} on EAS`, lines };
}

function describeAppUpload(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  if (w.includes("altool")) {
    const file = opt(w, ["-f", "--file"]);
    const name = file ? path.basename(file) : "an app build";
    if (c.failed || /UPLOAD FAILED|ERROR ITMS/.test(out)) {
      const reason = failureReason(out, c.exitCode);
      return { failed: true, reason, title: `Uploading ${name} to App Store Connect failed${reason ? `: ${reason}` : ""}`, lines: [] };
    }
    return { title: `Uploaded ${name} to App Store Connect`, lines: [] };
  }
  const i = w.indexOf("fastlane");
  const lane = w.slice(i + 1).filter((x) => !x.includes(":") && !x.startsWith("-")).join(" ");
  const appfile = c.dir ? c.readFile(path.join(c.dir, "fastlane", "Appfile")) : null;
  const appId = /app_identifier\s*\(?\s*["']([^"']+)["']/.exec(appfile || "")?.[1];
  const xcode = c.dir ? c.listDir(c.dir).find((f) => f.endsWith(".xcodeproj"))?.replace(/\.xcodeproj$/, "") : null;
  const name = xcode ?? appId ?? (c.dir ? path.basename(c.dir) : "the app");
  const dest = /\bpilot\b|upload_to_testflight/.test(lane) ? "TestFlight" : /\bdeliver\b|upload_to_app_store/.test(lane) ? "the App Store" : null;
  const lines = appId ? [`Bundle ID: ${appId}`] : [];
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `fastlane ${lane} for ${name} failed${reason ? `: ${reason}` : ""}`, lines };
  }
  return { title: dest ? `Uploaded ${name} to ${dest} with fastlane` : `Ran fastlane ${lane} for ${name}`, lines };
}

const PAST = { create: "Created", update: "Updated", delete: "Deleted", cancel: "Cancelled" };
const singular = (r) => r.replace(/_/g, " ").replace(/ies$/, "y").replace(/s$/, "");

function describeStripeCli(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const i = w.indexOf("stripe");
  const [res, verb] = [w[i + 1], w[i + 2]];
  const id = w[i + 3] && !w[i + 3].startsWith("-") ? w[i + 3] : null;
  const label = opt(w, ["--name"]) ?? /^name=(.+)$/.exec(opt(w, ["-d"]) ?? "")?.[1] ?? null;
  const what = `Stripe ${singular(res)}`;
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Couldn't ${verb} ${what}${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const newId = /"id":\s*"([a-z]+_[A-Za-z0-9]+)"/.exec(out)?.[1];
  const lines = [];
  if (newId || id) lines.push(`ID: ${newId ?? id}`);
  if (has(w, ["--live"])) lines.push("Live mode.");
  return { title: `${PAST[verb] ?? cap(verb)} ${verb === "create" ? `a ${what}` : what}${label ? `: ${label}` : id && verb !== "create" ? ` ${id}` : ""}`, lines };
}

function describeMigrate(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  let tool = /prisma/.test(c.segment) ? "Prisma" : /drizzle-kit/.test(c.segment) ? "Drizzle" : null;
  const script = /\bdb:(migrate|push)\b/.exec(c.segment)?.[0];
  if (!tool && script && c.dir) {
    const run = jsonOf(c.readFile(path.join(c.dir, "package.json")))?.scripts?.[script] ?? "";
    tool = /prisma/.test(run) ? "Prisma" : /drizzle/.test(run) ? "Drizzle" : /knex/.test(run) ? "Knex" : /sequelize/.test(run) ? "Sequelize" : null;
  }
  const push = /drizzle-kit\s+push|db:push/.test(c.segment);
  const name = c.dir ? path.basename(c.dir) : "the project";
  const T = tool ? `${tool} ` : "";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `${T}${push ? "schema push" : "migrations"} for ${name} failed${reason ? `: ${reason}` : ""}`.replace(/^./, (x) => x.toUpperCase()), lines: [] };
  }
  if (push) return { title: `Pushed the ${T}database schema for ${name}`.replace("  ", " "), lines: [] };
  const names = [...new Set([...out.matchAll(/\b(\d{4,}_[A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
  const none = /No pending migrations|No migrations to apply|already up to date/i.test(out);
  const tail = names.length ? `: applied ${plural(names.length, "migration")}` : none ? ": nothing to apply" : "";
  const lines = names.length ? ["Migrations:", ...names.slice(0, 10).map((n) => `- ${n}`)] : [];
  return { title: `Ran ${T}migrations on ${name}${tail}`, lines };
}

function describePsql(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const sql = opt(w, ["-c", "--command"]) ?? c.segment;
  const re = /\b(insert\s+into|update|delete\s+from|drop\s+table(?:\s+if\s+exists)?|alter\s+table|truncate(?:\s+table)?|create\s+table(?:\s+if\s+not\s+exists)?)\s+("?[\w.]+"?)/gi;
  const stmts = [...sql.matchAll(re)]
    .map((m) => ({ kind: m[1].toLowerCase().split(/\s+/).slice(0, 2).join(" "), table: m[2].replace(/"/g, "") }))
    .filter((s) => s.kind !== "update" || new RegExp(`update\\s+"?${s.table.replace(/[.]/g, "\\.")}"?\\s+set\\b`, "i").test(sql));
  if (!stmts.length) return null;
  const db = opt(w, ["-d", "--dbname"]) ?? /postgres(?:ql)?:\/\/[^\s'"]*\/([\w-]+)/.exec(c.segment)?.[1] ?? null;
  const on = db ? ` on ${db}` : "";
  if (c.failed) {
    const reason = failureReason(out, c.exitCode);
    return { failed: true, reason, title: `psql ${stmts[0].kind.toUpperCase()} on ${stmts[0].table} failed${reason ? `: ${reason}` : ""}`, lines: [] };
  }
  const counts = [...out.matchAll(/^(INSERT \d+|UPDATE|DELETE) (\d+)$/gm)].map((m) => Number(m[2]));
  if (stmts.length === 1) {
    const { kind, table } = stmts[0];
    const n = counts[0];
    const rows = n != null ? plural(n, "row") : "rows";
    const t = {
      "insert into": `Inserted ${rows} into ${table}`,
      update: `Updated ${rows} in ${table}`,
      "delete from": `Deleted ${rows} from ${table}`,
      "drop table": `Dropped table ${table}`,
      "alter table": `Altered table ${table}`,
      truncate: `Truncated ${table}`,
      "truncate table": `Truncated ${table}`,
      "create table": `Created table ${table}`,
    }[kind];
    return { title: `${t} with psql${on}`, lines: [] };
  }
  const list = stmts.map((s) => `${s.kind.split(" ")[0].toUpperCase()} ${s.table}`);
  return { title: `Ran ${stmts.length} write statements with psql${on}: ${list.slice(0, 4).join(", ")}`, lines: ["Statements:", ...list.slice(0, 10).map((l) => `- ${l}`)] };
}

/** Body of a curl request (inline or @file), for counting and key names only. */
function curlBody(c, w) {
  const d = opt(w, ["-d", "--data", "--data-raw", "--data-binary", "--json"]);
  if (!d) return null;
  if (d.startsWith("@") && d !== "@-") return c.dir ? c.readFile(path.resolve(c.dir, d.slice(1))) : null;
  return d;
}

const tokenish = (s) => s.length >= 20 && /\d/.test(s) && /[A-Za-z]/.test(s);

function describeCurl(c) {
  const w = words(c.segment);
  const out = strip(c.output);
  const method = (opt(w, ["-X", "--request"]) ?? "POST").toUpperCase();
  const raw = opt(w, ["--url"]) ?? w.find((x) => /^https?:\/\//.test(x));
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname;
  const p = u.pathname.split("/").map((s) => (tokenish(s) ? "…" : s)).join("/");
  const body = curlBody(c, w);
  const json = jsonOf(body);
  const lines = [];
  const code = /(?:^|\n)\s*(?:HTTP\/[\d.]+ )?([1-5]\d\d)\s*$/.exec(out)?.[1];
  const httpFailed = code && Number(code) >= 400;
  let title;
  if (/indexnow/.test(host) || /\/indexnow\b/.test(u.pathname)) {
    const urls = Array.isArray(json?.urlList) ? json.urlList.length : (String(body ?? "").match(/https?:\/\//g) || []).length;
    const site = json?.host ?? null;
    title = `Submitted ${plural(urls, "URL")} to IndexNow${site ? ` for ${site}` : ""}`;
  } else if (host === "hooks.slack.com" || (host === "slack.com" && /chat\.postMessage/.test(u.pathname))) {
    title = `Posted to Slack${json?.channel ? ` in ${json.channel}` : ""}${typeof json?.text === "string" ? `: ${firstLine(json.text, 60)}` : ""}`;
  } else if (/(^|\.)discord(app)?\.com$/.test(host) && /\/webhooks\//.test(u.pathname)) {
    title = `Posted to Discord${typeof json?.content === "string" ? `: ${firstLine(json.content, 60)}` : ""}`;
  } else if (host === "api.telegram.org") {
    title = "Sent a Telegram message";
  } else if (host === "api.resend.com" && /\/emails/.test(u.pathname)) {
    const to = [].concat(json?.to ?? []).filter((x) => typeof x === "string");
    if (to.length) lines.push(`To ${plural(to.length, "recipient")} at ${plural(new Set(to.map((x) => x.split("@").pop().toLowerCase())).size, "domain")}`);
    title = `Sent an email via Resend${typeof json?.subject === "string" ? `: ${json.subject}` : ""}`;
  } else if (host === "api.stripe.com") {
    const [, , res, id] = u.pathname.split("/");
    const what = res ? `Stripe ${singular(res)}` : "Stripe";
    title = method === "DELETE" ? `Deleted ${what}${id ? ` ${id}` : ""}` : id ? `Updated ${what} ${id}` : `Created a ${what}`;
    if (u.pathname.split("/").length > 4) title = `Called the Stripe API: ${method} ${p}`;
  } else if (host === "api.github.com") {
    const m = /^\/repos\/([\w.-]+\/[\w.-]+)\/(issues|pulls|releases|dispatches|actions\/workflows\/[^/]+\/dispatches)(?:\/(\d+)\/comments)?$/.exec(u.pathname);
    const kind = m && (m[3] ? "Commented on #" + m[3] : { issues: "Opened a GitHub issue", pulls: "Opened a pull request", releases: "Created a GitHub release", dispatches: "Triggered a repository dispatch" }[m[2]] ?? "Triggered a GitHub workflow");
    title = m && method === "POST" ? `${kind} in ${m[1]}${typeof json?.title === "string" ? `: ${json.title}` : typeof json?.name === "string" ? `: ${json.name}` : ""}` : `Called the GitHub API: ${method} ${p}`;
  } else if (host === "api.vercel.com") {
    title = /\/deployments$/.test(u.pathname) && method === "POST" ? `Created a Vercel deployment${typeof json?.name === "string" ? ` of ${json.name}` : ""}` : `Called the Vercel API: ${method} ${p}`;
  } else {
    title = `Called ${method} ${host}${p === "/" ? "" : p}`;
  }
  lines.push(`Request: ${method} ${host}${host === "hooks.slack.com" || host === "api.telegram.org" || /\/webhooks\//.test(u.pathname) ? " (path hidden)" : p}`);
  if (json && typeof json === "object" && !Array.isArray(json)) lines.push(`Body fields: ${Object.keys(json).slice(0, 12).join(", ")}`);
  if (code) lines.push(`HTTP ${code}`);
  if (c.failed || httpFailed) {
    const reason = httpFailed ? `HTTP ${code}` : failureReason(out, c.exitCode);
    return { failed: true, reason, title: `Failed: ${title}`, lines };
  }
  return { title, lines };
}

function describeMail(c) {
  const w = words(c.segment);
  const subject = opt(w, ["-s", "--subject"]);
  const to = w.filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  const lines = to.length ? [`To ${plural(to.length, "recipient")} at ${plural(new Set(to.map((x) => x.split("@").pop().toLowerCase())).size, "domain")}`] : [];
  if (c.failed) {
    const reason = failureReason(c.output, c.exitCode);
    return { failed: true, reason, title: `Sending an email${subject ? ` "${subject}"` : ""} failed${reason ? `: ${reason}` : ""}`, lines };
  }
  return { title: subject ? `Sent an email: ${subject}` : to.length ? `Sent an email to ${plural(to.length, "recipient")}` : "Sent an email", lines };
}

const DESCRIBE = {
  "git-push": describePush,
  "git-commit": describeCommit,
  "gh-pr-create": describePrCreate,
  "gh-pr-merge": describePrMerge,
  "gh-release": describeRelease,
  "vercel-deploy": describeVercel,
  "vercel-env": describeVercelEnv,
  railway: describeRailway,
  fly: describeFly,
  wrangler: describeWrangler,
  netlify: describeNetlify,
  kubectl: describeKubectl,
  terraform: describeTerraform,
  "docker-push": describeDocker,
  "npm-publish": describePublish,
  eas: describeEas,
  "xcrun-altool": describeAppUpload,
  stripe: describeStripeCli,
  "db-migrate": describeMigrate,
  "psql-write": describePsql,
  "curl-write": describeCurl,
  "send-mail": describeMail,
};

/** The command as shown at the end of the details: redacted, with values that don't belong in a log masked. */
export function safeCommand(ruleId, cmd) {
  let s = redact(cmd);
  // Values piped or passed into env/secret commands.
  if (["vercel-env", "railway", "fly", "wrangler"].includes(ruleId)) {
    s = s.replace(/\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, "$1=[redacted]").replace(/(--value[= ])("[^"]*"|'[^']*'|\S+)/g, "$1[redacted]");
    s = s.replace(/\b(echo|printf)\s+("[^"]*"|'[^']*'|[^|;&]+?)(\s*\|)/g, "$1 [redacted]$3");
  }
  if (ruleId === "curl-write") {
    s = s.replace(/(\s(?:-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-H|--header|-u|--user)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/g, "$1…");
    s = s.replace(/(https?:\/\/[^\s"'?]+)\?[^\s"']*/g, "$1?…");
    s = s.replace(/(hooks\.slack\.com|api\.telegram\.org)\/[^\s"']*/g, "$1/…").replace(/(\/webhooks\/)[^\s"']*/g, "$1…");
  }
  if (ruleId === "psql-write") s = s.replace(/(\s(?:-c|--command)(?:\s+|=))("[^"]*"|'[^']*'|\S+)/g, '$1"…"');
  s = s.replace(/[^\s@"'<>,;]+@([\w-]+\.)+[\w-]+/g, (m) => (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(m) ? "[email]" : m));
  return firstLine(s, 1500);
}

/** The command with heredoc bodies (and, if quotes, quoted text) blanked out, keeping every index. */
export function maskQuoted(cmd, quotes = true) {
  let s = String(cmd).replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g, (m, q, tag, body, end) =>
    m.slice(0, m.length - body.length - end.length) + body.replace(/[^\n]/g, " ") + end,
  );
  if (!quotes) return s;
  let out = "";
  let q = null;
  for (const ch of s) {
    if (q) {
      if (ch === q) q = null;
      out += ch === q || q === null ? ch : " ";
    } else {
      if (ch === '"' || ch === "'") q = ch;
      out += ch;
    }
  }
  return out;
}

/** Shell separators (&&, ||, ;, |) outside quotes, as [index, length]. */
export function separators(cmd) {
  const out = [];
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (ch === ";") out.push([i, 1]);
    else if ((ch === "&" || ch === "|") && cmd[i + 1] === ch) out.push([i++, 2]);
    else if (ch === "|") out.push([i, 1]);
  }
  return out;
}

/** Public deployment hosts (long generated names like app-x7k2-team.vercel.app) aren't secrets. */
const PUBLIC_HOST = /\b[\w-]+\.(?:vercel\.app|netlify\.app|fly\.dev|workers\.dev|pages\.dev|up\.railway\.app)\b/g;

/** redact() that leaves public deployment hostnames alone. */
function redactText(s) {
  const keep = [];
  const masked = String(s).replace(PUBLIC_HOST, (m) => `\u0000${keep.push(m) - 1}\u0000`);
  return redact(masked).replace(/\u0000(\d+)\u0000/g, (_, i) => keep[Number(i)]);
}

/** redact(), but a URL keeps its shape: each path segment is checked on its own. */
export function redactKeepUrls(s) {
  return String(s)
    .split(/(https?:\/\/[^\s"'<>]+)/)
    .map((p, i) => (i % 2 ? p.replace(/^(https?:\/\/)[^\s:@/]+:[^\s@/]+@/, "$1[redacted]@").split("/").map(redactText).join("/") : redactText(p)))
    .join("");
}

const titleOf = (t) => firstLine(redactText(String(t)).replace(/`/g, ""), 120);

// ---------- MCP ----------

const MCP_PAST = {
  create: "created", update: "updated", delete: "deleted", remove: "removed", send: "sent", post: "posted", publish: "published",
  deploy: "deployed", merge: "merged", push: "pushed", submit: "submitted", cancel: "cancelled", refund: "refunded", charge: "charged",
  invite: "invited", set: "set", add: "added", upload: "uploaded", write: "wrote", reply: "replied to", comment: "commented on",
  approve: "approved", close: "closed", archive: "archived",
};
const BRANDS = { github: "GitHub", gitlab: "GitLab", hubspot: "HubSpot", openai: "OpenAI", posthog: "PostHog", youtube: "YouTube", linkedin: "LinkedIn", clickup: "ClickUp", gmail: "Gmail", mcp: "MCP" };
const ID_KEYS = ["title", "name", "subject", "summary", "label", "filename", "file_name", "path", "url", "slug", "channel", "repo", "repository", "branch", "tag", "email_subject"];
const TEXT_KEYS = ["text", "message", "content", "body", "description", "query"];
const maskEmails = (s) => String(s).replace(/[\w.+-]+@([\w-]+\.)+[a-z]{2,}/gi, "[email]");

export function serverName(server) {
  const s = String(server).replace(/^claude_ai_/i, "").replace(/^plugin_[^_]+_/i, "");
  return s.split(/[-_]+/).filter(Boolean).map((x) => BRANDS[x.toLowerCase()] ?? cap(x)).join(" ") || "MCP";
}

/** The most identifying short value in the arguments: title/name/subject/... (breadth-first, 3 levels). */
function identifyingArg(args) {
  let level = [args];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    for (const keys of [ID_KEYS, TEXT_KEYS]) {
      for (const k of keys) {
        for (const o of level) {
          const v = o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined;
          if ((typeof v === "string" && v.trim()) || typeof v === "number") return firstLine(maskEmails(redact(v)), 60);
        }
      }
      if (depth > 0) break; // text fields only from the top level
    }
    level = level.flatMap((o) => (o && typeof o === "object" ? (Array.isArray(o) ? o.slice(0, 3) : Object.values(o)) : [])).filter((o) => o && typeof o === "object");
  }
  return null;
}

function describeMcp(server, tool, args, c) {
  const S = serverName(server);
  const serverWords = new Set(String(server).toLowerCase().split(/[-_]+/));
  const parts = tool.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().split(/[_\-.\s]+/).filter((x) => x && !serverWords.has(x));
  const vi = parts.findIndex((x) => MCP_PAST[x]);
  const verb = parts[vi];
  const obj = (parts.slice(vi + 1).length ? parts.slice(vi + 1) : parts.slice(0, vi)).join(" ");
  const ident = identifyingArg(args);
  const lines = [];
  const scalars = Object.entries(args && typeof args === "object" ? args : {})
    .filter(([, v]) => ["string", "number", "boolean"].includes(typeof v))
    .map(([k, v]) => `${k}: ${firstLine(maskEmails(redact(v)), 80)}`);
  if (scalars.length) lines.push(`Arguments: ${firstLine(scalars.join("; "), 600)}`);
  const link = /https:\/\/[^\s"'\\)]+/.exec(strip(c.output))?.[0];
  if (link) lines.push(`Link: ${link}`);
  const failed = c.failed;
  const phrase = failed ? `couldn't ${verb ?? "run"} ${obj}`.trim() : `${MCP_PAST[verb] ?? "ran"} ${obj}`.trim();
  return { failed, reason: failed ? failureReason(c.output, c.exitCode) : null, title: `${S} → ${phrase}${ident ? `: ${ident}` : ""}`, lines };
}

/** Context for describers: git runner, file reader and listing, all local with short timeouts. */
function defaultContext(dir) {
  return {
    git: (args) => {
      if (!dir) throw new Error("no dir");
      return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    },
    readFile: (f) => {
      try {
        return fs.statSync(f).size < 512 * 1024 ? fs.readFileSync(f, "utf8") : null;
      } catch {
        return null;
      }
    },
    listDir: (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    },
  };
}

/** The directory a command segment ran in: the last `cd <dir>` before it, else cwd. Null if unknown. */
export function commandDir(before, cwd, env = process.env) {
  let dir = cwd || null;
  for (const m of String(before).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) {
    let p = m[1].replace(/^["']|["']$/g, "");
    if (p === "~" || p.startsWith("~/")) p = path.join(env.HOME || os.homedir(), p.slice(1));
    if (!path.isAbsolute(p) && !dir) return null;
    dir = path.resolve(dir || "/", p);
  }
  return dir;
}

/** { repo, branch, subject } of the git repo at dir (repo = the main checkout's folder name, also from a worktree), or null. */
export function readGit(dir) {
  if (!dir) return null;
  const c = { dir, ...defaultContext(dir) };
  const g = repoInfo(c);
  const subject = g && tryGit(c, ["log", "-1", "--format=%s"]);
  return g && subject ? { ...g, subject } : null;
}

/** The branch a `git push` names (`git push origin main`, `HEAD:release`), or null to use the checked-out one. */
export function pushedBranch(segment) {
  const w = words(segment);
  const args = w.slice(w.indexOf("push") + 1).filter((x) => !x.startsWith("-"));
  let ref = args[1];
  if (!ref) return null;
  ref = ref.replace(/^\+/, "");
  if (ref.includes(":")) ref = ref.split(":").pop();
  ref = ref.replace(/^refs\/heads\//, "");
  return ref && ref !== "HEAD" ? ref : null;
}

/**
 * Returns { type, title, details, rule, status } for a tool call worth recording, or null.
 * ev: { toolName, toolInput, cwd, failed, output?, exitCode? }
 * opts: { git, readFile, listDir, now, home } to inject the local lookups (tests).
 */
export function classify(rules, ev, opts = {}) {
  const name = String(ev.toolName || "");
  const input = ev.toolInput || {};
  const base = { output: String(ev.output ?? ""), failed: Boolean(ev.failed), exitCode: ev.exitCode ?? null, now: opts.now ?? Date.now(), home: opts.home ?? process.env.HOME ?? os.homedir() };
  const finish = (r, type, fallback, d, tail, where = ev.cwd) => {
    const note = `Recorded automatically by the WaveBrain hook${where ? ` in ${path.basename(where)}` : ""}.`;
    const failed = base.failed || Boolean(d?.failed);
    const lines = [];
    if (failed) lines.push(`Failed: ${d?.reason || failureReason(base.output, base.exitCode) || "the command reported an error"}`);
    lines.push(...(d?.lines ?? []).map(redactKeepUrls), note, tail);
    return { type, title: titleOf(d?.title || fallback), details: lines.join("\n"), rule: r, status: failed ? "failure" : "success" };
  };

  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const cmd = shellCommand(input).trim();
    if (!cmd) return null;
    const masked = maskQuoted(cmd);
    const heredocless = maskQuoted(cmd, false);
    for (const r of rules.shell) {
      // Rules fire on the command itself, not on text inside quotes or heredocs (a commit message
      // that says "git push", a script fed to python), unless the rule looks inside (psql -c "...").
      const m = (r.match_quoted ? heredocless : masked).match(r.re);
      if (!m) continue;
      // The segment that matched, not the whole compound command.
      const from = m.index + (m[1]?.length ?? 0);
      const seps = separators(cmd);
      const start = Math.max(0, ...seps.filter(([i, n]) => i + n <= from).map(([i, n]) => i + n));
      const ends = seps.map(([i]) => i).filter((i) => i >= m.index + m[0].length);
      const segment = cmd.slice(start, ends.length ? Math.min(...ends) : cmd.length).trim();
      const dir = commandDir(cmd.slice(0, start), ev.cwd);
      const c = { ...base, ...defaultContext(dir), ...pick(opts, ["git", "readFile", "listDir"]), segment, cmd, dir };
      let d = null;
      try {
        d = DESCRIBE[r.id]?.(c) ?? null;
      } catch {
        d = null;
      }
      return finish(r.id, r.type, r.title.replace("{cmd}", firstLine(redact(segment), 120)), d, `Command: \`${safeCommand(r.id, cmd)}\``, dir);
    }
    return null;
  }

  const mcp = mcpParts(name) ?? (/^mcp$/i.test(name) ? { server: String(input.server || input.serverName || "mcp"), tool: String(input.toolName || input.tool_name || input.name || "") } : null);
  if (mcp && mcp.tool) {
    if (rules.mcpSkipServers.has(mcp.server)) return null;
    if (mcp.noServer && WAVEBRAIN_TOOLS.has(mcp.tool)) return null;
    const verbs = mcp.tool.toLowerCase().split(/[_\-.]+/);
    if (!verbs.some((v) => rules.mcpWriteVerbs.includes(v))) return null;
    const args = /^mcp$/i.test(name) ? input.arguments ?? input.args ?? {} : input;
    let d = null;
    try {
      d = describeMcp(mcp.server, mcp.tool, args, base);
    } catch {
      d = null;
    }
    return finish("mcp-write", "api_call", `Used ${mcp.server}: ${mcp.tool.replace(/[_-]+/g, " ")}`, d, `Tool: ${mcp.server}/${mcp.tool}`);
  }
  return null;
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k]).map((k) => [k, o[k]]));


// ---------- queue ----------

const safeId = (s) => String(s || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

export function queueFile(host, session, env = process.env) {
  return path.join(home(env), "queue", `${safeId(host)}-${safeId(session)}.jsonl`);
}

function readQueue(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function append(file, item) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(item) + "\n", { mode: 0o600 });
}

/** After a tool call. Returns what was queued (for tests), or null. */
export async function observe({ host, session, toolName, toolInput, cwd, failed, output, exitCode }, { env = process.env, rules = loadRules(), now = Date.now(), lookups = {} } = {}) {
  const cfg = loadConfig(env);
  if (!cfg.enabled) return null;
  const file = queueFile(host, session, env);
  if (isAgentLog(toolName, toolInput)) {
    append(file, { kind: "agent_logged", at: now });
    return { kind: "agent_logged" };
  }
  const action = classify(rules, { toolName, toolInput, cwd, failed, output, exitCode }, { ...lookups, now, home: env.HOME });
  if (!action) return null;
  const item = {
    kind: "action",
    at: now,
    payload: {
      agent: host,
      type: action.type,
      title: action.title,
      details: action.details,
      ...(cwd && { project: path.basename(cwd) }),
      status: action.status,
      metadata: { source: "wavebrain-hook", host, rule: action.rule },
    },
  };
  append(file, item);
  // Hosts without a reliable end-of-turn hook still get their actions out eventually.
  const q = readQueue(file);
  if (q.some((x) => x.kind === "action" && now - x.at > STALE_MS)) await flush({ host, session }, { env, now });
  return item;
}

/** End of turn: send queued actions the agent didn't log itself. Returns counts. */
export async function flush({ host, session }, { env = process.env, now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const cfg = loadConfig(env);
  const file = queueFile(host, session, env);
  const items = readQueue(file);
  if (!items.length) return { sent: 0, skipped: 0, kept: 0 };

  // The agent described its own work: drop what was captured before its last log_action.
  const lastLog = Math.max(-Infinity, ...items.filter((x) => x.kind === "agent_logged").map((x) => x.at));
  let actions = items.filter((x) => x.kind === "action" && x.at > lastLog && now - x.at < MAX_AGE_MS);
  // Two installs (plugin + init hooks) would queue the same call twice within moments.
  const seen = new Set();
  actions = actions.filter((x) => {
    const k = `${x.payload?.title}|${Math.round(x.at / 5000)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const skipped = items.filter((x) => x.kind === "action").length - actions.length;

  if (!cfg.apiKey || !cfg.enabled || !fetchImpl) {
    rewrite(file, actions);
    return { sent: 0, skipped, kept: actions.length };
  }

  const keep = [];
  let sent = 0;
  for (const [i, item] of actions.entries()) {
    if (i >= MAX_PER_FLUSH) {
      keep.push(item);
      continue;
    }
    try {
      const res = await fetchImpl(cfg.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(item.payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) sent++;
      else if (res.status === 400 || res.status === 401 || res.status === 402) {
        // Not retryable: bad payload, bad key, or plan quota. Drop rather than retry forever.
      } else keep.push(item);
    } catch {
      keep.push(item);
    }
  }
  rewrite(file, keep);
  return { sent, skipped, kept: keep.length };
}

function rewrite(file, items) {
  if (!items.length) {
    try {
      fs.unlinkSync(file);
    } catch {}
    return;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- host payloads ----------

/** Plain-text tool output (Codex) has no exit code: treat a clear error line at the start or end as a failure. */
export function looksFailed(resp) {
  if (typeof resp !== "string") return false;
  const lines = resp.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const bad = (l) => /^(fatal|error|Error|ERROR)(\[[^\]]*\])?:/.test(l) || /: command not found$|^Permission denied|^npm ERR!|^Traceback \(most recent call last\)/.test(l);
  return bad(lines[0]) || bad(lines[lines.length - 1]);
}

/** The tool's output as text: stdout/stderr (Claude Code), plain text (Codex), output (Cursor), error. Capped. */
export function outputText(input, resp) {
  const parts = [];
  if (typeof resp === "string") parts.push(resp);
  else if (resp && typeof resp === "object") {
    for (const k of ["stdout", "stderr", "output", "error"]) if (typeof resp[k] === "string") parts.push(resp[k]);
    if (!parts.length && Array.isArray(resp.content)) parts.push(...resp.content.map((x) => (typeof x?.text === "string" ? x.text : "")));
    if (!parts.length && Array.isArray(resp)) parts.push(...resp.map((x) => (typeof x?.text === "string" ? x.text : "")));
  }
  for (const k of ["output", "error"]) if (typeof input[k] === "string") parts.push(input[k]);
  const s = parts.filter(Boolean).join("\n");
  return s.length > 20000 ? s.slice(0, 5000) + "\n…\n" + s.slice(-15000) : s;
}

/** Normalizes a hook's stdin JSON into { session, toolName, toolInput, cwd, failed, output, exitCode }. */
export function fromHookInput(host, input) {
  const resp = input.tool_response ?? input.tool_output ?? input.result ?? {};
  let exit = resp?.exit_code ?? resp?.exitCode ?? input.exit_code ?? input.exitCode;
  if (typeof exit !== "number" && typeof input.error === "string") exit = Number(/Exit code (\d+)/.exec(input.error)?.[1]) || undefined;
  const failed =
    (typeof exit === "number" && exit !== 0) ||
    looksFailed(resp) || // Codex sends only the output text, without an exit code

    resp?.interrupted === true ||
    resp?.success === false ||
    input.status === "error" ||
    /Failure$/.test(input.hook_event_name || "") || // Claude Code: PostToolUseFailure
    Boolean(input.error);
  return {
    host,
    session: input.session_id || input.conversation_id || input.sessionId || "default",
    toolName: input.tool_name || input.toolName || (input.command !== undefined ? "Shell" : ""),
    toolInput: input.tool_input || input.toolInput || (input.command !== undefined ? { command: input.command } : {}),
    cwd: input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined),
    failed: Boolean(failed),
    output: outputText(input, resp),
    exitCode: typeof exit === "number" ? exit : null,
  };
}
