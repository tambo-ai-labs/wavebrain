// One target per agent config WaveBrain can be added to. Every path comes from ctx
// ({ home, env, platform }) so tests and dry runs can point everything at a sandbox.

import fs from "node:fs";
import path from "node:path";
import {
  Conflict,
  getIn,
  hasBlock,
  jsonArrayAdd,
  jsonArrayRemove,
  jsonDelete,
  jsonSet,
  firstMissing,
  parseJson,
  readText,
  removeBlock,
  tomlString,
  tomlUpsertServer,
  yamlUpsertServer,
  envUpsert,
} from "./files.mjs";

export const SERVER = "wavebrain";
export const KEY_ENV = "WAVEBRAIN_API_KEY";
export const CLAUDE_RULE = `mcp__${SERVER}__*`;

const exists = (p) => {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
};

export function onPath(ctx, bin) {
  const dirs = (ctx.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts = ctx.platform === "win32" ? ["", ".cmd", ".exe", ".bat"] : [""];
  return dirs.some((d) => exts.some((x) => exists(path.join(d, bin + x))));
}

function appData(ctx) {
  return ctx.env.APPDATA || path.join(ctx.home, "AppData", "Roaming");
}

function appSupport(ctx, ...rest) {
  if (ctx.platform === "darwin") return path.join(ctx.home, "Library", "Application Support", ...rest);
  if (ctx.platform === "win32") return path.join(appData(ctx), ...rest);
  return path.join(ctx.env.XDG_CONFIG_HOME || path.join(ctx.home, ".config"), ...rest);
}

const bearer = (key) => `Bearer ${key}`;

/** A target whose config is one JSON file with our server under `keys`. */
function jsonTarget({ id, label, file, keys, entry, detect, next }) {
  return {
    id,
    label,
    files: (ctx) => [file(ctx)],
    detect,
    next,
    configured: (ctx) => getIn(safeJson(file(ctx)), keys) !== undefined,
    install(ctx, s, opts, owned) {
      const f = file(ctx);
      const current = getIn(safeJson(f), keys);
      if (current !== undefined && !owned.has(`${id}:server`)) {
        throw new Conflict(`a "${SERVER}" server is already in ${tilde(ctx, f)} (not added by wavebrain init); left as is`);
      }
      const before = readText(f);
      const prev = owned.get(`${id}:server`);
      const kind = s.edit(f, (t) => jsonSet(t, keys, entry(opts), f));
      return [
        {
          ref: `${id}:server`,
          file: f,
          kind,
          createdFile: prev?.createdFile ?? before === null,
          pruneFrom: prev?.pruneFrom ?? firstMissing(before, keys, f),
        },
      ];
    },
    uninstall(ctx, s, owned) {
      const rec = owned.get(`${id}:server`);
      if (!rec) return [];
      const kind = s.edit(rec.file, (t) =>
        jsonDelete(t, keys, rec.file, { deleteIfEmpty: rec.createdFile, pruneFrom: rec.pruneFrom ?? keys.length - 1 }),
      );
      return [{ ref: `${id}:server`, file: rec.file, kind }];
    },
  };
}

function safeJson(file) {
  try {
    return parseJson(readText(file), file);
  } catch {
    return {};
  }
}

export function tilde(ctx, p) {
  return p.startsWith(ctx.home + path.sep) ? "~" + p.slice(ctx.home.length) : p;
}

// ---------- Claude Code ----------

function claudeDir(ctx) {
  return ctx.env.CLAUDE_CONFIG_DIR || path.join(ctx.home, ".claude");
}
function claudeJson(ctx) {
  return ctx.env.CLAUDE_CONFIG_DIR ? path.join(ctx.env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(ctx.home, ".claude.json");
}

const claudeServer = jsonTarget({
  id: "claude-code",
  label: "Claude Code",
  file: claudeJson,
  keys: ["mcpServers", SERVER],
  entry: ({ url, key }) => ({ type: "http", url, headers: { Authorization: bearer(key) } }),
  detect: (ctx) => onPath(ctx, "claude") || exists(claudeJson(ctx)),
  next: "Start a new Claude Code session; /mcp should list wavebrain.",
});

const claudeCode = {
  ...claudeServer,
  files: (ctx) => [claudeJson(ctx), path.join(claudeDir(ctx), "settings.json")],
  install(ctx, s, opts, owned) {
    const out = claudeServer.install(ctx, s, opts, owned);
    if (opts.claudePermission) {
      const f = path.join(claudeDir(ctx), "settings.json");
      const had = (getIn(safeJson(f), ["permissions", "allow"]) ?? []).includes(CLAUDE_RULE);
      const prev = owned.get("claude-code:permission");
      if (!had || prev) {
        const before = readText(f);
        const kind = s.edit(f, (t) => jsonArrayAdd(t, ["permissions", "allow"], CLAUDE_RULE, f));
        out.push({
          ref: "claude-code:permission",
          file: f,
          kind,
          createdFile: prev?.createdFile ?? before === null,
          pruneFrom: prev?.pruneFrom ?? firstMissing(before, ["permissions", "allow"], f),
        });
      }
    }
    return out;
  },
  uninstall(ctx, s, owned) {
    const out = claudeServer.uninstall(ctx, s, owned);
    const rec = owned.get("claude-code:permission");
    if (rec) {
      const kind = s.edit(rec.file, (t) =>
        jsonArrayRemove(t, ["permissions", "allow"], CLAUDE_RULE, rec.file, {
          deleteIfEmpty: rec.createdFile,
          pruneFrom: rec.pruneFrom ?? 2,
        }),
      );
      out.push({ ref: "claude-code:permission", file: rec.file, kind });
    }
    return out;
  },
};

// ---------- Codex ----------

function codexToml(ctx) {
  return path.join(ctx.env.CODEX_HOME || path.join(ctx.home, ".codex"), "config.toml");
}

const codex = {
  id: "codex",
  label: "Codex CLI",
  files: (ctx) => [codexToml(ctx)],
  detect: (ctx) => exists(codexToml(ctx)) || onPath(ctx, "codex"),
  configured: (ctx) => /^\s*\[mcp_servers\.wavebrain\]/m.test(readText(codexToml(ctx)) ?? ""),
  next: `Start a new Codex session; /mcp should list wavebrain.`,
  install(ctx, s, { url, key, keyFromEnv }) {
    const f = codexToml(ctx);
    // With the key already in the environment, reference it; otherwise Codex needs it in the file.
    const auth = keyFromEnv
      ? [["bearer_token_env_var", tomlString(KEY_ENV)]]
      : [["http_headers", `{ "Authorization" = ${tomlString(bearer(key))} }`]];
    const kind = s.edit(f, (t) => tomlUpsertServer(t, SERVER, [["url", tomlString(url)], ...auth]));
    return [{ ref: "codex:server", file: f, kind }];
  },
  uninstall(ctx, s, owned) {
    const f = owned.get("codex:server")?.file ?? codexToml(ctx);
    if (!hasBlock(readText(f))) return [];
    return [{ ref: "codex:server", file: f, kind: s.edit(f, (t) => removeBlock(t, { restore: "delete-if-empty" })) }];
  },
};

// ---------- Cursor, Windsurf, Claude Desktop, VS Code ----------

const cursor = jsonTarget({
  id: "cursor",
  label: "Cursor",
  file: (ctx) => path.join(ctx.home, ".cursor", "mcp.json"),
  keys: ["mcpServers", SERVER],
  entry: ({ url, key }) => ({ url, headers: { Authorization: bearer(key) } }),
  detect: (ctx) => exists(path.join(ctx.home, ".cursor")),
  next: "Open Cursor Settings → MCP to check that wavebrain is enabled.",
});

const windsurf = jsonTarget({
  id: "windsurf",
  label: "Windsurf",
  file: (ctx) => path.join(ctx.home, ".codeium", "windsurf", "mcp_config.json"),
  keys: ["mcpServers", SERVER],
  entry: ({ url, key }) => ({ serverUrl: url, headers: { Authorization: bearer(key) } }),
  detect: (ctx) => exists(path.join(ctx.home, ".codeium", "windsurf")),
  next: "Press Refresh in Cascade's MCP panel.",
});

const claudeDesktopFile = (ctx) => appSupport(ctx, "Claude", "claude_desktop_config.json");
const claudeDesktop = jsonTarget({
  id: "claude-desktop",
  label: "Claude Desktop",
  file: claudeDesktopFile,
  keys: ["mcpServers", SERVER],
  // The config only takes local servers, so the remote one goes through mcp-remote (needs Node.js).
  entry: ({ url, key }) => ({
    command: "npx",
    args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"],
    env: { AUTH_HEADER: bearer(key) },
  }),
  detect: (ctx) => exists(path.dirname(claudeDesktopFile(ctx))),
  next: "Quit and reopen Claude Desktop.",
});

const vscodeFile = (ctx) => appSupport(ctx, "Code", "User", "mcp.json");
const vscode = jsonTarget({
  id: "vscode",
  label: "VS Code (Copilot)",
  file: vscodeFile,
  keys: ["servers", SERVER],
  entry: ({ url, key }) => ({ type: "http", url, headers: { Authorization: bearer(key) } }),
  detect: (ctx) => exists(path.dirname(vscodeFile(ctx))) || onPath(ctx, "code"),
  next: "In VS Code, run “MCP: List Servers” and start wavebrain if needed.",
});

// ---------- Hermes ----------

function hermesHome(ctx) {
  return ctx.env.HERMES_HOME || path.join(ctx.home, ".hermes");
}

function hermesTarget(profile) {
  const id = profile ? `hermes:${profile}` : "hermes";
  const dir = (ctx) => (profile ? path.join(hermesHome(ctx), "profiles", profile) : hermesHome(ctx));
  const yaml = (ctx) => path.join(dir(ctx), "config.yaml");
  const env = (ctx) => path.join(dir(ctx), ".env");
  return {
    id,
    label: profile ? `Hermes Agent (profile ${profile})` : "Hermes Agent",
    files: (ctx) => [yaml(ctx), env(ctx)],
    detect: (ctx) => exists(yaml(ctx)),
    configured: (ctx) => hasBlock(readText(yaml(ctx))) || /^\s+wavebrain:/m.test(readText(yaml(ctx)) ?? ""),
    next: profile ? `Run: hermes -p ${profile} gateway restart (or /reload-mcp in a chat).` : "Run: hermes gateway restart (or /reload-mcp in a chat).",
    install(ctx, s, { url, key }) {
      const y = yaml(ctx);
      const e = env(ctx);
      // Check both files before writing either, so a conflict leaves nothing half done.
      envUpsert(readText(e), KEY_ENV, key);
      yamlUpsertServer(readText(y), SERVER, (n, name) => serverLines(n, name, url));
      const yk = s.edit(y, (t) => yamlUpsertServer(t, SERVER, (n, name) => serverLines(n, name, url)));
      const ek = s.edit(e, (t) => envUpsert(t, KEY_ENV, key));
      return [
        { ref: `${id}:server`, file: y, kind: yk },
        { ref: `${id}:env`, file: e, kind: ek },
      ];
    },
    uninstall(ctx, s) {
      const out = [];
      for (const [ref, f] of [
        [`${id}:server`, yaml(ctx)],
        [`${id}:env`, env(ctx)],
      ]) {
        if (hasBlock(readText(f))) out.push({ ref, file: f, kind: s.edit(f, (t) => removeBlock(t, { restore: "delete-if-empty" })) });
      }
      return out;
    },
  };
}

function serverLines(n, name, url) {
  const i = " ".repeat(n);
  return [`${name}:`, `${i}url: "${url}"`, `${i}headers:`, `${i}${i}Authorization: "Bearer \${${KEY_ENV}}"`];
}

export function hermesProfiles(ctx) {
  try {
    return fs
      .readdirSync(path.join(hermesHome(ctx), "profiles"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^[A-Za-z0-9._-]+$/.test(d.name))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ---------- registry ----------

export const BASE_TARGET_IDS = ["claude-code", "codex", "cursor", "windsurf", "claude-desktop", "vscode", "hermes"];

const BASE = { "claude-code": claudeCode, codex, cursor, windsurf, "claude-desktop": claudeDesktop, vscode, hermes: hermesTarget(null) };

/** Every target, including one per Hermes profile found. */
export function allTargets(ctx) {
  return [...BASE_TARGET_IDS.map((id) => BASE[id]), ...hermesProfiles(ctx).map((p) => hermesTarget(p))];
}

export function targetById(ctx, id) {
  if (BASE[id]) return BASE[id];
  const m = id.match(/^hermes:([A-Za-z0-9._-]+)$/);
  return m ? hermesTarget(m[1]) : null;
}
