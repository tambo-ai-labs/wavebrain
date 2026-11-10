// File editing with backups, atomic writes and dry runs, plus small pure text transforms for the
// formats agents use (JSON, TOML, YAML, .env). Transforms never see or return anything but text.

import fs from "node:fs";
import path from "node:path";

export const BACKUP_SUFFIX = ".bak-wavebrain";
export const MARK_START = ">>> wavebrain (added by npx wavebrain init)";
export const MARK_END = "<<< wavebrain";

export class Conflict extends Error {}

export function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Applies edits to files; records what changed. In a dry run nothing is written. */
export class Session {
  constructor({ dryRun = false } = {}) {
    this.dryRun = dryRun;
    this.changes = [];
  }

  /**
   * fn(text|null) returns the new text, null to delete the file, or the same text for no change.
   * Throws Conflict to refuse. Returns "created" | "updated" | "deleted" | "unchanged".
   */
  edit(file, fn) {
    const before = readText(file);
    const after = fn(before);
    if (after === before) return "unchanged";
    const kind = before === null ? "created" : after === null ? "deleted" : "updated";
    // Files that are entirely ours (in a wavebrain folder) aren't backed up: a backup of
    // ~/.wavebrain/config.json would leave the API key behind after `remove`.
    const ownedFile = /[\\/](\.wavebrain|wavebrain)[\\/]/.test(file);
    const backup = before === null || ownedFile ? null : file + BACKUP_SUFFIX;
    if (!this.dryRun) {
      let mode;
      if (before !== null) {
        mode = fs.statSync(file).mode & 0o777;
        if (backup) {
          fs.copyFileSync(file, backup);
          fs.chmodSync(backup, mode);
        }
      }
      if (after === null) {
        fs.unlinkSync(file);
        // Folders that only ever held our files (skills/wavebrain, plugins/wavebrain, ~/.wavebrain/hooks).
        const dir = path.dirname(file);
        if (/(^|[\\/])(wavebrain|hooks)$/.test(dir) && /wavebrain/.test(dir)) {
          try {
            fs.rmdirSync(dir);
          } catch {}
        }
      } else writeAtomic(file, after, mode);
    }
    this.changes.push({ file, kind, backup });
    return kind;
  }
}

function writeAtomic(file, text, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.wavebrain-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: mode ?? 0o600 });
  if (mode !== undefined) fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// ---------- JSON ----------

export function parseJson(text, file) {
  if (text === null || text.trim() === "") return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v;
  } catch {
    throw new Conflict(`couldn't parse ${file} as plain JSON (comments or trailing commas?); add it by hand instead`);
  }
}

const dump = (obj) => JSON.stringify(obj, null, 2) + "\n";

export function getIn(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

/** Sets obj[...keys] = value. */
export function jsonSet(text, keys, value, file) {
  const obj = parseJson(text, file);
  let cur = obj;
  for (const k of keys.slice(0, -1)) {
    if (cur[k] === undefined) cur[k] = {};
    if (!cur[k] || typeof cur[k] !== "object" || Array.isArray(cur[k])) {
      throw new Conflict(`${file}: "${k}" isn't an object; add it by hand instead`);
    }
    cur = cur[k];
  }
  const last = keys[keys.length - 1];
  if (JSON.stringify(cur[last]) === JSON.stringify(value)) return text;
  cur[last] = value;
  return dump(obj);
}

/** Index of the first key in the path that doesn't exist yet (keys.length if all do). */
export function firstMissing(text, keys, file) {
  let cur = parseJson(text, file);
  for (let i = 0; i < keys.length; i++) {
    if (!cur || typeof cur !== "object" || !(keys[i] in cur)) return i;
    cur = cur[keys[i]];
  }
  return keys.length;
}

/**
 * Deletes obj[...keys], then any now-empty parents from index `pruneFrom` down (parents we created).
 * Returns null (delete the file) if that leaves only empty objects and deleteIfEmpty.
 */
export function jsonDelete(text, keys, file, { deleteIfEmpty = false, pruneFrom = keys.length } = {}) {
  if (text === null) return null;
  const obj = parseJson(text, file);
  const parent = getIn(obj, keys.slice(0, -1));
  const last = keys[keys.length - 1];
  if (!parent || typeof parent !== "object" || !(last in parent)) return text;
  delete parent[last];
  for (let i = keys.length - 2; i >= pruneFrom; i--) {
    const v = getIn(obj, keys.slice(0, i + 1));
    const empty = Array.isArray(v) ? v.length === 0 : v && typeof v === "object" && Object.keys(v).length === 0;
    if (!empty) break;
    delete getIn(obj, keys.slice(0, i))[keys[i]];
  }
  if (deleteIfEmpty && isEmptyTree(obj)) return null;
  return dump(obj);
}

const isEmptyTree = (v) => v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every(isEmptyTree);

/** Adds a string to the array at keys if missing. */
export function jsonArrayAdd(text, keys, item, file) {
  const obj = parseJson(text, file);
  const arr = getIn(obj, keys);
  if (arr !== undefined && !Array.isArray(arr)) throw new Conflict(`${file}: ${keys.join(".")} isn't a list`);
  if (arr?.includes(item)) return text;
  return jsonSet(text, keys, [...(arr ?? []), item], file);
}

export function jsonArrayRemove(text, keys, item, file, opts) {
  if (text === null) return null;
  const obj = parseJson(text, file);
  const arr = getIn(obj, keys);
  if (!Array.isArray(arr) || !arr.includes(item)) return text;
  const rest = arr.filter((x) => x !== item);
  if (rest.length || (opts?.pruneFrom ?? keys.length) >= keys.length) return jsonSet(text, keys, rest, file);
  return jsonDelete(text, keys, file, opts);
}

// ---------- marked text blocks (TOML, YAML, .env) ----------

const markerLine = (indent, mark) => `${indent}# ${mark}`;

/** Index range [start, end] of our marked block, or null. */
export function findBlock(lines) {
  const start = lines.findIndex((l) => l.trim().startsWith(`# ${MARK_START}`));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trim() === `# ${MARK_END}`);
  return end < 0 ? null : [start, end];
}

