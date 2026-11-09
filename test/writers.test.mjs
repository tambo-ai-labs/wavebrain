import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Conflict,
  envUpsert,
  jsonArrayAdd,
  jsonArrayRemove,
  jsonDelete,
  jsonSet,
  removeBlock,
  tomlUpsertServer,
  yamlUpsertServer,
} from "../src/files.mjs";

const lines = (n, name) => [`${name}:`, `${" ".repeat(n)}url: "https://x.test/api/mcp"`];

test("jsonSet adds, keeps other keys, and is idempotent", () => {
  const before = JSON.stringify({ theme: "dark", mcpServers: { other: { url: "u" } } });
  const once = jsonSet(before, ["mcpServers", "wavebrain"], { url: "w" }, "f");
  assert.deepEqual(JSON.parse(once), { theme: "dark", mcpServers: { other: { url: "u" }, wavebrain: { url: "w" } } });
  assert.equal(jsonSet(once, ["mcpServers", "wavebrain"], { url: "w" }, "f"), once);
  assert.deepEqual(JSON.parse(jsonSet(null, ["a", "b"], 1, "f")), { a: { b: 1 } });
});

test("jsonSet refuses JSON it can't parse", () => {
  assert.throws(() => jsonSet('{ // comment\n "a": 1 }', ["x"], 1, "f"), Conflict);
  assert.throws(() => jsonSet('{"mcpServers": []}', ["mcpServers", "wavebrain"], 1, "f"), Conflict);
});

test("jsonDelete removes only our key, and the file if it's then empty and was ours", () => {
  const t = JSON.stringify({ mcpServers: { wavebrain: {}, other: {} } });
  assert.deepEqual(JSON.parse(jsonDelete(t, ["mcpServers", "wavebrain"], "f")), { mcpServers: { other: {} } });
  const only = JSON.stringify({ mcpServers: { wavebrain: {} } });
  assert.equal(jsonDelete(only, ["mcpServers", "wavebrain"], "f", { deleteIfEmpty: true }), null);
  assert.deepEqual(JSON.parse(jsonDelete(only, ["mcpServers", "wavebrain"], "f")), { mcpServers: {} });
});

test("permission list add/remove keeps the user's rules", () => {
  const t = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, model: "x" });
  const added = jsonArrayAdd(t, ["permissions", "allow"], "mcp__wavebrain__*", "f");
  assert.deepEqual(JSON.parse(added).permissions.allow, ["Bash(ls:*)", "mcp__wavebrain__*"]);
  assert.equal(jsonArrayAdd(added, ["permissions", "allow"], "mcp__wavebrain__*", "f"), added);
  assert.deepEqual(JSON.parse(jsonArrayRemove(added, ["permissions", "allow"], "mcp__wavebrain__*", "f")), JSON.parse(t));
});

test("TOML: appends a marked block, replaces it on re-run, refuses a foreign server", () => {
  const user = 'model = "o3"\n\n[mcp_servers.other]\nurl = "u"\n';
  const once = tomlUpsertServer(user, "wavebrain", [["url", '"https://a"']]);
  assert.match(once, /# >>> wavebrain[^\n]*\n\[mcp_servers\.wavebrain\]\nurl = "https:\/\/a"\n# <<< wavebrain\n$/);
  assert.equal(tomlUpsertServer(once, "wavebrain", [["url", '"https://a"']]), once);
  const twice = tomlUpsertServer(once, "wavebrain", [["url", '"https://b"']]);
  assert.equal((twice.match(/mcp_servers\.wavebrain/g) ?? []).length, 1);
  assert.equal(removeBlock(twice), user);
  assert.throws(() => tomlUpsertServer('[mcp_servers.wavebrain]\nurl = "x"\n', "wavebrain", []), Conflict);
});

test("YAML: inserts under an existing mcp_servers with its indentation", () => {
  const user = "model: x\nmcp_servers:\n    github:\n        command: npx\nother: 1\n";
  const out = yamlUpsertServer(user, "wavebrain", lines);
  assert.match(out, /\nmcp_servers:\n {4}# >>> wavebrain[^\n]*\n {4}wavebrain:\n {8}url: "https:\/\/x.test\/api\/mcp"\n {4}# <<< wavebrain\n {4}github:/);
  assert.equal(yamlUpsertServer(out, "wavebrain", lines), out);
  assert.equal(removeBlock(out), user);
});

test("YAML: appends mcp_servers when missing, and restores an empty one", () => {
  const appended = yamlUpsertServer("model: x\n", "wavebrain", lines);
  assert.match(appended, /^model: x\n\n# >>> wavebrain[^\n]*\nmcp_servers:\n {2}wavebrain:\n/);
  assert.equal(removeBlock(appended), "model: x\n");

  const empty = "model: x\nmcp_servers: {}\n";
  const filled = yamlUpsertServer(empty, "wavebrain", lines);
  assert.match(filled, /\nmcp_servers:\n {2}wavebrain:/);
  assert.equal(removeBlock(filled), empty);
});

test("YAML: refuses a wavebrain server it didn't add, and flow-style maps", () => {
  assert.throws(() => yamlUpsertServer("mcp_servers:\n  wavebrain:\n    url: x\n", "wavebrain", lines), Conflict);
  assert.throws(() => yamlUpsertServer("mcp_servers: { a: { url: x } }\n", "wavebrain", lines), Conflict);
});

test(".env: adds a marked key, leaves an identical user value alone, refuses a different one", () => {
  const out = envUpsert("OPENAI_API_KEY=sk\n", "WAVEBRAIN_API_KEY", "al_1");
  assert.match(out, /^OPENAI_API_KEY=sk\n\n# >>> wavebrain[^\n]*\nWAVEBRAIN_API_KEY=al_1\n# <<< wavebrain\n$/);
  assert.equal(removeBlock(out), "OPENAI_API_KEY=sk\n");
  const rotated = envUpsert(out, "WAVEBRAIN_API_KEY", "al_2");
  assert.match(rotated, /WAVEBRAIN_API_KEY=al_2/);
  assert.doesNotMatch(rotated, /al_1/);
  const user = "WAVEBRAIN_API_KEY=al_1\n";
  assert.equal(envUpsert(user, "WAVEBRAIN_API_KEY", "al_1"), user);
  assert.throws(() => envUpsert(user, "WAVEBRAIN_API_KEY", "al_2"), Conflict);
});
