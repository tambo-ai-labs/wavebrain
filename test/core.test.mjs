import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, flush, fromHookInput, loadRules, observe, queueFile, redact } from "../shared/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rules = loadRules();
const sh = (command) => classify(rules, { toolName: "Bash", toolInput: { command } });
const sandbox = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-core-"));
  return { WAVEBRAIN_HOME: dir, WAVEBRAIN_API_KEY: "al_test_key_000000000000000000", HOME: dir };
};
const okFetch = (calls) => async (url, init) => (calls.push({ url, body: JSON.parse(init.body), auth: init.headers.authorization }), { ok: true, status: 201 });

test("records high-stakes shell commands and skips the rest", () => {
  assert.equal(sh("git push origin main").type, "push");
  assert.equal(sh("vercel --prod").type, "deploy");
  assert.equal(sh("npx vercel deploy --prebuilt").type, "deploy");
  assert.equal(sh("npm publish --access public").type, "publish");
  assert.equal(sh("gh pr merge 12 --squash").type, "merge");
  assert.equal(sh("pnpm db:migrate").type, "database");
  assert.equal(sh("curl -s -X POST https://api.example.com/x").type, "api_call");
  for (const c of ["ls -la", "git status", "git diff", "vercel ls", "vercel env ls", "npm test", "curl https://example.com", "cat README.md"]) {
    assert.equal(sh(c), null, c);
  }
});

test("titles name only the matching part of a compound command", () => {
  const a = sh("cd ~/app && pnpm build && vercel --prod --yes; echo done");
  assert.equal(a.title, "Deployed with Vercel: vercel --prod --yes");
  assert.match(a.details, /cd ~\/app && pnpm build && vercel --prod --yes; echo done/);
});

test("redacts secrets everywhere", () => {
  const a = sh("STRIPE_KEY=sk_live_51abcdefghijklmnopqrst vercel env add X production --token abcdef1234567890xyz");
  assert.doesNotMatch(JSON.stringify(a), /sk_live_51abc|abcdef1234567890xyz/);
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop1234"), "Authorization: Bearer [redacted]");
  assert.equal(redact("postgres://user:hunter2@db.example.com/x"), "postgres://[redacted]@db.example.com/x");
  assert.equal(redact("password=hunter2 next"), "password=[redacted] next");
  assert.match(redact("npm_abcdefghijklmnopqrstuvwxyz0123456789"), /^\[redacted\]$/);
});

test("MCP write tools are recorded, reads and our own servers are not", () => {
  assert.equal(classify(rules, { toolName: "mcp__stripe__create_refund", toolInput: { amount: 5 } }).type, "api_call");
  assert.equal(classify(rules, { toolName: "mcp__github__list_issues", toolInput: {} }), null);
  assert.equal(classify(rules, { toolName: "mcp__wavebrain__log_action", toolInput: {} }), null);
  assert.equal(classify(rules, { toolName: "mcp__claude-in-chrome__computer", toolInput: {} }), null);
});

test("observe queues locally; flush sends and empties the queue", async () => {
  const env = sandbox();
  await observe({ host: "claude-code", session: "s1", toolName: "Bash", toolInput: { command: "git push" }, cwd: "/x/myapp" }, { env });
  const q = queueFile("claude-code", "s1", env);
  assert.equal(fs.readFileSync(q, "utf8").trim().split("\n").length, 1);
  const calls = [];
  const r = await flush({ host: "claude-code", session: "s1" }, { env, fetchImpl: okFetch(calls) });
  assert.deepEqual(r, { sent: 1, skipped: 0, kept: 0 });
  assert.equal(calls[0].body.agent, "claude-code");
  assert.equal(calls[0].body.project, "myapp");
  assert.equal(calls[0].body.metadata.source, "wavebrain-hook");
  assert.match(calls[0].auth, /^Bearer al_test_key/);
  assert.equal(fs.existsSync(q), false);
});

test("an action the agent logged itself is not sent twice", async () => {
  const env = sandbox();
  const t = 1_000_000;
  await observe({ host: "codex", session: "s", toolName: "Bash", toolInput: { command: "vercel --prod" } }, { env, now: t });
  await observe({ host: "codex", session: "s", toolName: "mcp__wavebrain__log_action", toolInput: {} }, { env, now: t + 1000 });
  await observe({ host: "codex", session: "s", toolName: "Bash", toolInput: { command: "git push" } }, { env, now: t + 2000 });
  const calls = [];
  const r = await flush({ host: "codex", session: "s" }, { env, now: t + 3000, fetchImpl: okFetch(calls) });
  assert.deepEqual(r, { sent: 1, skipped: 1, kept: 0 });
  assert.equal(calls[0].body.type, "push");
});

