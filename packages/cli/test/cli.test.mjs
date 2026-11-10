// End-to-end runs of init / remove / status against a temporary HOME. Never touches real configs:
// every path comes from the ctx built here.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { mask, run } from "../src/cli.mjs";

const KEY = "al_" + "A".repeat(32);
const KEY2 = "al_" + "B".repeat(32);

function sandbox(platform = "darwin") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wavebrain-cli-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  return { home, env: { PATH: bin }, platform };
}

function io(answers = []) {
  const lines = [];
  const q = [...answers];
  return {
    lines,
    interactive: answers.length > 0,
    out: (l) => lines.push(l),
    ask: async () => q.shift() ?? "",
    askSecret: async () => q.shift() ?? "",
    open: () => lines.push("[opened browser]"),
  };
}

const write = (ctx, rel, text) => {
  const p = path.join(ctx.home, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};
const read = (ctx, rel) => fs.readFileSync(path.join(ctx.home, rel), "utf8");
const has = (ctx, rel) => fs.existsSync(path.join(ctx.home, rel));
const json = (ctx, rel) => JSON.parse(read(ctx, rel));

const ALL = ["claude-code", "codex", "cursor", "windsurf", "claude-desktop", "vscode", "hermes"].flatMap((a) => ["--agent", a]);

test("init writes every agent's config, backs up touched files, and never prints the key", async () => {
  const ctx = sandbox();
  write(ctx, ".claude.json", JSON.stringify({ numStartups: 3, mcpServers: { other: { type: "stdio" } } }));
  write(ctx, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }));
  write(ctx, ".codex/config.toml", 'model = "o3"\n');
  write(ctx, ".hermes/config.yaml", "model: x\n");
  const out = io();
  assert.equal(await run(["init", ...ALL, "--key", KEY], ctx, out), 0);

  const cc = json(ctx, ".claude.json");
  assert.equal(cc.numStartups, 3);
  assert.deepEqual(cc.mcpServers.wavebrain, {
    type: "http",
    url: "https://getwavebrain.com/api/mcp",
    headers: { Authorization: `Bearer ${KEY}` },
  });
  assert.deepEqual(json(ctx, ".claude/settings.json").permissions.allow, ["Bash(ls:*)", "mcp__wavebrain__*"]);
  assert.match(read(ctx, ".codex/config.toml"), /\[mcp_servers\.wavebrain\]\nurl = "https:\/\/getwavebrain.com\/api\/mcp"\nhttp_headers = \{ "Authorization" = "Bearer al_A+" \}/);
  assert.equal(json(ctx, ".cursor/mcp.json").mcpServers.wavebrain.url, "https://getwavebrain.com/api/mcp");
  assert.equal(json(ctx, ".codeium/windsurf/mcp_config.json").mcpServers.wavebrain.serverUrl, "https://getwavebrain.com/api/mcp");
  const cd = json(ctx, "Library/Application Support/Claude/claude_desktop_config.json").mcpServers.wavebrain;
  assert.deepEqual(cd.env, { AUTH_HEADER: `Bearer ${KEY}` });
  assert.equal(json(ctx, "Library/Application Support/Code/User/mcp.json").servers.wavebrain.type, "http");
  const yaml = read(ctx, ".hermes/config.yaml");
  assert.match(yaml, /Authorization: "Bearer \$\{WAVEBRAIN_API_KEY\}"/);
  assert.doesNotMatch(yaml, /al_A/);
  assert.match(read(ctx, ".hermes/.env"), new RegExp(`WAVEBRAIN_API_KEY=${KEY}`));

  // Backups of files that existed, none for files that were created.
  for (const f of [".claude.json", ".claude/settings.json", ".codex/config.toml", ".hermes/config.yaml"]) {
    assert.ok(has(ctx, f + ".bak-wavebrain"), f);
  }
  assert.equal(JSON.parse(read(ctx, ".claude.json.bak-wavebrain")).mcpServers.wavebrain, undefined);
  assert.ok(!has(ctx, ".cursor/mcp.json.bak-wavebrain"));

  const printed = out.lines.join("\n");
  assert.ok(!printed.includes(KEY), "full key printed");
  assert.ok(printed.includes(mask(KEY)));
  assert.ok(!JSON.stringify(json(ctx, ".wavebrain/installed.json")).includes("al_"), "key in state file");
});

