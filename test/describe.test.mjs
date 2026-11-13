// Readable entries: every rule's describer against shared fixtures (test/fixtures/describe.json).
// The Hermes plugin runs the same fixtures in test/test_hermes.py, so both runtimes stay in sync.
//   node test/describe.test.mjs --update   rewrite the expectations from shared/core.mjs (then review the diff)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, failureReason, loadRules, observe, queueFile, words } from "../shared/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test/fixtures/describe.json");
const fx = JSON.parse(fs.readFileSync(FIXTURES, "utf8"));
const rules = loadRules();

export function lookups(c) {
  const files = c.files ?? {};
  return {
    now: fx.now,
    home: fx.home,
    git: (args) => {
      const k = args.join(" ");
      if (!(k in (c.git ?? {}))) throw new Error(`git ${k}: not a git repository`);
      return c.git[k];
    },
    readFile: (f) => files[f] ?? null,
    listDir: (d) => [...new Set(Object.keys(files).filter((f) => f.startsWith(d + "/")).map((f) => f.slice(d.length + 1).split("/")[0]))],
  };
}

const run = (c) => classify(rules, c.event, lookups(c));

if (process.argv.includes("--update")) {
  for (const c of fx.cases) {
    const r = run(c);
    c.expect = r && { title: r.title, status: r.status, details: r.details };
  }
  fs.writeFileSync(FIXTURES, JSON.stringify(fx, null, 2) + "\n");
  console.log(`updated ${fx.cases.length} cases`);
  process.exit(0);
} else {
  for (const c of fx.cases) {
    test(`describe: ${c.name}`, () => {
      const r = run(c);
      assert.ok("expect" in c, "no expectation; run with --update");
      assert.deepEqual(r && { title: r.title, status: r.status, details: r.details }, c.expect);
      if (!r) return;
      assert.ok(r.title.length <= 120, "title too long");
      assert.doesNotMatch(r.title, /`/);
      for (const s of c.absent ?? []) assert.ok(!JSON.stringify(r).includes(s), `leaked ${s}`);
      if (c.event.failed) assert.equal(r.status, "failure");
      if (r.status === "failure") assert.match(r.details, /^Failed: /);
      if (c.event.toolName === "Bash") assert.match(r.details.split("\n").pop(), /^Command: `/);
    });
  }
}

test("the Hermes plugin passes the same fixtures (python3 test/test_hermes.py)", () => {
  execFileSync("python3", ["test/test_hermes.py"], { cwd: ROOT, stdio: "pipe" });
});

test("helpers: word split, failure reasons", () => {
  assert.deepEqual(words(`gh pr create --title "Fix it" -b 'a b'`), ["gh", "pr", "create", "--title", "Fix it", "-b", "a b"]);
  assert.equal(failureReason("ok\nerror: boom\nhint: x"), "error: boom");
  assert.equal(failureReason("", 2), "exited with code 2");
  assert.equal(failureReason("", 0), null);
});

test("real git: a push to a local remote is described from the reflog, then from the output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-push-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = path.join(dir, "shop");
  const g = (...a) => execFileSync("git", a, { cwd: repo, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", path.join(dir, "remote.git")]);
  fs.mkdirSync(repo);
  g("init", "-q", "-b", "main");
  g("remote", "add", "origin", path.join(dir, "remote.git"));
  fs.writeFileSync(path.join(repo, "a.txt"), "1\n");
  g("add", ".");
  g("commit", "-q", "-m", "First");
  g("push", "-q", "-u", "origin", "main");
  for (const [i, s] of ["Add cart", "Fix totals"].entries()) {
    fs.writeFileSync(path.join(repo, `f${i}.txt`), "x\ny\n");
    g("add", ".");
    g("commit", "-q", "-m", s);
  }
  g("push", "-q", "origin", "main");
  const r = classify(rules, { toolName: "Bash", toolInput: { command: "git push -q origin main" }, cwd: repo });
  assert.equal(r.title, "Pushed 2 commits to shop/main: Fix totals");
  assert.match(r.details, /- Add cart/);
  assert.match(r.details, /\+4\/−0 lines in 2 files/);
  // A commit, described from git.
  fs.writeFileSync(path.join(repo, "b.txt"), "z\n");
  g("add", ".");
  const out = g("commit", "-m", "Add b");
  const c = classify(rules, { toolName: "Bash", toolInput: { command: 'git commit -m "Add b"' }, cwd: repo, output: out });
  assert.equal(c.title, "Committed to shop/main: Add b");
  assert.match(c.details, /Files: b\.txt/);
  // Not a repo: the old title.
  const n = classify(rules, { toolName: "Bash", toolInput: { command: "git push -q origin main" }, cwd: dir });
  assert.equal(n.title, "Pushed to git: git push -q origin main");
});

test("observe sends the describer's status and the hook's output", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "wb-obs-"));
  const env = { WAVEBRAIN_HOME: home, HOME: home, WAVEBRAIN_API_KEY: "" };
  const c = fx.cases.find((x) => x.name === "curl generic, HTTP 404");
  const item = await observe({ host: "claude-code", session: "s", ...c.event }, { env, lookups: lookups(c) });
  assert.equal(item.payload.status, "failure");
  assert.equal(item.payload.title, c.expect.title);
  assert.ok(fs.existsSync(queueFile("claude-code", "s", env)));
});
