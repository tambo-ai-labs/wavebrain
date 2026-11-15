import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bufferToolCall, flush, flushToolCalls, fromHookInput, mcpToolCall, observe, toolCallsFile, toolCallsUrl } from "../shared/core.mjs";

const sandbox = (extra = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-tc-"));
  return { WAVEBRAIN_HOME: dir, WAVEBRAIN_API_KEY: "al_test_key_000000000000000000", HOME: dir, ...extra };
};
const recorder = (status = 201) => {
  const calls = [];
  const f = async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: status < 300, status });
  return { calls, f };
};
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const batches = (env) => fs.readdirSync(path.join(env.WAVEBRAIN_HOME, "tool-calls")).filter((n) => n.startsWith("batch-"));

test("recognizes MCP tools from every host and skips WaveBrain's own and non-MCP tools", () => {
  assert.deepEqual(mcpToolCall("mcp__github__list_issues", {}), { server: "github", tool: "list_issues" });
  assert.deepEqual(mcpToolCall("mcp__claude_ai_Gmail__search_threads", {}), { server: "claude_ai_Gmail", tool: "search_threads" });
  assert.deepEqual(mcpToolCall("MCP", { server: "linear", toolName: "get_issue", arguments: { id: 1 } }), { server: "linear", tool: "get_issue" });
  assert.deepEqual(mcpToolCall("MCP:get_issue", {}), { server: "mcp", tool: "get_issue" });
  for (const n of ["mcp__wavebrain__log_action", "mcp__plugin_wavebrain_wavebrain__list_actions", "MCP:log_action", "Bash", "Read", "Edit"]) {
    assert.equal(mcpToolCall(n, {}), null, n);
  }
});

test("buffers names, status and duration only, never arguments or results", async () => {
  const env = sandbox();
  const ev = fromHookInput("claude-code", {
    session_id: "s1",
    hook_event_name: "PostToolUseFailure",
    tool_name: "mcp__stripe__create_refund",
    tool_input: { amount: 5000, customer: "cus_secret" },
    tool_response: { content: [{ type: "text", text: "secret result" }] },
    duration_ms: 812.4,
    error: "boom",
  });
  await observe(ev, { env, fetchImpl: async () => assert.fail("no network for a small buffer") });
  const [c] = lines(toolCallsFile("claude-code", "s1", env));
  assert.deepEqual(Object.keys(c).sort(), ["agent", "client_name", "duration_ms", "occurred_at", "server", "status", "tool"]);
  assert.equal(c.server, "stripe");
  assert.equal(c.tool, "create_refund");
  assert.equal(c.status, "error");
  assert.equal(c.duration_ms, 812);
  assert.doesNotMatch(fs.readFileSync(toolCallsFile("claude-code", "s1", env), "utf8"), /cus_secret|secret result|5000/);
});

test("non-MCP tools and WAVEBRAIN_TOOL_CALLS=off record nothing", async () => {
  const env = sandbox();
  await observe({ host: "codex", session: "s", toolName: "Bash", toolInput: { command: "ls" } }, { env });
  assert.equal(fs.existsSync(path.join(env.WAVEBRAIN_HOME, "tool-calls")), false);
  const off = sandbox({ WAVEBRAIN_TOOL_CALLS: "off" });
  await observe({ host: "codex", session: "s", toolName: "mcp__github__list_issues", toolInput: {} }, { env: off });
  assert.equal(fs.existsSync(path.join(off.WAVEBRAIN_HOME, "tool-calls")), false);
});

test("a turn's Stop keeps a small buffer; SessionEnd sends it as one batch", async () => {
  const env = sandbox();
  const t = Date.parse("2026-11-15T12:00:00Z");
  for (let i = 0; i < 3; i++) await bufferToolCall({ host: "claude-code", session: "s", toolName: "mcp__github__list_issues", toolInput: {} }, { env, now: t + i });
  const r = recorder();
  await flush({ host: "claude-code", session: "s", event: "Stop" }, { env, now: t + 1000, fetchImpl: r.f });
  assert.equal(r.calls.length, 0);
  await flush({ host: "claude-code", session: "s", event: "SessionEnd" }, { env, now: t + 2000, fetchImpl: r.f });
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, "https://getwavebrain.com/api/v1/tool-calls");
  assert.equal(r.calls[0].body.calls.length, 3);
  assert.match(r.calls[0].body.batch_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(batches(env), []);
  assert.equal(fs.existsSync(toolCallsFile("claude-code", "s", env)), false);
});

test("sends once a buffer is big or old, in batches of at most 500", async () => {
  const env = sandbox();
  const t = Date.parse("2026-11-15T12:00:00Z");
  const file = toolCallsFile("codex", "s", env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const call = (at) => JSON.stringify({ agent: "codex", server: "github", tool: "x", status: "success", occurred_at: new Date(at).toISOString() });
  fs.writeFileSync(file, Array.from({ length: 1200 }, () => call(t)).join("\n") + "\n");
  const r = recorder();
  await flush({ host: "codex", session: "other", event: "Stop" }, { env, now: t + 1000, fetchImpl: r.f });
  assert.deepEqual(r.calls.map((c) => c.body.calls.length).sort(), [200, 500, 500]);

  // An old buffer from an abandoned session goes out on any later turn.
  fs.writeFileSync(toolCallsFile("codex", "old", env), call(t) + "\n");
  await flush({ host: "codex", session: "new", event: "Stop" }, { env, now: t + 11 * 60_000, fetchImpl: r.f });
  assert.equal(r.calls.length, 4);
});

test("a failed send keeps the batch and its id; the retry reuses it", async () => {
  const env = sandbox();
  await bufferToolCall({ host: "cursor", session: "s", toolName: "MCP:get_issue", toolInput: {} }, { env });
  const down = recorder(503);
  await flushToolCalls({ host: "cursor", session: "s", force: true }, { env, fetchImpl: down.f });
  assert.equal(batches(env).length, 1);
  const up = recorder();
  await flushToolCalls({ host: "cursor", session: "s", force: true }, { env, fetchImpl: up.f });
  assert.equal(up.calls[0].body.batch_id, down.calls[0].body.batch_id);
  assert.deepEqual(batches(env), []);
});

test("without a key, batches wait on disk; a rejected batch is dropped", async () => {
  const env = sandbox({ WAVEBRAIN_API_KEY: "" });
  await bufferToolCall({ host: "codex", session: "s", toolName: "mcp__github__list_issues", toolInput: {} }, { env });
  await flushToolCalls({ host: "codex", session: "s", force: true }, { env, fetchImpl: async () => assert.fail("no fetch without a key") });
  assert.equal(batches(env).length, 1);
  const bad = recorder(400);
  await flushToolCalls({ host: "codex", session: "s" }, { env: { ...env, WAVEBRAIN_API_KEY: "al_test_key_000000000000000000" }, fetchImpl: bad.f });
  assert.deepEqual(batches(env), []);
});

test("the tool-calls URL follows the configured actions URL", () => {
  assert.equal(toolCallsUrl("http://localhost:3000/api/v1/actions", {}), "http://localhost:3000/api/v1/tool-calls");
  assert.equal(toolCallsUrl("x", { WAVEBRAIN_TOOL_CALLS_URL: "http://y/tc" }), "http://y/tc");
});