test("init is idempotent and rotates its own entries", async () => {
  const ctx = sandbox();
  await run(["init", ...ALL, "--key", KEY], ctx, io());
  const snapshot = () => [".claude.json", ".codex/config.toml", ".cursor/mcp.json", ".hermes/config.yaml", ".hermes/.env"].map((f) => read(ctx, f));
  const before = snapshot();
  const again = io();
  assert.equal(await run(["init", ...ALL, "--key", KEY], ctx, again), 0);
  assert.deepEqual(snapshot(), before);
  assert.ok(again.lines.filter((l) => l.includes("already set up")).length >= 7);

  await run(["init", "--agent", "cursor", "--agent", "hermes", "--key", KEY2], ctx, io());
  assert.equal(json(ctx, ".cursor/mcp.json").mcpServers.wavebrain.headers.Authorization, `Bearer ${KEY2}`);
  assert.match(read(ctx, ".hermes/.env"), /WAVEBRAIN_API_KEY=al_B/);
  assert.doesNotMatch(read(ctx, ".hermes/.env"), /al_A/);
});

test("remove undoes exactly what init added", async () => {
  const ctx = sandbox();
  const originals = {
    ".claude.json": JSON.stringify({ numStartups: 3 }, null, 2) + "\n",
    ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] } }, null, 2) + "\n",
    ".codex/config.toml": 'model = "o3"\n',
    ".hermes/config.yaml": "model: x\nmcp_servers:\n  github:\n    command: npx\n",
    ".hermes/.env": "OPENAI_API_KEY=sk\n",
  };
  for (const [f, t] of Object.entries(originals)) write(ctx, f, t);
  await run(["init", ...ALL, "--key", KEY], ctx, io());
  assert.equal(await run(["remove", "--yes"], ctx, io()), 0);

  for (const [f, t] of Object.entries(originals)) assert.equal(read(ctx, f), t, f);
  // Files init created are gone again.
  for (const f of [".cursor/mcp.json", ".codeium/windsurf/mcp_config.json", "Library/Application Support/Code/User/mcp.json"]) {
    assert.ok(!has(ctx, f), f);
  }
  assert.ok(!has(ctx, ".wavebrain/installed.json"));
});

test("init leaves servers it didn't add alone, and remove doesn't touch them", async () => {
  const ctx = sandbox();
  const mine = JSON.stringify({ mcpServers: { wavebrain: { url: "https://self-hosted" } } });
  write(ctx, ".cursor/mcp.json", mine);
  write(ctx, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["mcp__wavebrain__*"] } }));
  const out = io();
  assert.equal(await run(["init", "--agent", "cursor", "--agent", "claude-code", "--key", KEY], ctx, out), 1);
  assert.match(out.lines.join("\n"), /! Cursor: a "wavebrain" server is already in ~\/.cursor\/mcp.json/);
  assert.equal(read(ctx, ".cursor/mcp.json"), mine);
  await run(["remove", "--yes"], ctx, io());
  assert.equal(read(ctx, ".cursor/mcp.json"), mine);
  // The permission rule was already there, so it stays.
  assert.deepEqual(json(ctx, ".claude/settings.json").permissions.allow, ["mcp__wavebrain__*"]);
});

test("--dry-run writes nothing", async () => {
  const ctx = sandbox();
  write(ctx, ".codex/config.toml", 'model = "o3"\n');
  const out = io();
  assert.equal(await run(["init", ...ALL, "--key", KEY, "--dry-run"], ctx, out), 0);
  assert.equal(read(ctx, ".codex/config.toml"), 'model = "o3"\n');
  assert.deepEqual(fs.readdirSync(ctx.home).sort(), [".codex", "bin"]);
  assert.match(out.lines.join("\n"), /would update ~\/.codex\/config.toml/);
});