export function hasBlock(text) {
  return text !== null && findBlock(text.split("\n")) !== null;
}

/** The text with our block removed (and a trailing blank line we added). */
export function removeBlock(text, { restore } = {}) {
  if (text === null) return null;
  const lines = text.split("\n");
  const range = findBlock(lines);
  if (!range) return text;
  const [s, e] = range;
  const was = lines[s].match(/; was "(.*)"\)?\s*$/);
  const replacement = was ? [lines[s].match(/^\s*/)[0] + was[1].replace(/\\"/g, '"')] : [];
  lines.splice(s, e - s + 1, ...replacement);
  // Drop one blank line left behind where we appended with a separator.
  if (!was && s > 0 && lines[s - 1] === "" && (s === lines.length || lines[s] === "")) lines.splice(s - 1, 1);
  const out = lines.join("\n");
  return restore === "delete-if-empty" && out.trim() === "" ? null : out;
}

function block(indent, body) {
  return [markerLine(indent, MARK_START), ...body, markerLine(indent, MARK_END)];
}

/** Appends (or replaces) our block at the end of the file. */
export function upsertAppendedBlock(text, body) {
  const base = removeBlock(text) ?? "";
  const trimmed = base.replace(/\n+$/, "");
  const lines = block("", body);
  return (trimmed ? trimmed + "\n\n" : "") + lines.join("\n") + "\n";
}

// ---------- TOML (Codex) ----------

export function tomlString(s) {
  return JSON.stringify(s);
}

export function tomlUpsertServer(text, name, entries) {
  const without = removeBlock(text) ?? "";
  if (new RegExp(`^\\s*\\[mcp_servers\\.${name}(\\.|\\])`, "m").test(without)) {
    throw new Conflict(`a [mcp_servers.${name}] server is already configured (not by wavebrain init); left as is`);
  }
  const body = [`[mcp_servers.${name}]`, ...entries.map(([k, v]) => `${k} = ${v}`)];
  const next = upsertAppendedBlock(text, body);
  return next === text ? text : next;
}

// ---------- YAML (Hermes) ----------

/** Adds `name` under top-level mcp_servers, keeping the file's own indentation. */
export function yamlUpsertServer(text, name, bodyLines) {
  const base = removeBlock(text) ?? "";
  const lines = base.split("\n");
  const keyIdx = lines.findIndex((l) => /^mcp_servers:/.test(l));
  const childRe = new RegExp(`^\\s+${name}:`);

  if (keyIdx < 0) {
    const trimmed = base.replace(/\n+$/, "");
    const out = block("", ["mcp_servers:", ...indentAll(bodyLines(2, name), 2)]);
    const next = (trimmed ? trimmed + "\n\n" : "") + out.join("\n") + "\n";
    return next === text ? text : next;
  }

  const keyLine = lines[keyIdx];
  if (/^mcp_servers:\s*(#.*)?$/.test(keyLine)) {
    // Block mapping: find its children and their indent.
    let end = keyIdx + 1;
    let indent = 0;
    while (end < lines.length && (lines[end].trim() === "" || /^\s/.test(lines[end]))) {
      if (!indent && lines[end].trim() && !lines[end].trim().startsWith("#")) indent = lines[end].match(/^\s*/)[0].length;
      if (childRe.test(lines[end]) && lines[end].match(/^\s*/)[0].length === (indent || 2)) {
        throw new Conflict(`mcp_servers already has a "${name}" server (not added by wavebrain init); left as is`);
      }
      end++;
    }
    indent ||= 2;
    lines.splice(keyIdx + 1, 0, ...block(" ".repeat(indent), indentAll(bodyLines(indent, name), indent)));
    const next = lines.join("\n");
    return next === text ? text : next;
  }

  if (/^mcp_servers:\s*(\{\s*\}|null|~)?\s*$/.test(keyLine)) {
    const was = keyLine.trim().replace(/"/g, '\\"');
    const out = [
      `# ${MARK_START}; was "${was}"`,
      "mcp_servers:",
      ...indentAll(bodyLines(2, name), 2),
      `# ${MARK_END}`,
    ];
    lines.splice(keyIdx, 1, ...out);
    return lines.join("\n");
  }
  throw new Conflict("mcp_servers is written in a form this tool can't edit safely; add it by hand instead");
}

function indentAll(lines, n) {
  return lines.map((l) => " ".repeat(n) + l);
}

// ---------- .env ----------

export function envUpsert(text, key, value) {
  const without = removeBlock(text) ?? "";
  const existing = without.match(new RegExp(`^\\s*(?:export\\s+)?${key}=(.*)$`, "m"));
  if (existing) {
    const v = existing[1].trim().replace(/^["']|["']$/g, "");
    if (v === value) return text; // Already set to this key by the user: leave it.
    throw new Conflict(`${key} is already set to a different key (not by wavebrain init); left as is`);
  }
  const next = upsertAppendedBlock(text, [`${key}=${value}`]);
  return next === text ? text : next;
}