test("failed uploads stay queued and duplicates collapse", async () => {
  const env = sandbox();
  for (let i = 0; i < 2; i++) await observe({ host: "cursor", session: "s", toolName: "Shell", toolInput: { command: "git push" } }, { env, now: 5000 });
  const r = await flush({ host: "cursor", session: "s" }, { env, now: 6000, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.deepEqual(r, { sent: 0, skipped: 1, kept: 1 });
  const r2 = await flush({ host: "cursor", session: "s" }, { env, now: 7000, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(r2.kept, 1);
});

test("without a key nothing is sent and nothing is lost", async () => {
  const env = { ...sandbox(), WAVEBRAIN_API_KEY: "" };
  await observe({ host: "claude-code", session: "s", toolName: "Bash", toolInput: { command: "git push" } }, { env });
  const r = await flush({ host: "claude-code", session: "s" }, { env, fetchImpl: async () => assert.fail("no fetch without a key") });
  assert.equal(r.kept, 1);
});

test("WAVEBRAIN_HOOKS=off turns capture off", async () => {
  const env = { ...sandbox(), WAVEBRAIN_HOOKS: "off" };
  assert.equal(await observe({ host: "x", session: "s", toolName: "Bash", toolInput: { command: "git push" } }, { env }), null);
});

test("normalizes Claude Code, Codex and Cursor hook payloads", () => {
  assert.deepEqual(fromHookInput("claude-code", { session_id: "a", tool_name: "Bash", tool_input: { command: "x" }, cwd: "/p" }).session, "a");
  const cur = fromHookInput("cursor", { conversation_id: "c", tool_name: "Shell", tool_input: { command: "git push" }, workspace_roots: ["/w"] });
  assert.equal(cur.session, "c");
  assert.equal(cur.cwd, "/w");
  assert.equal(fromHookInput("claude-code", { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "git push" }, error: "Exit code 128" }).failed, true);
  assert.equal(fromHookInput("codex", { tool_name: "Bash", tool_input: { command: "git push" }, tool_response: "fatal: 'origin' does not appear to be a git repository\n" }).failed, true);
  assert.equal(fromHookInput("codex", { tool_name: "Bash", tool_input: { command: "git push" }, tool_response: "To github.com:x/y.git\n   a..b  main -> main\n" }).failed, false);
  assert.equal(fromHookInput("codex", { tool_name: "Bash", tool_input: { command: "npm run build" }, tool_response: "warning: 1 error: fixed\nBuild ok\n" }).failed, false);
  assert.equal(fromHookInput("codex", { tool_name: "Bash", tool_input: { command: ["git", "push"] }, tool_response: { exit_code: 1 } }).failed, true);
});

test("hook.mjs never fails the agent, even on garbage input", () => {
  const env = { ...process.env, ...sandbox() };
  for (const input of ["not json", "", '{"tool_name":"Bash","tool_input":{"command":"git push"}}']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "shared/hook.mjs"), "claude-code", "observe"], { input, env });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.length, 0);
  }
});

test("the Hermes plugin classifies like the Node core", () => {
  const py = `
import sys, json; sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "plugins"))})
import hermes as h
cmds = json.loads(sys.argv[1])
print(json.dumps([ (h.classify("terminal", {"command": c}) or {}).get("type") for c in cmds ]))`;
  const cmds = ["git push", "vercel --prod", "ls", "npm publish", "gh pr merge 3", "curl https://x.com", "cd a && vercel deploy; echo"];
  const out = JSON.parse(execFileSync("python3", ["-c", py, JSON.stringify(cmds)], { encoding: "utf8" }));
  assert.deepEqual(out, cmds.map((c) => sh(c)?.type ?? null));
});

test("every shipped copy matches shared/", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts/sync.mjs"), "--check"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});

test("Cursor's MCP:<tool> names: writes recorded, WaveBrain's own tools skipped, MCP:log_action counts as the agent's log", async () => {
  const { classify, loadRules, isAgentLog } = await import("../shared/core.mjs");
  const rules = loadRules();
  const w = classify(rules, { toolName: "MCP:create_refund", toolInput: { amount: 5 } });
  assert.equal(w?.rule, "mcp-write");
  assert.equal(classify(rules, { toolName: "MCP:search_docs", toolInput: {} }), null);
  assert.equal(classify(rules, { toolName: "MCP:start_session", toolInput: {} }), null);
  assert.equal(isAgentLog("MCP:log_action", {}), true);
  assert.equal(isAgentLog("MCP:create_refund", {}), false);
});