test("key from WAVEBRAIN_API_KEY: Codex references the env var instead of storing it", async () => {
  const ctx = sandbox();
  ctx.env.WAVEBRAIN_API_KEY = KEY;
  assert.equal(await run(["init", "--agent", "codex"], ctx, io()), 0);
  const toml = read(ctx, ".codex/config.toml");
  assert.match(toml, /bearer_token_env_var = "WAVEBRAIN_API_KEY"/);
  assert.doesNotMatch(toml, /al_/);
});

test("Hermes profiles are separate targets", async () => {
  const ctx = sandbox();
  write(ctx, ".hermes/config.yaml", "model: x\n");
  write(ctx, ".hermes/profiles/coder/config.yaml", "model: y\n");
  await run(["init", "--agent", "hermes:coder", "--key", KEY], ctx, io());
  assert.match(read(ctx, ".hermes/profiles/coder/config.yaml"), /wavebrain:/);
  assert.match(read(ctx, ".hermes/profiles/coder/.env"), /WAVEBRAIN_API_KEY=/);
  assert.equal(read(ctx, ".hermes/config.yaml"), "model: x\n");
  const out = io();
  await run(["status"], ctx, out);
  assert.match(out.lines.join("\n"), /Hermes Agent \(profile coder\)\s+yes\s+configured \(by wavebrain init\)/);
});

test("interactive: nothing is preselected, and the user's picks are used", async () => {
  const ctx = sandbox();
  fs.mkdirSync(path.join(ctx.home, ".cursor"));
  fs.mkdirSync(path.join(ctx.home, ".codeium/windsurf"), { recursive: true });
  fs.writeFileSync(path.join(ctx.env.PATH, "claude"), "");

  const none = io(["", KEY]);
  assert.equal(await run(["init"], ctx, none), 0);
  assert.match(none.lines.join("\n"), /Nothing selected/);
  assert.deepEqual(fs.readdirSync(ctx.home).sort(), [".codeium", ".cursor", "bin"]);

  // Detected: 1) Claude Code 2) Cursor 3) Windsurf. Pick Claude Code, decline the permission.
  const some = io(["1", KEY, "n"]);
  assert.equal(await run(["init"], ctx, some), 0);
  assert.match(some.lines.join("\n"), /1\) Claude Code\n {2}2\) Cursor\n {2}3\) Windsurf/);
  assert.ok(json(ctx, ".claude.json").mcpServers.wavebrain);
  assert.equal(json(ctx, ".claude/settings.json").permissions, undefined);
  assert.ok(json(ctx, ".claude/settings.json").hooks.PostToolUse);
  assert.ok(!has(ctx, ".cursor/mcp.json"));
});

