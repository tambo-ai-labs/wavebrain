// Auto-capture: the hooks, skills and plugins `init` installs next to each agent's MCP server.
// Everything here goes through Session.edit, so --dry-run, backups and `remove` work the same way.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Conflict, parseJson, readText } from "./files.mjs";

const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");
const asset = (...p) => fs.readFileSync(path.join(ASSETS, ...p), "utf8");
const dump = (obj) => JSON.stringify(obj, null, 2) + "\n";

export const HOOK_FILES = ["core.mjs", "hook.mjs", "rules.json"];
export const HERMES_FILES = ["__init__.py", "plugin.yaml", "rules.json"];

export function wbHome(ctx) {
  return ctx.env.WAVEBRAIN_HOME || path.join(ctx.home, ".wavebrain");
}
export const hooksDir = (ctx) => path.join(wbHome(ctx), "hooks");
export const configFile = (ctx) => path.join(wbHome(ctx), "config.json");

/** The command a hook runs. Quoted so homes with spaces work. */
export function hookCommand(ctx, host, verb) {
  return `node "${path.join(hooksDir(ctx), "hook.mjs")}" ${host} ${verb}`;
}
const isOurs = (cmd) => typeof cmd === "string" && /wavebrain/.test(cmd) && /hook\.mjs/.test(cmd);

export const restUrl = (mcpUrl) => mcpUrl.replace(/\/api\/mcp\/?$/, "/api/v1/actions");

// ---------- shared files: the hook runner and ~/.wavebrain/config.json ----------

/** Copies the hook runner into ~/.wavebrain/hooks and saves the key for hooks to use. */
export function stageCapture(ctx, s, { key, url }) {
  const out = [];
  for (const f of HOOK_FILES) {
    const file = path.join(hooksDir(ctx), f);
    const before = readText(file);
    out.push({ ref: `capture:${f}`, file, kind: s.edit(file, () => asset("hooks", f)), createdFile: before === null });
  }
  const cf = configFile(ctx);
  const before = readText(cf);
  out.push({
    ref: "capture:config",
    file: cf,
    createdFile: before === null,
    kind: s.edit(cf, (t) => {
      const cur = safeParse(t, cf);
      const next = { ...cur, apiKey: key, apiUrl: restUrl(url), autoCapture: cur.autoCapture ?? true };
      return JSON.stringify(cur) === JSON.stringify(next) && t !== null ? t : dump(next);
    }),
  });
  return out;
}

export function unstageCapture(ctx, s) {
  return [...HOOK_FILES.map((f) => path.join(hooksDir(ctx), f)), configFile(ctx)]
    .filter((f) => readText(f) !== null)
    .map((file) => ({ ref: "capture:files", file, kind: s.edit(file, () => null) }));
}

function safeParse(text, file) {
  try {
    return parseJson(text, file);
  } catch {
    return {};
  }
}

// ---------- hooks.json style files ----------

/**
 * format "nested" (Claude Code settings.json, Codex hooks.json):
 *   { hooks: { Event: [ { matcher?, hooks: [ { type: "command", command, timeout } ] } ] } }
 * format "flat" (Cursor hooks.json):
 *   { version: 1, hooks: { event: [ { command, matcher? } ] } }
 * entries: [{ event, matcher?, command, timeout? }]
 */
export function addHooks(text, file, format, entries) {
  const obj = parseJson(text, file);
  if (obj.hooks !== undefined && (typeof obj.hooks !== "object" || Array.isArray(obj.hooks))) {
    throw new Conflict(`${file}: "hooks" isn't an object; add WaveBrain's hooks by hand instead`);
  }
  const cleaned = stripOurs(obj, format);
  if (format === "flat") cleaned.version ??= 1;
  cleaned.hooks ??= {};
  for (const e of entries) {
    const list = Array.isArray(cleaned.hooks[e.event]) ? cleaned.hooks[e.event] : [];
    if (format === "flat") list.push({ command: e.command, ...(e.matcher && { matcher: e.matcher }) });
    else list.push({ ...(e.matcher && { matcher: e.matcher }), hooks: [{ type: "command", command: e.command, timeout: e.timeout ?? 30 }] });
    cleaned.hooks[e.event] = list;
  }
  const next = dump(cleaned);
  return text !== null && JSON.stringify(parseJson(text, file)) === JSON.stringify(cleaned) ? text : next;
}

export function removeHooks(text, file, format, { deleteIfEmpty = false } = {}) {
  if (text === null) return null;
  const obj = parseJson(text, file);
  const cleaned = stripOurs(obj, format);
  if (JSON.stringify(cleaned) === JSON.stringify(obj)) return text;
  if (cleaned.hooks && !Object.keys(cleaned.hooks).length) delete cleaned.hooks;
  if (format === "flat" && Object.keys(cleaned).every((k) => k === "version")) delete cleaned.version;
  if (deleteIfEmpty && !Object.keys(cleaned).length) return null;
  return dump(cleaned);
}

function stripOurs(obj, format) {
  const copy = JSON.parse(JSON.stringify(obj));
  if (!copy.hooks || typeof copy.hooks !== "object") return copy;
  for (const [event, list] of Object.entries(copy.hooks)) {
    if (!Array.isArray(list)) continue;
    const kept =
      format === "flat"
        ? list.filter((h) => !isOurs(h?.command))
        : list
            .map((g) => (Array.isArray(g?.hooks) ? { ...g, hooks: g.hooks.filter((h) => !isOurs(h?.command)) } : g))
            .filter((g) => !Array.isArray(g?.hooks) || g.hooks.length);
    if (kept.length) copy.hooks[event] = kept;
    else delete copy.hooks[event];
  }
  return copy;
}

