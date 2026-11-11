// The per-agent installers (wavebrain-claude-code, -codex, -cursor, -hermes) against a temporary HOME.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { runHarness } from "../src/harness.mjs";

const KEY = "al_" + "A".repeat(32);

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wavebrain-harness-"));
  fs.mkdirSync(path.join(home, "bin"));
  return { home, env: { PATH: path.join(home, "bin") }, platform: "darwin" };
}
function io(answers = []) {
  const lines = [];
  const q = [...answers];
  return {
    lines,
    text: () => lines.join("\n"),
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
};
const read = (ctx, rel) => fs.readFileSync(path.join(ctx.home, rel), "utf8");
const has = (ctx, rel) => fs.existsSync(path.join(ctx.home, rel));

test("each installer only touches its own agent", async () => {
  const ctx = sandbox();
  write(ctx, ".codex/config.toml", 'model = "o3"\n');
  write(ctx, ".hermes/config.yaml", "model: x\n");
  const out = io();
  assert.equal(await runHarness("cursor", ["install", "--key", KEY], ctx, out), 0);
  assert.match(read(ctx, ".cursor/mcp.json"), /wavebrain/);
  assert.ok(has(ctx, ".cursor/hooks.json"));
  assert.ok(!has(ctx, ".claude.json"));
  assert.equal(read(ctx, ".codex/config.toml"), 'model = "o3"\n');
  assert.doesNotMatch(read(ctx, ".hermes/config.yaml"), /wavebrain/);
  assert.match(out.text(), /Undo with: npx wavebrain-cursor uninstall/);
  assert.ok(!out.text().includes(KEY));
});

test("install is the default command; uninstall keeps the hook runner while another agent needs it", async () => {
  const ctx = sandbox();
  write(ctx, ".hermes/config.yaml", "model: x\n");
  assert.equal(await runHarness("cursor", ["--key", KEY], ctx, io()), 0);
  assert.equal(await runHarness("hermes", ["install", "--key", KEY, "--yes"], ctx, io()), 0);
  assert.ok(has(ctx, ".cursor/hooks.json"));
  assert.ok(has(ctx, ".wavebrain/config.json"));

  assert.equal(await runHarness("cursor", ["uninstall", "--yes"], ctx, io()), 0);
  assert.ok(!has(ctx, ".cursor/mcp.json"));
  assert.ok(!has(ctx, ".cursor/hooks.json"));
  assert.ok(has(ctx, ".wavebrain/config.json"), "Hermes still uses the shared config");
  assert.match(read(ctx, ".hermes/config.yaml"), /wavebrain/);

  const st = io();
  assert.equal(await runHarness("hermes", ["status"], ctx, st), 0);
  assert.match(st.text(), /Hermes Agent\s+\S+\s+configured \(by WaveBrain\)/);
  assert.doesNotMatch(st.text(), /Cursor/);

  assert.equal(await runHarness("hermes", ["uninstall", "--yes"], ctx, io()), 0);
  assert.ok(!has(ctx, ".wavebrain"), "last agent gone: hook runner, key and state removed");
});

test("uninstall with nothing installed says so; removed harnesses aren't installers", async () => {
  const ctx = sandbox();
  const out = io();
  assert.equal(await runHarness("cursor", ["uninstall", "--yes"], ctx, out), 0);
  assert.match(out.text(), /Nothing to remove/);
  await assert.rejects(() => runHarness("codex", ["install"], ctx, io()), /unknown harness/);
});

test("hermes: --profile, default, --all-profiles, and the interactive picker", async () => {
  const ctx = sandbox();
  write(ctx, ".hermes/config.yaml", "model: x\n");
  write(ctx, ".hermes/profiles/coder/config.yaml", "model: y\n");
  write(ctx, ".hermes/profiles/writer/config.yaml", "model: z\n");

  assert.equal(await runHarness("hermes", ["install", "--profile", "coder", "--key", KEY], ctx, io()), 0);
  assert.match(read(ctx, ".hermes/profiles/coder/config.yaml"), /wavebrain:/);
  assert.doesNotMatch(read(ctx, ".hermes/config.yaml"), /wavebrain/);
  assert.ok(has(ctx, ".hermes/profiles/coder/plugins/wavebrain/__init__.py"));

  // Not a terminal and no --profile: the default profile only.
  assert.equal(await runHarness("hermes", ["install", "--key", KEY], ctx, io()), 0);
  assert.match(read(ctx, ".hermes/config.yaml"), /wavebrain:/);
  assert.doesNotMatch(read(ctx, ".hermes/profiles/writer/config.yaml"), /wavebrain/);

  // Picker: list is default, coder, writer; pick 3.
  const pick = io(["3"]);
  assert.equal(await runHarness("hermes", ["install", "--key", KEY, "--yes"], ctx, pick), 0);
  assert.match(read(ctx, ".hermes/profiles/writer/config.yaml"), /wavebrain:/);

  const bad = io();
  assert.equal(await runHarness("hermes", ["install", "--profile", "nope", "--key", KEY], ctx, bad), 2);
  assert.match(bad.text(), /No Hermes profile "nope"/);

  // Uninstall with no --profile removes every profile WaveBrain touched.
  assert.equal(await runHarness("hermes", ["uninstall", "--yes"], ctx, io()), 0);
  for (const f of [".hermes/config.yaml", ".hermes/profiles/coder/config.yaml", ".hermes/profiles/writer/config.yaml"]) {
    assert.doesNotMatch(read(ctx, f), /wavebrain/, f);
  }
  assert.ok(!has(ctx, ".hermes/profiles/coder/plugins/wavebrain"));

  assert.equal(await runHarness("hermes", ["install", "--all-profiles", "--key", KEY], ctx, io()), 0);
  for (const f of [".hermes/config.yaml", ".hermes/profiles/coder/config.yaml", ".hermes/profiles/writer/config.yaml"]) {
    assert.match(read(ctx, f), /wavebrain:/, f);
  }
});

test("options: --profile is Hermes-only, unknown flags print help, --no-hooks, --dry-run", async () => {
  const ctx = sandbox();
  const a = io();
  assert.equal(await runHarness("cursor", ["install", "--profile", "x"], ctx, a), 2);
  const b = io();
  assert.equal(await runHarness("cursor", ["install", "--agent", "codex"], ctx, b), 2);
  assert.match(b.text(), /Usage:\n  npx wavebrain-cursor install/);

  assert.equal(await runHarness("cursor", ["install", "--no-hooks", "--key", KEY], ctx, io()), 0);
  assert.ok(!has(ctx, ".cursor/hooks.json"));
  assert.ok(!has(ctx, ".wavebrain/config.json"));

  const ctx2 = sandbox();
  assert.equal(await runHarness("cursor", ["install", "--dry-run", "--key", KEY], ctx2, io()), 0);
  assert.ok(!has(ctx2, ".cursor"));

  const h = io();
  assert.equal(await runHarness("hermes", ["--help"], ctx, h), 0);
  assert.match(h.text(), /--all-profiles/);
});