test("auto-capture: hooks, skills and the Hermes plugin are installed and removed cleanly", async () => {
  const ctx = sandbox();
  write(ctx, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "my-own-hook" }] }] } }, null, 2) + "\n");
  write(ctx, ".cursor/hooks.json", JSON.stringify({ version: 1, hooks: { stop: [{ command: "mine" }] } }, null, 2) + "\n");
  write(ctx, ".codex/config.toml", 'model = "o3"\n');
  const before = { codex: read(ctx, ".codex/hooks.json"), cursor: read(ctx, ".cursor/hooks.json"), toml: read(ctx, ".codex/config.toml") };

  assert.equal(await run(["init", ...ALL, "--key", KEY], ctx, io()), 0);
  const cc = json(ctx, ".claude/settings.json").hooks;
  assert.match(cc.PostToolUse[0].hooks[0].command, /\.wavebrain\/hooks\/hook\.mjs" claude-code observe$/);
  assert.equal(cc.PostToolUse[0].matcher, "Bash|mcp__.*");
  assert.match(cc.Stop[0].hooks[0].command, /claude-code flush$/);
  assert.ok(has(ctx, ".claude/skills/wavebrain/SKILL.md"));

  const cx = json(ctx, ".codex/hooks.json").hooks;
  assert.equal(cx.Stop.length, 2, "user's own Stop hook kept");
  assert.match(cx.PostToolUse[0].hooks[0].command, /codex observe$/);
  assert.match(read(ctx, ".codex/config.toml"), /^model = "o3"\n\n\[features\] # added by wavebrain init\nhooks = true/);
  assert.ok(has(ctx, ".codex/skills/wavebrain/SKILL.md"));

  const cu = json(ctx, ".cursor/hooks.json");
  assert.equal(cu.version, 1);
  assert.deepEqual(cu.hooks.stop.map((h) => h.command.endsWith("cursor flush") || h.command), ["mine", true]);

  for (const f of ["__init__.py", "plugin.yaml", "rules.json"]) assert.ok(has(ctx, `.hermes/plugins/wavebrain/${f}`), f);
  for (const f of ["hook.mjs", "core.mjs", "rules.json"]) assert.ok(has(ctx, `.wavebrain/hooks/${f}`), f);
  const cfg = json(ctx, ".wavebrain/config.json");
  assert.equal(cfg.apiKey, KEY);
  assert.equal(cfg.apiUrl, "https://getwavebrain.com/api/v1/actions");
  assert.equal(fs.statSync(path.join(ctx.home, ".wavebrain/config.json")).mode & 0o777, 0o600);

  // Idempotent, and the staged hook actually runs.
  const snap = () => [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml", ".cursor/hooks.json"].map((f) => read(ctx, f));
  const s1 = snap();
  await run(["init", ...ALL, "--key", KEY], ctx, io());
  assert.deepEqual(snap(), s1);

  assert.equal(await run(["remove", "--yes"], ctx, io()), 0);
  assert.equal(read(ctx, ".codex/hooks.json"), before.codex);
  assert.equal(read(ctx, ".cursor/hooks.json"), before.cursor);
  assert.equal(read(ctx, ".codex/config.toml"), before.toml);
  assert.ok(!has(ctx, ".claude/settings.json"));
  assert.ok(!has(ctx, ".claude/skills/wavebrain/SKILL.md"));
  assert.ok(!has(ctx, ".hermes/plugins/wavebrain/__init__.py"));
  assert.ok(!has(ctx, ".wavebrain/config.json"));
  assert.ok(!has(ctx, ".wavebrain/hooks/hook.mjs"));
});

test("--no-hooks installs the MCP server only", async () => {
  const ctx = sandbox();
  assert.equal(await run(["init", "--agent", "codex", "--agent", "cursor", "--no-hooks", "--key", KEY], ctx, io()), 0);
  assert.ok(!has(ctx, ".codex/hooks.json"));
  assert.ok(!has(ctx, ".cursor/hooks.json"));
  assert.ok(!has(ctx, ".wavebrain/config.json"));
  assert.doesNotMatch(read(ctx, ".codex/config.toml"), /\[features\]/);
});

test("interactive: Enter at the key prompt opens the setup page", async () => {
  const ctx = sandbox();
  const out = io(["", KEY]);
  out.interactive = true;
  assert.equal(await run(["init", "--agent", "cursor"], ctx, out), 0);
  assert.ok(out.lines.includes("[opened browser]"));
});

test("rejects bad input without writing", async () => {
  const ctx = sandbox();
  assert.equal(await run(["init", "--agent", "cursor", "--key", "sk-not-ours"], ctx, io()), 2);
  assert.equal(await run(["init", "--agent", "nope", "--key", KEY], ctx, io()), 2);
  assert.equal(await run(["init", "--key", KEY], ctx, io()), 2); // not a terminal, no --agent
  assert.equal(await run(["init", "--agent", "cursor"], ctx, io()), 2); // no key
  assert.deepEqual(fs.readdirSync(ctx.home), ["bin"]);
});

test("Linux and Windows paths", async () => {
  const linux = sandbox("linux");
  await run(["init", "--agent", "claude-desktop", "--agent", "vscode", "--key", KEY], linux, io());
  assert.ok(has(linux, ".config/Claude/claude_desktop_config.json"));
  assert.ok(has(linux, ".config/Code/User/mcp.json"));

  const win = sandbox("win32");
  win.env.APPDATA = path.join(win.home, "Roaming");
  await run(["init", "--agent", "claude-desktop", "--key", KEY], win, io());
  assert.ok(has(win, "Roaming/Claude/claude_desktop_config.json"));
});
