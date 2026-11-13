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


if __name__ == "__main__":
    unittest.main()