export function hasOurHooks(text) {
  return typeof text === "string" && /wavebrain[^"\n]*hook\.mjs/.test(text);
}

// ---------- Codex: [features] hooks = true ----------

const TAG = "# added by WaveBrain";
// Older installs tagged lines "# added by wavebrain init"; still recognized on remove.
const isTagged = (l) => /# added by (WaveBrain|wavebrain init)/.test(l);

export function codexEnableHooks(text) {
  const t = text ?? "";
  const lines = t.split("\n");
  const h = lines.findIndex((l) => /^\s*\[features\]\s*(#.*)?$/.test(l));
  if (h === -1) {
    // Before our server block if there is one, so re-running init (which rewrites that block
    // at the end of the file) doesn't reorder anything.
    const block = lines.findIndex((l) => l.trim().startsWith("# >>> wavebrain"));
    if (block !== -1) {
      lines.splice(block, 0, `[features] ${TAG}`, `hooks = true ${TAG}`, "");
      return lines.join("\n");
    }
    return `${t.replace(/\n*$/, t ? "\n\n" : "")}[features] ${TAG}\nhooks = true ${TAG}\n`;
  }
  let end = lines.findIndex((l, i) => i > h && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const existing = lines.slice(h + 1, end).findIndex((l) => /^\s*hooks\s*=/.test(l));
  if (existing !== -1) {
    if (/^\s*hooks\s*=\s*true\b/.test(lines[h + 1 + existing])) return text;
    throw new Conflict("~/.codex/config.toml sets [features] hooks = false; WaveBrain's hooks need it on (left as is)");
  }
  lines.splice(h + 1, 0, `hooks = true ${TAG}`);
  return lines.join("\n");
}

export function codexDisableHooks(text) {
  if (text === null || !text.split("\n").some(isTagged)) return text;
  const out = text
    .split("\n")
    .filter((l) => !(isTagged(l) && /^\s*hooks\s*=/.test(l)))
    .map((l) => (isTagged(l) && /^\s*\[features\]/.test(l) ? null : l))
    .filter((l) => l !== null)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
  return out.trim() ? out : null;
}

// ---------- skills and the Hermes plugin ----------

export function skillText() {
  return asset("SKILL.md");
}

export function hermesPluginFiles() {
  return HERMES_FILES.map((f) => [f, asset("hermes", f)]);
}

/** Runs `hermes plugins enable|disable wavebrain` against one Hermes home. Best effort. */
export function hermesPluginToggle(ctx, hermesDir, on) {
  const r = spawnSync("hermes", ["plugins", on ? "enable" : "disable", "wavebrain"], {
    env: { ...ctx.env, HERMES_HOME: hermesDir },
    encoding: "utf8",
    timeout: 60_000,
  });
  return r.status === 0;
}

/**
 * Removes "wavebrain" from plugins.enabled / plugins.disabled in a Hermes config.yaml. A list left
 * empty by that is dropped, and so is a plugins block left empty, so the file ends up as it was
 * before `hermes plugins enable wavebrain`. Used by uninstall (the plugin files are deleted too).
 */
export function hermesUnlistPlugin(text) {
  if (text === null) return null;
  const lines = text.split("\n");
  const start = lines.findIndex((l) => /^plugins:\s*(#.*)?$/.test(l));
  if (start < 0) return text;
  // The block runs to the next top-level key; column-0 comments and blank lines don't end it.
  let end = start + 1;
  while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++;
  const isOurs = (l) => /^\s+-\s*["']?wavebrain["']?\s*(#.*)?$/.test(l);
  const keyRe = /^(\s+)(enabled|disabled):\s*(.*)$/;
  const drop = new Set();
  let touched = false;
  for (let i = start + 1; i < end; i++) {
    const m = keyRe.exec(lines[i]);
    if (!m) continue;
    const flow = /^\[(.*)\]\s*$/.exec(m[3]);
    if (flow) {
      const items = flow[1].split(",").map((x) => x.trim()).filter(Boolean);
      const left = items.filter((x) => !/^["']?wavebrain["']?$/.test(x));
      if (left.length === items.length) continue;
      touched = true;
      if (left.length) lines[i] = `${m[1]}${m[2]}: [${left.join(", ")}]`;
      else drop.add(i);
      continue;
    }
    if (m[3].trim()) continue;
    // Block list: the "- item" lines that follow.
    const items = [];
    for (let j = i + 1; j < end && /^\s+-/.test(lines[j]); j++) items.push(j);
    const ours = items.filter((j) => isOurs(lines[j]));
    if (!ours.length) continue;
    touched = true;
    ours.forEach((j) => drop.add(j));
    if (ours.length === items.length) drop.add(i);
  }
  if (!touched) return text;
  const body = [];
  for (let i = start + 1; i < end; i++) if (!drop.has(i)) body.push(lines[i]);
  // Empty lists (enabled: [] / disabled: []) are Hermes's own defaults, not the user's settings.
  const meaningful = body.some((l) => /^\s+[^\s#]/.test(l) && !/^\s+(enabled|disabled):\s*\[\]\s*$/.test(l));
  let out;
  if (meaningful) out = [...lines.slice(0, start + 1), ...body, ...lines.slice(end)];
  else {
    // Nothing of the user's left: drop the block, keeping column-0 comments that sat inside it.
    const kept = body.filter((l) => /^#/.test(l));
    let head = lines.slice(0, start);
    const tail = lines.slice(end);
    if (!kept.length) {
      while (head.length && head[head.length - 1] === "") head.pop();
      out = [...head, ...(tail.length && head.length ? [""] : []), ...tail];
    } else out = [...head, ...kept, ...tail];
  }
  let res = out.join("\n");
  if (text.endsWith("\n") && !res.endsWith("\n")) res += "\n";
  return res;
}
