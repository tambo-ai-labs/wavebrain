"""Hermes plugin: readable entries against the shared fixtures (test/fixtures/describe.json), the same
ones shared/core.mjs passes, plus a real-git push and the tool-result parsing.

    python3 test/test_hermes.py
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "plugins"))
import hermes as h  # noqa: E402

FX = json.loads((ROOT / "test" / "fixtures" / "describe.json").read_text())


def lookups(case):
    files = case.get("files") or {}
    git_map = case.get("git") or {}

    def git(args):
        k = " ".join(args)
        if k not in git_map:
            raise RuntimeError(f"git {k}: not a git repository")
        return git_map[k]

    def ls(d):
        seen = []
        for f in files:
            if f.startswith(d + "/"):
                n = f[len(d) + 1 :].split("/")[0]
                if n not in seen:
                    seen.append(n)
        return seen

    return {"git": git, "read_file": lambda f: files.get(f), "list_dir": ls, "now": FX["now"], "home": FX["home"]}


def run(case):
    ev = case["event"]
    tool = ev["toolName"]
    # Hermes names its shell tool "terminal"; MCP names are the same shape.
    return h.classify(
        "terminal" if tool == "Bash" else tool,
        ev.get("toolInput") or {},
        ev.get("cwd"),
        ev.get("failed", False),
        ev.get("output", ""),
        ev.get("exitCode"),
        **lookups(case),
    )


class SharedFixtures(unittest.TestCase):
    def test_every_fixture_matches_the_node_core(self):
        for case in FX["cases"]:
            with self.subTest(case["name"]):
                r = run(case)
                got = r and {"title": r["title"], "status": r["status"], "details": r["details"]}
                self.assertEqual(got, case["expect"])
                for s in case.get("absent") or []:
                    self.assertNotIn(s, json.dumps(r, ensure_ascii=False))
                if r:
                    self.assertLessEqual(len(r["title"]), 120)


class Helpers(unittest.TestCase):
    def test_words_and_separators(self):
        self.assertEqual(h.words("""gh pr create --title "Fix it" -b 'a b'"""), ["gh", "pr", "create", "--title", "Fix it", "-b", "a b"])
        self.assertEqual(h.separators('a && b; psql -c "x; y" | c'), [(2, 2), (6, 1), (23, 1)])

    def test_failure_reason(self):
        self.assertEqual(h.failure_reason("ok\nerror: boom\nhint: x"), "error: boom")
        self.assertEqual(h.failure_reason("", 2), "exited with code 2")
        self.assertIsNone(h.failure_reason("", 0))

    def test_tool_result_parsing(self):
        self.assertEqual(h._result_text('{"output": "To x\\n   a..b  main -> main", "exit_code": 0}'), ("To x\n   a..b  main -> main", 0))
        self.assertEqual(h._result_text('{"output": "", "exit_code": 1, "error": "rejected"}')[1], 1)
        self.assertEqual(h._result_text("plain text"), ("plain text", None))


class RealGit(unittest.TestCase):
    def test_push_from_reflog_commit_and_no_repo_fallback(self):
        d = tempfile.mkdtemp(prefix="wb-py-push-")
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"}
        repo = os.path.join(d, "shop")

        def g(*a):
            return subprocess.run(["git", *a], cwd=repo, env=env, capture_output=True, text=True, check=True).stdout

        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", os.path.join(d, "remote.git")], check=True)
        os.mkdir(repo)
        g("init", "-q", "-b", "main")
        g("remote", "add", "origin", os.path.join(d, "remote.git"))
        Path(repo, "a.txt").write_text("1\n")
        g("add", ".")
        g("commit", "-q", "-m", "First")
        g("push", "-q", "-u", "origin", "main")
        for i, s in enumerate(["Add cart", "Fix totals"]):
            Path(repo, f"f{i}.txt").write_text("x\ny\n")
            g("add", ".")
            g("commit", "-q", "-m", s)
        g("push", "-q", "origin", "main")
        r = h.classify("terminal", {"command": "git push -q origin main"}, repo)
        self.assertEqual(r["title"], "Pushed 2 commits to shop/main: Fix totals")
        self.assertIn("- Add cart", r["details"])
        self.assertIn("+4/−0 lines in 2 files", r["details"])
        Path(repo, "b.txt").write_text("z\n")
        g("add", ".")
        out = g("commit", "-m", "Add b")
        c = h.classify("terminal", {"command": 'git commit -m "Add b"'}, repo, False, out)
        self.assertEqual(c["title"], "Committed to shop/main: Add b")
        n = h.classify("terminal", {"command": "git push -q origin main"}, d)
        self.assertEqual(n["title"], "Pushed to git: git push -q origin main")


class ToolCalls(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="wb-py-tc-")
        self.env = {k: os.environ.get(k) for k in ("WAVEBRAIN_HOME", "WAVEBRAIN_API_KEY", "WAVEBRAIN_TOOL_CALLS", "WAVEBRAIN_BOT", "HERMES_HOME")}
        os.environ.update({"WAVEBRAIN_HOME": self.home, "WAVEBRAIN_API_KEY": "al_test_key_000000000000000000", "WAVEBRAIN_BOT": "CEO", "HERMES_HOME": self.home})
        os.environ.pop("WAVEBRAIN_TOOL_CALLS", None)

    def tearDown(self):
        for k, v in self.env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def batches(self):
        d = Path(self.home, "tool-calls")
        return sorted(n for n in os.listdir(d) if n.startswith("batch-")) if d.exists() else []

    def opener(self, status=201):
        sent = []

        class Resp:
            def __init__(self, code):
                self.status = code

            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def open_(req, timeout=None):
            sent.append({"url": req.full_url, "body": json.loads(req.data)})
            if status >= 400:
                raise h.urllib.error.HTTPError(req.full_url, status, "x", {}, None)
            return Resp(status)

        return sent, open_

    def test_recognizes_mcp_tools_and_skips_wavebrain_and_builtins(self):
        self.assertEqual(h.mcp_tool_call("mcp__github__list_issues"), {"server": "github", "tool": "list_issues"})
        self.assertEqual(h.mcp_tool_call("mcp_linear_get_issue"), {"server": "linear", "tool": "get_issue"})
        for n in ("mcp__wavebrain__log_action", "mcp__wavebrain__list_actions", "terminal", "read_file", ""):
            self.assertIsNone(h.mcp_tool_call(n), n)

    def test_post_tool_call_buffers_names_only(self):
        h.on_post_tool_call(
            tool_name="mcp__stripe__create_refund", args={"amount": 5000, "customer": "cus_secret"}, result='{"secret": "result"}',
            session_id="s1", status="error", duration_ms=812.4, error_message="boom",
        )
        h.on_post_tool_call(tool_name="terminal", args={"command": "ls"}, result="{}", session_id="s1", status="ok", duration_ms=3)
        text = h._tool_file("s1").read_text()
        self.assertNotIn("cus_secret", text)
        self.assertNotIn("result", text)
        [c] = [json.loads(l) for l in text.splitlines()]
        self.assertEqual(sorted(c), ["agent", "bot", "client_name", "duration_ms", "occurred_at", "server", "status", "tool"])
        self.assertEqual((c["server"], c["tool"], c["status"], c["duration_ms"], c["bot"], c["client_name"]), ("stripe", "create_refund", "error", 812, "CEO", "hermes"))
        self.assertRegex(c["occurred_at"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

    def test_off_switch(self):
        os.environ["WAVEBRAIN_TOOL_CALLS"] = "off"
        h.on_post_tool_call(tool_name="mcp__github__list_issues", args={}, result="{}", session_id="s", status="ok")
        self.assertFalse(h._tool_file("s").exists())

    def test_session_end_sends_one_batch_and_retries_keep_the_id(self):
        for _ in range(3):
            h.buffer_tool_call("mcp__github__list_issues", "s")
        sent, ok = self.opener()
        self.assertEqual(h.flush_tool_calls("s", opener=ok)["sent"], 0)  # small and fresh: waits
        down_sent, down = self.opener(503)
        h.flush_tool_calls("s", force=True, opener=down)
        self.assertEqual(len(self.batches()), 1)
        h.flush_tool_calls("s", opener=ok)
        self.assertEqual(sent[0]["body"]["batch_id"], down_sent[0]["body"]["batch_id"])
        self.assertTrue(sent[0]["url"].endswith("/api/v1/tool-calls"))
        self.assertEqual(len(sent[0]["body"]["calls"]), 3)
        self.assertEqual(self.batches(), [])

    def test_big_buffers_split_into_batches_of_500(self):
        for _ in range(1100):
            h.buffer_tool_call("mcp__github__list_issues", "big")
        sent, ok = self.opener()
        h.flush_tool_calls("other", opener=ok)
        self.assertEqual(sorted(len(x["body"]["calls"]) for x in sent), [100, 500, 500])

    def test_rejected_batches_are_dropped(self):
        h.buffer_tool_call("mcp__github__list_issues", "s")
        _, bad = self.opener(400)
        h.flush_tool_calls("s", force=True, opener=bad)
        self.assertEqual(self.batches(), [])


if __name__ == "__main__":
    unittest.main()
