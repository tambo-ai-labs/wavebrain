"""WaveBrain for Hermes Agent.

Records the agent's high-stakes actions (deploys, pushes, publishes, payments, emails,
database writes) to WaveBrain, even when the model forgets to call log_action, and adds
a short standing instruction so it usually does.

Same rules (rules.json), queue format (~/.wavebrain/queue/*.jsonl) and REST endpoint as
the Claude Code, Codex and Cursor hooks.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_API_URL = "https://getwavebrain.com/api/v1/actions"
MAX_AGE = 7 * 24 * 3600
STALE = 10 * 60
MAX_PER_FLUSH = 25
SHELL_TOOLS = {"terminal", "bash", "shell", "execute_command", "run_terminal_cmd"}

def agent_name() -> str:
    """'hermes' for the default profile, 'hermes-<profile>' for a named one (HERMES_PROFILE or the
    profile folder in HERMES_HOME), so each bot shows up separately in WaveBrain."""
    profile = os.environ.get("HERMES_PROFILE") or Path(os.environ.get("HERMES_HOME", "")).name or "hermes"
    profile = re.sub(r"[^a-z0-9._-]+", "-", profile.strip().lower()).strip("-")
    agent = "hermes" if profile in ("", ".hermes", "hermes", "default") else f"hermes-{profile}"
    return agent[:64]


def profile_home() -> Path:
    """Folder of the running Hermes profile: HERMES_HOME, else ~/.hermes/profiles/<HERMES_PROFILE>,
    else the profile this plugin is installed in, else ~/.hermes."""
    if os.environ.get("HERMES_HOME"):
        return Path(os.environ["HERMES_HOME"]).expanduser()
    base = Path.home() / ".hermes"
    profile = os.environ.get("HERMES_PROFILE")
    if profile and profile not in ("default", "hermes"):
        return base / "profiles" / profile
    owner = HERE.parent.parent
    return owner if (owner / "config.yaml").exists() else base


def _yaml_scalar(v: str) -> str:
    v = re.sub(r"\s+#.*$", "", v.strip())
    if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'":
        v = v[1:-1]
    return v.strip()


def _profile_title(home: Path):
    """ui_meta → hermes-bots → title in profile.yaml (the bot's name in the Hermes app)."""
    try:
        text = (home / "profile.yaml").read_text()
    except Exception:
        return None
    try:
        import yaml  # type: ignore

        meta = ((yaml.safe_load(text) or {}).get("ui_meta") or {}).get("hermes-bots") or {}
        return str(meta["title"]).strip() if meta.get("title") else None
    except ImportError:
        pass
    except Exception:
        return None
    # No PyYAML: find the indented hermes-bots block under ui_meta and read its title.
    m = re.search(r"^ui_meta:[ \t]*\n((?:[ \t]+.*\n?|[ \t]*\n)*)", text, re.M)
    b = m and re.search(r"^([ \t]+)hermes-bots:[ \t]*\n((?:\1[ \t]+.*\n?|[ \t]*\n)*)", m.group(1), re.M)
    t = b and re.search(r"^[ \t]+title:[ \t]*(.+)$", b.group(2), re.M)
    return (_yaml_scalar(t.group(1)) or None) if t else None


def _header_bot(home: Path):
    """X-WaveBrain-Bot from the MCP server headers in the profile's config.yaml."""
    try:
        text = (home / "config.yaml").read_text()
    except Exception:
        return None
    m = re.search(r"^[ \t]*X-WaveBrain-Bot:[ \t]*(.+)$", text, re.M | re.I)
    return (_yaml_scalar(m.group(1)) or None) if m else None


def bot_name():
    """The bot's display name, e.g. "Head of Growth": WAVEBRAIN_BOT, else the profile's title in
    the Hermes app, else the profile's X-WaveBrain-Bot header. None when there's none."""
    home = profile_home()
    name = os.environ.get("WAVEBRAIN_BOT") or _profile_title(home) or _header_bot(home)
    name = re.sub(r"\s+", " ", str(name or "")).strip()
    return name[:80] or None


def instruction(agent: str | None = None, bot: str | None = None) -> str:
    agent = agent or agent_name()
    bot = bot if bot is not None else bot_name()
    ids = f'agent="{agent}"' + (f' and bot="{bot}"' if bot else "")
    return (
        "WaveBrain is the user's audit log of what agents did. After every action that changes "
        "something outside this conversation (deploys, git push, merges, releases, published posts, "
        "emails or messages sent, payments, database or live config changes), call the WaveBrain "
        "log_action tool once with a short past-tense title and details of what changed and the result. "
        f"Always pass {ids} (and the same agent to start_session), so the user can tell this bot apart from others. "
        "Don't log reads, searches or plans. Never include secrets or codes. A hook records high-stakes "
        "commands automatically as a safety net; your own log_action entry replaces it."
    )


INSTRUCTION = instruction()


def _home() -> Path:
    return Path(os.environ.get("WAVEBRAIN_HOME") or Path.home() / ".wavebrain")


def _config() -> dict:
    cfg = {}
    try:
        cfg = json.loads((_home() / "config.json").read_text())
    except Exception:
        pass
    return {
        "apiKey": os.environ.get("WAVEBRAIN_API_KEY") or cfg.get("apiKey"),
        "apiUrl": os.environ.get("WAVEBRAIN_API_URL") or cfg.get("apiUrl") or DEFAULT_API_URL,
        "enabled": os.environ.get("WAVEBRAIN_HOOKS") != "off" and cfg.get("autoCapture") is not False,
    }


def _js_regex(p: str) -> str:
    return p  # rules.json patterns use the common subset of JS and Python regex syntax


_RULES = json.loads((HERE / "rules.json").read_text())
_SHELL = [(r, re.compile(_js_regex(r["pattern"]), re.I)) for r in _RULES["shell"]]
_VERBS = set(_RULES["mcp_write_verbs"])
_SKIP = set(_RULES["mcp_skip_servers"])

_SECRETS = [
    (re.compile(r"\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}"), "[redacted]"),
    (re.compile(r"\bwhsec_[A-Za-z0-9]{8,}"), "[redacted]"),
    (re.compile(r"\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}"), "[redacted]"),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}"), "[redacted]"),
    (re.compile(r"\bal_[A-Za-z0-9_-]{16,}"), "[redacted]"),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), "[redacted]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[redacted]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{30,}"), "[redacted]"),
    (re.compile(r"\b(sk-(proj-|ant-)?)[A-Za-z0-9_-]{16,}"), "[redacted]"),
    (re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "[redacted]"),
    (re.compile(r"(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}", re.I), r"\1 [redacted]"),
    (re.compile(r"\b([a-z][a-z0-9+.-]*://)[^\s:@/]+:[^\s@/]+@", re.I), r"\1[redacted]@"),
    (re.compile(r"((?:password|passwd|secret|token|api[_-]?key|apikey|auth|access[_-]?key|private[_-]?key)\s*[=:]\s*)(\"[^\"]*\"|'[^']*'|\S+)", re.I), r"\1[redacted]"),
    (re.compile(r"(--(?:password|token|api-key|secret|auth)[= ])(\"[^\"]*\"|'[^']*'|\S+)", re.I), r"\1[redacted]"),
    (re.compile(r"\b[A-Za-z0-9+/_-]{40,}={0,2}"), "[redacted]"),
]


def redact(text) -> str:
    s = str(text or "")
    for rx, rep in _SECRETS:
        s = rx.sub(rep, s)
    return s


def _short(s: str, n: int = 140) -> str:
    one = re.sub(r"\s+", " ", str(s)).strip()
    return one if len(one) <= n else one[: n - 1] + "…"


def _mcp_parts(name: str):
    m = re.match(r"^mcp__(.+?)__(.+)$", name) or re.match(r"^mcp_([a-z0-9-]+)_(.+)$", name, re.I)
    return (m.group(1), m.group(2)) if m else None


def command_dir(before: str, cwd: str | None):
    """The directory a command segment ran in: the last `cd <dir>` before it, else cwd. None if unknown."""
    d = cwd or None
    for m in re.finditer(r"""(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)""", before or ""):
        p = m.group(1).strip("\"'")
        if p == "~" or p.startswith("~/"):
            p = os.path.join(os.environ.get("HOME") or str(Path.home()), p[2:] if p.startswith("~/") else "")
        if not os.path.isabs(p) and not d:
            return None
        d = os.path.normpath(os.path.join(d or "/", p))
    return d


# ---------- readable entries ----------
#
# Each rule gets a describer that turns the command plus cheap local context (git, config files in
# the folder, the command's own output) into a work-log entry: WHAT changed, WHERE, and the RESULT.
# Mirrors shared/core.mjs; test/fixtures/describe.json runs against both.

_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _strip(s) -> str:
    return _ANSI.sub("", str(s or "")).replace("\r", "")


def _plural(n: int, w: str) -> str:
    return f"{n} {w}{'' if n == 1 else 's'}"


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:] if s else s


def words(s: str) -> list:
    """Shell-like word split (quotes group words; no expansion)."""
    out, cur, q = [], None, None
    for ch in str(s):
        if q:
            if ch == q:
                q = None
            else:
                cur += ch
        elif ch in "\"'":
            q = ch
            cur = cur if cur is not None else ""
        elif ch.isspace():
            if cur is not None:
                out.append(cur)
            cur = None
        else:
            cur = (cur or "") + ch
    if cur is not None:
        out.append(cur)
    return out


def _opt(w: list, names: list):
    for i, x in enumerate(w):
        for n in names:
            if x == n and i + 1 < len(w):
                return w[i + 1]
            if n.startswith("--") and x.startswith(n + "="):
                return x[len(n) + 1 :]
    return None


def _has(w: list, names: list) -> bool:
    return any(x == n or (n.startswith("--") and x.startswith(n + "=")) for x in w for n in names)


def _positionals(w: list, after: str, value_flags=()) -> list:
    i = w.index(after) if after in w else -1
    out, j = [], i + 1
    while j < len(w):
        if w[j] in value_flags:
            j += 1
        elif not w[j].startswith("-"):
            out.append(w[j])
        j += 1
    return out


def _json(s):
    try:
        return None if s is None else json.loads(s)
    except Exception:
        return None


def _stat_line(s):
    f = re.search(r"(\d+) files? changed", s or "")
    if not f:
        return None
    ins = (re.search(r"(\d+) insertions?", s) or [None, "0"])[1]
    dele = (re.search(r"(\d+) deletions?", s) or [None, "0"])[1]
    return f"+{ins}/−{dele} lines in {_plural(int(f.group(1)), 'file')}"


def failure_reason(output, exit_code=None):
    """The most useful error line from a command's output, redacted; or "exited with code N"."""
    lines = [l.strip() for l in _strip(output).split("\n") if l.strip()]
    bad = re.compile(r"\b(error|fatal|failed|failure|rejected|denied|not found|invalid|unauthori[sz]ed|forbidden|cannot|unable|refused|conflict|exception)\b|ERR!", re.I)
    hit = next((x for x in reversed(lines) if bad.search(x)), lines[-1] if lines else None)
    if hit:
        return _short(redact(hit), 200)
    return f"exited with code {exit_code}" if isinstance(exit_code, int) and exit_code != 0 else None


def _try_git(c, args):
    try:
        return c["git"](args)
    except Exception:
        return None


def _repo_info(c):
    try:
        common = os.path.normpath(os.path.join(c["dir"], c["git"](["rev-parse", "--git-common-dir"])))
        base = os.path.basename(common)
        repo = os.path.basename(os.path.dirname(common)) if base == ".git" else re.sub(r"\.git$", "", base)
        branch = _try_git(c, ["rev-parse", "--abbrev-ref", "HEAD"]) or ""
        return {"repo": repo, "branch": "" if branch == "HEAD" else branch} if repo else None
    except Exception:
        return None


def _commit_lines(subjects, count):
    if not subjects:
        return []
    out = ["Commits:"] + [f"- {_short(redact(s), 120)}" for s in subjects[:10]]
    if count > 10:
        out.append(f"- …and {count - 10} more")
    return out


def _basename(d):
    return os.path.basename(d) if d else None


def _fail(c, title_prefix, lines=None, reason=None):
    reason = reason or failure_reason(c["output"], c["exit_code"])
    return {"failed": True, "reason": reason, "title": f"{title_prefix} failed" + (f": {reason}" if reason else ""), "lines": lines or []}


def pushed_branch(segment: str):
    """The branch a `git push` names (`git push origin main`, `HEAD:release`), or None for the checked-out one."""
    w = words(segment)
    i = w.index("push") + 1 if "push" in w else len(w)
    args = [x for x in w[i:] if not x.startswith("-")]
    if len(args) < 2:
        return None
    ref = args[1].lstrip("+").split(":")[-1]
    ref = re.sub(r"^refs/heads/", "", ref)
    return ref if ref and ref != "HEAD" else None


def _describe_push(c):
    w = words(c["segment"])
    args = w[w.index("push") + 1 :] if "push" in w else []
    pos = _positionals(w, "push", ("-o", "--push-option", "--repo", "--receive-pack", "--exec"))
    out = _strip(c["output"])
    g = _repo_info(c)
    remote = pos[0] if pos else None
    branch = pushed_branch(c["segment"]) or (pos[1][1:] if len(pos) > 1 and pos[1].startswith(":") else None)
    if not remote or not branch:
        up = _try_git(c, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
        m = re.match(r"^([^/]+)/(.+)$", up) if up else None
        remote = remote or (m.group(1) if m else None) or "origin"
        branch = branch or (m.group(2) if m else None) or (g["branch"] if g else None) or None
    repo = (g["repo"] if g else None) or _basename(c["dir"])
    where = (f"{repo}/{branch}" if branch else repo) if repo else (f"{remote}/{branch}" if branch else None)
    if not where:
        return None

    rejected = bool(re.search(r"\[(remote )?rejected\]|error: failed to push", out))
    if c["failed"] or rejected:
        r = re.search(r"\[(?:remote )?rejected\][^\n]*\(([^)]+)\)", out)
        reason = f"rejected ({r.group(1)})" if r else failure_reason(out, c["exit_code"])
        return {"failed": True, "reason": reason, "title": f"Push to {where} failed" + (f": {reason}" if reason else ""), "lines": []}
    if _has(args, ["-d", "--delete"]) or (len(pos) > 1 and pos[1].startswith(":")):
        return {"title": f"Deleted branch {branch} from {remote}" + (f" ({repo})" if repo else ""), "lines": []}

    force = (
        _has(args, ["-f", "--force", "--force-with-lease", "--force-if-includes"])
        or any(p.startswith("+") for p in pos[1:])
        or "(forced update)" in out
    )
    old = new = None
    is_new = "[new branch]" in out
    ranges = list(re.finditer(r"^\s*[+ ]?\s*([0-9a-f]{7,40})(\.\.\.?)([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)", out, re.M))
    hit = next((m for m in ranges if m.group(5) == branch or m.group(5).endswith(f"/{branch}")), ranges[0] if ranges else None)
    if hit:
        old, new = hit.group(1), hit.group(3)
        if hit.group(2) == "...":
            force = True
    if not new and not is_new and branch and re.match(r"^[\w.-]+$", remote) and "Everything up-to-date" not in out:
        log = _try_git(c, ["log", "-g", "-n", "2", "--date=unix", "--format=%H %gd %gs", f"refs/remotes/{remote}/{branch}"])
        rows = [m for m in (re.match(r"^([0-9a-f]+) \S*@\{(\d+)\} (.*)$", l) for l in (log or "").split("\n") if l) if m]
        if rows and rows[0].group(3).startswith("update by push") and abs(c["now"] / 1000 - int(rows[0].group(2))) <= 300:
            new = rows[0].group(1)
            old = rows[1].group(1) if len(rows) > 1 else None
            is_new = not old
    tags = re.findall(r"\[new tag\]\s+(\S+)", out)
    if not new and not is_new:
        if "Everything up-to-date" in out:
            return {"title": f"Pushed to {where}: already up to date", "lines": ["Nothing new to push; the remote already had these commits."]}
        if tags:
            return {"title": f"Pushed {'tag' if len(tags) == 1 else 'tags'} {', '.join(tags[:3])} to {repo or remote}", "lines": []}
        subject = _try_git(c, ["log", "-1", "--format=%s", branch if branch and (g or {}).get("branch") != branch else "HEAD"])
        return {"title": f"Pushed to {where}: {subject}", "lines": []} if subject else None

    subjects, count, stat = [], 0, None
    if new and old:
        subjects = [s for s in (_try_git(c, ["log", "--format=%s", "-n", "11", f"{old}..{new}"]) or "").split("\n") if s]
        n = _try_git(c, ["rev-list", "--count", f"{old}..{new}"])
        count = int(n) if n is not None else len(subjects)
        stat = _stat_line(_try_git(c, ["diff", "--shortstat", old, new]))
        if not force and subjects and _try_git(c, ["merge-base", "--is-ancestor", old, new]) is None:
            force = True
    elif is_new:
        tip = new or branch
        nott = ["--not", f"--exclude=refs/remotes/{remote}/{branch}", f"--remotes={remote}"]
        subjects = [s for s in (_try_git(c, ["log", "--format=%s", "-n", "11", tip, *nott]) or "").split("\n") if s]
        n = _try_git(c, ["rev-list", "--count", tip, *nott])
        count = int(n) if n is not None else len(subjects)
    newest = subjects[0] if subjects else (_try_git(c, ["log", "-1", "--format=%s", new or branch]) or "")
    verb = "Force-pushed" if force else "Pushed"
    if is_new:
        title = f"{verb} new branch {where}" + (f" ({_plural(count, 'commit')})" if count else "")
    elif count == 1:
        title = f"{verb} to {where}"
    elif count > 1:
        title = f"{verb} {count} commits to {where}"
    else:
        title = f"{verb} to {where}"
    if newest:
        title += f": {newest}"
    lines = _commit_lines(subjects, count)
    if stat:
        lines.append(stat)
    if force:
        lines.append("Force push: the remote branch was rewritten" + (f" (was {old[:7]}, now {new[:7]})" if old and new else "") + ".")
    elif old and new:
        lines.append(f"Range: {old[:7]}..{new[:7]}")
    if tags:
        lines.append(f"Tags: {', '.join(tags)}")
    return {"title": title, "lines": lines}


def _describe_commit(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    g = _repo_info(c)
    repo = (g["repo"] if g else None) or _basename(c["dir"])
    m = re.search(r"^\[([^\]\s]+)(?: \(root-commit\))? ([0-9a-f]{7,})\] (.+)$", out, re.M)
    branch = m.group(1) if m and m.group(1) != "detached" else (g["branch"] if g else None)
    where = (f"{repo}/{branch}" if branch else repo) if repo else None
    if not where:
        return None
    if c["failed"]:
        reason = "nothing to commit" if re.search(r"nothing (added )?to commit|no changes added to commit", out) else None
        return _fail(c, f"Commit to {where}", reason=reason)
    head = _try_git(c, ["log", "-1", "--format=%H%x09%s", m.group(2) if m else "HEAD"])
    if head:
        h, _, subject = head.partition("\t")
    else:
        h, subject = (m.group(2), m.group(3)) if m else (None, None)
    if not subject:
        return None
    lines = []
    stat = _stat_line(_try_git(c, ["show", "--shortstat", "--format=", h])) if h else None
    if stat:
        lines.append(stat)
    files = [f for f in (_try_git(c, ["show", "--name-only", "--format=", h]) or "").split("\n") if f] if h else []
    if files:
        lines.append(f"Files: {', '.join(files[:10])}" + (f" (+{len(files) - 10} more)" if len(files) > 10 else ""))
    if h:
        lines.append(f"Commit: {h[:7]}")
    verb = "Amended the last commit on" if _has(w, ["--amend"]) else "Committed to"
    return {"title": f"{verb} {where}: {subject}", "lines": lines}


_GH = re.compile(r"https://github\.com/([\w.-]+)/([\w.-]+)/(pull|releases/tag)/(\S+)")


def _gh_repo(c, w):
    r = _opt(w, ["-R", "--repo"])
    if r:
        return r.split("/")[-1]
    g = _repo_info(c)
    return (g["repo"] if g else None) or _basename(c["dir"])


def _describe_pr_create(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    u = _GH.search(out)
    repo = u.group(2) if u else _gh_repo(c, w)
    t = _opt(w, ["-t", "--title"])
    draft = "draft " if _has(w, ["-d", "--draft"]) else ""
    if c["failed"]:
        return _fail(c, f"Opening a pull request in {repo}", [f"Existing PR: {u.group(0)}"] if u else [])
    what = f"{draft}PR #{u.group(4)}" if u else f"a {draft}pull request"
    title = f"Opened {what}" + (f" in {repo}" if repo else "") + (f": {t}" if t else "")
    lines = [f"URL: {u.group(0)}"] if u else []
    base = _opt(w, ["-B", "--base"])
    head = _opt(w, ["-H", "--head"]) or (_repo_info(c) or {}).get("branch")
    if head or base:
        lines.append(f"Branch: {head or '?'} → {base or 'default branch'}")
    return {"title": title, "lines": lines}


def _describe_pr_merge(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    pos = _positionals(w, "merge", ("-R", "--repo", "-t", "--subject", "-b", "--body", "-F", "--body-file", "-A", "--author-email", "--match-head-commit"))
    arg = pos[0] if pos else ""
    num = arg if re.match(r"^\d+$", arg) else (re.search(r"/pull/(\d+)", arg) or [None, None])[1]
    m = re.search(r"(Squashed and merged|Rebased and merged|Merged) pull request (?:([\w.-]+)/([\w.-]+))?#(\d+) \((.+)\)", out)
    ua = re.search(r"github\.com/[\w.-]+/([\w.-]+)/pull", arg)
    repo = (m.group(3) if m and m.group(3) else None) or (ua.group(1) if ua else None) or _gh_repo(c, w)
    n = (m.group(4) if m else None) or num
    pr = f"PR #{n}" if n else (f"the PR for {arg}" if arg and not arg.startswith("http") else "a pull request")
    inrepo = f" in {repo}" if repo else ""
    if c["failed"]:
        return _fail(c, f"Merging {pr}{inrepo}")
    how = "squash" if _has(w, ["-s", "--squash"]) else "rebase" if _has(w, ["-r", "--rebase"]) else "merge commit" if _has(w, ["-m", "--merge"]) else None
    lines = []
    if how:
        lines.append(f"Method: {how}")
    if _has(w, ["-d", "--delete-branch"]):
        lines.append("Deleted the branch after merging.")
    if _has(w, ["--auto"]) and not m:
        return {"title": f"Turned on auto-merge for {pr}{inrepo}", "lines": lines}
    return {"title": f"Merged {pr}{inrepo}" + (f": {m.group(5)}" if m else ""), "lines": lines}


def _describe_release(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    pos = _positionals(w, "create", ("-t", "--title", "-n", "--notes", "-F", "--notes-file", "--target", "-R", "--repo", "--discussion-category", "--notes-start-tag"))
    if not pos:
        return None
    tag = pos[0]
    u = _GH.search(out)
    repo = u.group(2) if u else _gh_repo(c, w)
    t = _opt(w, ["-t", "--title"])
    inrepo = f" in {repo}" if repo else ""
    if c["failed"]:
        return _fail(c, f"Creating GitHub release {tag}{inrepo}")
    kind = "draft GitHub release" if _has(w, ["-d", "--draft"]) else "GitHub pre-release" if _has(w, ["-p", "--prerelease"]) else "GitHub release"
    return {"title": f"Created {kind} {tag}{inrepo}" + (f": {t}" if t and t != tag else ""), "lines": [f"URL: {u.group(0)}"] if u else []}


def _cli_dir(c, w, names=("--cwd",)):
    d = _opt(w, list(names))
    return os.path.normpath(os.path.join(c["dir"], d)) if d and c["dir"] else c["dir"]


def _vercel_project(c, w):
    d = _cli_dir(c, w)
    p = _json(c["read_file"](os.path.join(d, ".vercel", "project.json"))) if d else None
    return _opt(w, ["--project"]) or (p or {}).get("projectName") or _basename(d)


def _describe_vercel(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    sub = next((s for s in ("deploy", "redeploy", "promote", "rollback") if s in w), "deploy")
    project = _vercel_project(c, w)
    target = "production" if sub == "promote" or _has(w, ["--prod"]) else (_opt(w, ["--target"]) or "preview")
    m = re.search(r"(?:^|\s)(Production|Preview):\s*(https://\S+)", out, re.M)
    bare = re.search(r"\b([\w-]+\.vercel\.app)\b", out)
    deployed = m.group(2) if m else (re.search(r"https://[\w.-]+\.vercel\.app", out) or [None])[0] or (f"https://{bare.group(1)}" if bare else None)
    ja = re.search(r'"alias(?:es)?"\s*:\s*\[?\s*"(?:https://)?([^"]+)"', out)
    alias = (re.search(r"Aliased:\s*(https://\S+)", out) or [None, None])[1] or (f"https://{ja.group(1)}" if ja else None)
    inspect = (re.search(r"Inspect:\s*(https://\S+)", out) or [None, None])[1]
    on = f" {project}" if project else ""
    if c["failed"]:
        what = f"Promoting a deployment of{on or ' the project'} to production" if sub == "promote" else f"Vercel {target} deploy of{on or ' the project'}"
        return _fail(c, what, [f"Inspect: {inspect}"] if inspect else [])

    def host(u):
        return re.sub(r"/$", "", re.sub(r"^https://", "", u)) if u else u

    lines = []
    if deployed:
        lines.append(f"Deployment: {deployed}")
    if alias:
        lines.append(f"Live at: {alias}")
    if inspect:
        lines.append(f"Inspect: {inspect}")
    if _has(w, ["--prebuilt"]):
        lines.append("Deployed a prebuilt output.")
    if sub == "promote":
        pa = _positionals(w, "promote", ("--scope", "--token", "-t", "--timeout"))
        title = f"Promoted {host(pa[0]) if pa else 'a deployment'} to production" + (f" for{on}" if on else "") + " on Vercel"
    elif sub == "rollback":
        title = f"Rolled back{on or ' the project'} on Vercel"
    elif sub == "redeploy":
        title = f"Redeployed{on or ' the project'} on Vercel ({target})"
    else:
        title = f"Deployed{on or ' the project'} to {target} on Vercel" + (f" ({host(alias or deployed)})" if alias or deployed else "")
    return {"title": title, "lines": lines}


def _describe_vercel_env(c):
    w = words(c["segment"])
    i = w.index("env")
    act = w[i + 1] if i + 1 < len(w) else ""
    pos = _positionals(w[i + 1 :], act, ("--scope", "--token", "-t", "--cwd"))
    if not pos:
        return None
    name, env = pos[0], (pos[1] if len(pos) > 1 else None)
    project = _vercel_project(c, w)
    verb = "Added" if act == "add" else "Updated" if act == "update" else "Removed"
    prep = "to" if act == "add" else "in" if act == "update" else "from"
    scope = f"{prep} {env}" if env else f"{prep} {'the chosen environments' if act == 'add' else 'all environments'}"
    if c["failed"]:
        ing = "Adding" if act == "add" else "Updating" if act == "update" else "Removing"
        return _fail(c, f"{ing} Vercel env var {name}")
    return {"title": f"{verb} Vercel env var {name} {scope}" + (f" ({project})" if project else ""), "lines": ["The value is never recorded."]}


def _describe_railway(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    cfg = _json(c["read_file"](os.path.join(c["home"] or "/", ".railway", "config.json")))
    link = None
    if isinstance(cfg, dict) and isinstance(cfg.get("projects"), dict) and c["dir"]:
        keys = sorted(
            [k for k in cfg["projects"] if c["dir"] == k or c["dir"].startswith(k if k.endswith("/") else k + "/")],
            key=len,
            reverse=True,
        )
        link = cfg["projects"][keys[0]] if keys else None
    service = _opt(w, ["-s", "--service"])
    env = _opt(w, ["-e", "--environment"]) or (link or {}).get("environmentName")
    name = service or (link or {}).get("name") or _basename(c["dir"]) or "the project"
    in_env = f" ({env})" if env else ""
    is_vars = bool(re.search(r"\bvariables?\b", c["segment"]))
    if c["failed"]:
        return _fail(c, f"{'Setting Railway variables on' if is_vars else 'Railway deploy of'} {name}")
    if is_vars:
        keys = [x.split("=")[0] for j, x in enumerate(w) if j > 0 and w[j - 1] in ("--set", "set") and "=" in x]
        title = re.sub(r"  +", " ", f"Set Railway {'variable' if len(keys) == 1 else 'variables'} {', '.join(keys)} on {name}{in_env}")
        return {"title": title, "lines": ["Values are never recorded."]}
    logs = re.search(r"https://railway\.(?:com|app)/project/\S+", out)
    lines = []
    if (link or {}).get("name") and service:
        lines.append(f"Project: {link['name']}")
    if logs:
        lines.append(f"Build logs: {logs.group(0)}")
    return {"title": f"Deployed {name} to Railway{in_env}", "lines": lines}


def _describe_fly(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    conf = _opt(w, ["-c", "--config"])
    toml = c["read_file"](os.path.normpath(os.path.join(c["dir"], conf or "fly.toml"))) if c["dir"] else None
    m = re.search(r"""^\s*app\s*=\s*["']([^"']+)["']""", toml or "", re.M)
    app = _opt(w, ["-a", "--app"]) or (m.group(1) if m else None) or _basename(c["dir"]) or "the app"
    secrets = "secrets" in w
    if c["failed"]:
        return _fail(c, f"{'Setting Fly.io secrets on' if secrets else 'Fly.io deploy of'} {app}")
    if secrets:
        keys = [x.split("=")[0] for x in _positionals(w, "set", ("-a", "--app", "-c", "--config")) if "=" in x]
        return {"title": f"Set Fly.io {'secret' if len(keys) == 1 else 'secrets'} {', '.join(keys)} on {app}", "lines": ["Values are never recorded."]}
    url = re.search(r"https://[\w.-]+\.fly\.dev\S*", out)
    return {"title": f"Deployed {app} to Fly.io", "lines": [f"URL: {url.group(0)}"] if url else []}


def _describe_wrangler(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    conf = _opt(w, ["-c", "--config"])
    name = _opt(w, ["--name"])
    if not name and c["dir"]:
        for f in [conf] if conf else ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]:
            text = c["read_file"](os.path.normpath(os.path.join(c["dir"], f)))
            if not text:
                continue
            m = re.search(r"""^\s*name\s*=\s*["']([^"']+)["']""", text, re.M) if f.endswith(".toml") else re.search(r'"name"\s*:\s*"([^"]+)"', text)
            name = m.group(1) if m else None
            if name:
                break
    name = name or _basename(c["dir"]) or "the worker"
    env = _opt(w, ["-e", "--env"])
    in_env = f" ({env})" if env else ""
    secret = "secret" in w
    if c["failed"]:
        return _fail(c, f"{'Setting a secret on' if secret else 'Deploying'} Cloudflare Worker {name}")
    if secret:
        pk = _positionals(w, "put", ("-c", "--config", "-e", "--env", "--name"))
        return {"title": re.sub(r"  +", " ", f"Set Cloudflare Worker secret {pk[0] if pk else ''} on {name}{in_env}"), "lines": ["The value is never recorded."]}
    lines = []
    url = re.search(r"https://[\w.-]+\.workers\.dev\S*", out)
    version = re.search(r"Current Version ID:\s*(\S+)", out)
    if url:
        lines.append(f"URL: {url.group(0)}")
    if version:
        lines.append(f"Version: {version.group(1)}")
    return {"title": f"Deployed Cloudflare Worker {name}{in_env}", "lines": lines}


def _describe_netlify(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    site = _opt(w, ["--site", "-s"])
    name = os.path.basename(_cli_dir(c, w)) if c["dir"] else (site or "the site")
    target = "production" if _has(w, ["--prod", "-p"]) else "a draft URL"
    if c["failed"]:
        return _fail(c, f"Netlify deploy of {name}")
    live = re.search(r"Website (?:draft )?URL:\s*(https://\S+)", out)
    unique = re.search(r"Unique deploy URL:\s*(https://\S+)", out)
    lines = []
    if live:
        lines.append(f"URL: {live.group(1)}")
    if unique:
        lines.append(f"Deploy: {unique.group(1)}")
    return {"title": f"Deployed {name} to {target} on Netlify", "lines": lines}


def _describe_kubectl(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    i = w.index("kubectl")
    verb = w[i + 1] if i + 1 < len(w) else ""
    ns = _opt(w, ["-n", "--namespace"])
    ctx = _opt(w, ["--context"])
    file = _opt(w, ["-f", "--filename"])
    pos = _positionals(w, verb, ("-n", "--namespace", "--context", "-f", "--filename", "-l", "--selector", "-o", "--output", "--replicas", "-c", "--container"))
    what = file or " ".join(pos)
    where = (f" in namespace {ns}" if ns else "") + (f" ({ctx})" if ctx else "")
    Verb = {"apply": "Applied", "delete": "Deleted", "scale": "Scaled", "set": "Updated", "rollout": "Ran rollout"}.get(verb, "Changed")
    if c["failed"]:
        return _fail(c, f"kubectl {verb} {what}")
    replicas = _opt(w, ["--replicas"])
    changed = [l.strip() for l in out.split("\n") if re.search(r"\b(created|configured|deleted|scaled|restarted|rolled back|image updated)\b", l)]
    lines = (["Changed:"] + [f"- {l}" for l in changed[:10]]) if changed else []
    return {"title": re.sub(r"  +", " ", f"{Verb} {what}" + (f" to {replicas} replicas" if replicas else "") + f" on Kubernetes{where}"), "lines": lines}


def _describe_terraform(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    tool = next((x for x in w if x in ("terraform", "tofu")), "terraform")
    destroy = "destroy" in w
    chdir = next((x[7:] for x in w if x.startswith("-chdir=")), None)
    name = os.path.basename(os.path.normpath(os.path.join(c["dir"], chdir)) if chdir else c["dir"]) if c["dir"] else None
    res = re.search(r"(Apply|Destroy) complete! Resources: ([^.]+)\.", out)
    T = "OpenTofu" if tool == "tofu" else "Terraform"
    if c["failed"]:
        return _fail(c, f"{T} {'destroy' if destroy else 'apply'}" + (f" in {name}" if name else ""))
    return {"title": f"{'Destroyed' if destroy else 'Applied'} {T} infrastructure" + (f" in {name}" if name else "") + (f": {res.group(2)}" if res else ""), "lines": []}


def _describe_docker(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    if "buildx" in w:
        image = _opt(w, ["-t", "--tag"])
    else:
        p = _positionals(w, "push", ("--platform",))
        image = p[0] if p else None
    if not image:
        return None
    if c["failed"]:
        return _fail(c, f"Pushing Docker image {image}")
    digest = re.search(r"digest: (sha256:[0-9a-f]{12})", out)
    return {"title": f"{'Built and pushed' if 'buildx' in w else 'Pushed'} Docker image {image}", "lines": [f"Digest: {digest.group(1)}…"] if digest else []}


def _describe_publish(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    pm = next((x for x in w if x in ("npm", "pnpm", "yarn", "bun")), "npm")
    dir_arg = next((x for x in _positionals(w, "publish", ("--tag", "--access", "--otp", "--registry", "--filter", "-F")) if x.startswith(".") or x.startswith("/")), None)
    pkg_dir = (os.path.normpath(os.path.join(c["dir"], dir_arg)) if dir_arg else c["dir"]) if c["dir"] else None
    pkg = _json(c["read_file"](os.path.join(pkg_dir, "package.json"))) if pkg_dir else None
    m = re.search(r"^\+ (\S+@\S+)$", out, re.M)
    pid = m.group(1) if m else (f"{pkg['name']}" + (f"@{pkg['version']}" if pkg.get("version") else "") if isinstance(pkg, dict) and pkg.get("name") else None)
    tag = _opt(w, ["--tag"])
    what = pid or (os.path.basename(pkg_dir) if pkg_dir else "a package")
    if c["failed"]:
        return _fail(c, f"Publishing {what} to npm")
    lines = []
    if tag:
        lines.append(f"Dist-tag: {tag}")
    access = _opt(w, ["--access"])
    if access:
        lines.append(f"Access: {access}")
    if pm != "npm":
        lines.append(f"Published with {pm}.")
    if _has(w, ["--dry-run"]):
        return {"title": f"Dry-ran publishing {what} (nothing was published)", "lines": lines}
    return {"title": f"Published {what} to npm" + (f" ({tag})" if tag and tag != "latest" else ""), "lines": lines}


def _expo_app(c, d):
    j = _json(c["read_file"](os.path.join(d, "app.json")))
    e = (j.get("expo") or j) if isinstance(j, dict) else None
    if isinstance(e, dict) and (e.get("name") or e.get("slug")):
        return {
            "name": e.get("name") or e.get("slug"),
            "ios": (e.get("ios") or {}).get("bundleIdentifier"),
            "android": (e.get("android") or {}).get("package"),
            "version": e.get("version"),
            "build": (e.get("ios") or {}).get("buildNumber") or (e.get("android") or {}).get("versionCode"),
        }
    for f in ("app.config.ts", "app.config.js"):
        t = c["read_file"](os.path.join(d, f))
        if not t:
            continue

        def g(k):
            m = re.search(rf"""\b{k}:\s*["'`]([^"'`]+)["'`]""", t)
            return m.group(1) if m else None

        return {"name": g("name") or g("slug"), "ios": g("bundleIdentifier"), "android": g("package"), "version": g("version"), "build": None}
    return None


_PLATFORM = {"ios": "iOS", "android": "Android", "all": "iOS and Android"}


def _describe_eas(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    sub = next((s for s in ("build", "submit", "update") if s in w), None)
    app = _expo_app(c, c["dir"]) if c["dir"] else None
    name = (app or {}).get("name") or _basename(c["dir"]) or "the app"
    p = _opt(w, ["-p", "--platform"])
    plat = _PLATFORM.get(p, p) if p else None
    profile = _opt(w, ["-e", "--profile"])
    lines = []
    ids = [x for x in [f"iOS {app['ios']}" if app and app.get("ios") and p != "android" else None, f"Android {app['android']}" if app and app.get("android") and p != "ios" else None] if x]
    if ids:
        lines.append(f"App: {', '.join(ids)}")
    vm = re.search(r"Version:\s*(\S+)", out)
    ver = vm.group(1) if vm else (app or {}).get("version")
    bm = re.search(r"Build number:\s*(\S+)", out) or re.search(r"Version code:\s*(\S+)", out)
    build = bm.group(1) if bm else (app or {}).get("build")
    if ver or build:
        lines.append(f"Version {ver or '?'}" + (f" (build {build})" if build else ""))
    if profile:
        lines.append(f"Profile: {profile}")
    url = re.search(r"https://expo\.dev/\S+", out)
    if url:
        lines.append(f"EAS: {url.group(0)}")
    if c["failed"]:
        return _fail(c, f"EAS {sub}" + (f" ({plat})" if plat else "") + f" for {name}", lines)
    if sub == "update":
        branch = _opt(w, ["--branch"]) or _opt(w, ["--channel"])
        msg = _opt(w, ["-m", "--message"])
        return {"title": f"Published an EAS update for {name}" + (f" to {branch}" if branch else "") + (f": {msg}" if msg else ""), "lines": lines}
    if sub == "submit":
        store = "Google Play" if p == "android" else "App Store Connect" if p == "ios" else "the app stores"
        return {"title": f"Submitted {name}" + (f" {plat}" if plat else "") + f" build to {store} with EAS", "lines": lines}
    done = bool(re.search(r"Build finished|✔ Build", out))
    verb = "Built" if done else "Started" if _has(w, ["--no-wait"]) or out else "Ran"
    return {"title": f"{verb} " + (f"{plat} " if plat else "") + (f"{profile} " if profile else "") + f"build of {name} on EAS", "lines": lines}


def _describe_app_upload(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    if "altool" in w:
        f = _opt(w, ["-f", "--file"])
        name = os.path.basename(f) if f else "an app build"
        if c["failed"] or re.search(r"UPLOAD FAILED|ERROR ITMS", out):
            return _fail(c, f"Uploading {name} to App Store Connect")
        return {"title": f"Uploaded {name} to App Store Connect", "lines": []}
    i = w.index("fastlane") if "fastlane" in w else -1
    lane = " ".join(x for x in w[i + 1 :] if ":" not in x and not x.startswith("-"))
    appfile = c["read_file"](os.path.join(c["dir"], "fastlane", "Appfile")) if c["dir"] else None
    am = re.search(r"""app_identifier\s*\(?\s*["']([^"']+)["']""", appfile or "")
    app_id = am.group(1) if am else None
    xcode = next((f[: -len(".xcodeproj")] for f in c["list_dir"](c["dir"]) if f.endswith(".xcodeproj")), None) if c["dir"] else None
    name = xcode or app_id or _basename(c["dir"]) or "the app"
    dest = "TestFlight" if re.search(r"\bpilot\b|upload_to_testflight", lane) else "the App Store" if re.search(r"\bdeliver\b|upload_to_app_store", lane) else None
    lines = [f"Bundle ID: {app_id}"] if app_id else []
    if c["failed"]:
        return _fail(c, f"fastlane {lane} for {name}", lines)
    return {"title": f"Uploaded {name} to {dest} with fastlane" if dest else f"Ran fastlane {lane} for {name}", "lines": lines}


_PAST = {"create": "Created", "update": "Updated", "delete": "Deleted", "cancel": "Cancelled"}


def _singular(r: str) -> str:
    return re.sub(r"s$", "", re.sub(r"ies$", "y", r.replace("_", " ")))


def _describe_stripe_cli(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    i = w.index("stripe")
    res = w[i + 1] if i + 1 < len(w) else ""
    verb = w[i + 2] if i + 2 < len(w) else ""
    rid = w[i + 3] if i + 3 < len(w) and not w[i + 3].startswith("-") else None
    lm = re.match(r"^name=(.+)$", _opt(w, ["-d"]) or "")
    label = _opt(w, ["--name"]) or (lm.group(1) if lm else None)
    what = f"Stripe {_singular(res)}"
    if c["failed"]:
        reason = failure_reason(c["output"], c["exit_code"])
        return {"failed": True, "reason": reason, "title": f"Couldn't {verb} {what}" + (f": {reason}" if reason else ""), "lines": []}
    nm = re.search(r'"id":\s*"([a-z]+_[A-Za-z0-9]+)"', out)
    lines = []
    if nm or rid:
        lines.append(f"ID: {nm.group(1) if nm else rid}")
    if _has(w, ["--live"]):
        lines.append("Live mode.")
    title = f"{_PAST.get(verb, _cap(verb))} {f'a {what}' if verb == 'create' else what}" + (f": {label}" if label else f" {rid}" if rid and verb != "create" else "")
    return {"title": title, "lines": lines}


def _describe_migrate(c):
    out = _strip(c["output"])
    seg = c["segment"]
    tool = "Prisma" if "prisma" in seg else "Drizzle" if "drizzle-kit" in seg else None
    sm = re.search(r"\bdb:(migrate|push)\b", seg)
    if not tool and sm and c["dir"]:
        run = ((_json(c["read_file"](os.path.join(c["dir"], "package.json"))) or {}).get("scripts") or {}).get(sm.group(0)) or ""
        tool = "Prisma" if "prisma" in run else "Drizzle" if "drizzle" in run else "Knex" if "knex" in run else "Sequelize" if "sequelize" in run else None
    push = bool(re.search(r"drizzle-kit\s+push|db:push", seg))
    name = _basename(c["dir"]) or "the project"
    T = f"{tool} " if tool else ""
    if c["failed"]:
        return _fail(c, _cap(f"{T}{'schema push' if push else 'migrations'} for {name}"))
    if push:
        return {"title": f"Pushed the {T}database schema for {name}".replace("  ", " "), "lines": []}
    names = list(dict.fromkeys(re.findall(r"\b(\d{4,}_[A-Za-z0-9_-]+)", out)))
    none = bool(re.search(r"No pending migrations|No migrations to apply|already up to date", out, re.I))
    tail = f": applied {_plural(len(names), 'migration')}" if names else ": nothing to apply" if none else ""
    lines = (["Migrations:"] + [f"- {n}" for n in names[:10]]) if names else []
    return {"title": f"Ran {T}migrations on {name}{tail}", "lines": lines}


def _describe_psql(c):
    w = words(c["segment"])
    out = _strip(c["output"])
    sql = _opt(w, ["-c", "--command"]) or c["segment"]
    rx = re.compile(r"""\b(insert\s+into|update|delete\s+from|drop\s+table(?:\s+if\s+exists)?|alter\s+table|truncate(?:\s+table)?|create\s+table(?:\s+if\s+not\s+exists)?)\s+("?[\w.]+"?)""", re.I)
    stmts = []
    for m in rx.finditer(sql):
        kind = " ".join(m.group(1).lower().split()[:2])
        table = m.group(2).replace('"', "")
        if kind == "update" and not re.search(rf'update\s+"?{re.escape(table)}"?\s+set\b', sql, re.I):
            continue
        stmts.append({"kind": kind, "table": table})
    if not stmts:
        return None
    dm = re.search(r"""postgres(?:ql)?://[^\s'"]*/([\w-]+)""", c["segment"])
    db = _opt(w, ["-d", "--dbname"]) or (dm.group(1) if dm else None)
    on = f" on {db}" if db else ""
    if c["failed"]:
        return _fail(c, f"psql {stmts[0]['kind'].upper()} on {stmts[0]['table']}")
    counts = [int(m.group(2)) for m in re.finditer(r"^(INSERT \d+|UPDATE|DELETE) (\d+)$", out, re.M)]
    if len(stmts) == 1:
        kind, table = stmts[0]["kind"], stmts[0]["table"]
        rows = _plural(counts[0], "row") if counts else "rows"
        t = {
            "insert into": f"Inserted {rows} into {table}",
            "update": f"Updated {rows} in {table}",
            "delete from": f"Deleted {rows} from {table}",
            "drop table": f"Dropped table {table}",
            "alter table": f"Altered table {table}",
            "truncate": f"Truncated {table}",
            "truncate table": f"Truncated {table}",
            "create table": f"Created table {table}",
        }.get(kind)
        return {"title": f"{t} with psql{on}", "lines": []}
    lst = [f"{s['kind'].split()[0].upper()} {s['table']}" for s in stmts]
    return {"title": f"Ran {len(stmts)} write statements with psql{on}: {', '.join(lst[:4])}", "lines": ["Statements:"] + [f"- {l}" for l in lst[:10]]}


def _curl_body(c, w):
    d = _opt(w, ["-d", "--data", "--data-raw", "--data-binary", "--json"])
    if not d:
        return None
    if d.startswith("@") and d != "@-":
        return c["read_file"](os.path.normpath(os.path.join(c["dir"], d[1:]))) if c["dir"] else None
    return d


def _tokenish(s: str) -> bool:
    return len(s) >= 20 and bool(re.search(r"\d", s)) and bool(re.search(r"[A-Za-z]", s))


def _describe_curl(c):
    from urllib.parse import urlsplit

    w = words(c["segment"])
    out = _strip(c["output"])
    method = (_opt(w, ["-X", "--request"]) or "POST").upper()
    raw = _opt(w, ["--url"]) or next((x for x in w if re.match(r"^https?://", x)), None)
    if not raw:
        return None
    try:
        u = urlsplit(raw)
        host = (u.hostname or "").lower()
        upath = u.path or "/"
    except Exception:
        return None
    if not host:
        return None
    p = "/".join("…" if _tokenish(s) else s for s in upath.split("/"))
    body = _curl_body(c, w)
    js = _json(body)
    lines = []
    cm = re.search(r"(?:^|\n)\s*(?:HTTP/[\d.]+ )?([1-5]\d\d)\s*$", out)
    code = cm.group(1) if cm else None
    http_failed = bool(code and int(code) >= 400)
    d = js if isinstance(js, dict) else {}
    if "indexnow" in host or re.search(r"/indexnow\b", upath):
        urls = len(d["urlList"]) if isinstance(d.get("urlList"), list) else len(re.findall(r"https?://", str(body or "")))
        title = f"Submitted {_plural(urls, 'URL')} to IndexNow" + (f" for {d['host']}" if d.get("host") else "")
    elif host == "hooks.slack.com" or (host == "slack.com" and "chat.postMessage" in upath):
        title = "Posted to Slack" + (f" in {d['channel']}" if d.get("channel") else "") + (f": {_short(d['text'], 60)}" if isinstance(d.get("text"), str) else "")
    elif re.search(r"(^|\.)discord(app)?\.com$", host) and "/webhooks/" in upath:
        title = "Posted to Discord" + (f": {_short(d['content'], 60)}" if isinstance(d.get("content"), str) else "")
    elif host == "api.telegram.org":
        title = "Sent a Telegram message"
    elif host == "api.resend.com" and "/emails" in upath:
        to = d.get("to")
        to = [x for x in (to if isinstance(to, list) else [to] if to is not None else []) if isinstance(x, str)]
        if to:
            lines.append(f"To {_plural(len(to), 'recipient')} at {_plural(len({x.split('@')[-1].lower() for x in to}), 'domain')}")
        title = "Sent an email via Resend" + (f": {d['subject']}" if isinstance(d.get("subject"), str) else "")
    elif host == "api.stripe.com":
        parts = upath.split("/")
        res = parts[2] if len(parts) > 2 else ""
        rid = parts[3] if len(parts) > 3 else ""
        what = f"Stripe {_singular(res)}" if res else "Stripe"
        title = (f"Deleted {what}" + (f" {rid}" if rid else "")) if method == "DELETE" else f"Updated {what} {rid}" if rid else f"Created a {what}"
        if len(parts) > 4:
            title = f"Called the Stripe API: {method} {p}"
    elif host == "api.github.com":
        m = re.match(r"^/repos/([\w.-]+/[\w.-]+)/(issues|pulls|releases|dispatches|actions/workflows/[^/]+/dispatches)(?:/(\d+)/comments)?$", upath)
        if m and method == "POST":
            kind = ("Commented on #" + m.group(3)) if m.group(3) else {"issues": "Opened a GitHub issue", "pulls": "Opened a pull request", "releases": "Created a GitHub release", "dispatches": "Triggered a repository dispatch"}.get(m.group(2), "Triggered a GitHub workflow")
            title = f"{kind} in {m.group(1)}" + (f": {d['title']}" if isinstance(d.get("title"), str) else f": {d['name']}" if isinstance(d.get("name"), str) else "")
        else:
            title = f"Called the GitHub API: {method} {p}"
    elif host == "api.vercel.com":
        title = (f"Created a Vercel deployment" + (f" of {d['name']}" if isinstance(d.get("name"), str) else "")) if re.search(r"/deployments$", upath) and method == "POST" else f"Called the Vercel API: {method} {p}"
    else:
        title = f"Called {method} {host}{'' if p == '/' else p}"
    hidden = host in ("hooks.slack.com", "api.telegram.org") or "/webhooks/" in upath
    lines.append(f"Request: {method} {host}{' (path hidden)' if hidden else p}")
    if isinstance(js, dict):
        lines.append(f"Body fields: {', '.join(list(js.keys())[:12])}")
    if code:
        lines.append(f"HTTP {code}")
    if c["failed"] or http_failed:
        reason = f"HTTP {code}" if http_failed else failure_reason(out, c["exit_code"])
        return {"failed": True, "reason": reason, "title": f"Failed: {title}", "lines": lines}
    return {"title": title, "lines": lines}


def _describe_mail(c):
    w = words(c["segment"])
    subject = _opt(w, ["-s", "--subject"])
    to = [x for x in w if re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", x)]
    lines = [f"To {_plural(len(to), 'recipient')} at {_plural(len({x.split('@')[-1].lower() for x in to}), 'domain')}"] if to else []
    if c["failed"]:
        return _fail(c, "Sending an email" + (f' "{subject}"' if subject else ""), lines)
    title = f"Sent an email: {subject}" if subject else f"Sent an email to {_plural(len(to), 'recipient')}" if to else "Sent an email"
    return {"title": title, "lines": lines}


_DESCRIBE = {
    "git-push": _describe_push,
    "git-commit": _describe_commit,
    "gh-pr-create": _describe_pr_create,
    "gh-pr-merge": _describe_pr_merge,
    "gh-release": _describe_release,
    "vercel-deploy": _describe_vercel,
    "vercel-env": _describe_vercel_env,
    "railway": _describe_railway,
    "fly": _describe_fly,
    "wrangler": _describe_wrangler,
    "netlify": _describe_netlify,
    "kubectl": _describe_kubectl,
    "terraform": _describe_terraform,
    "docker-push": _describe_docker,
    "npm-publish": _describe_publish,
    "eas": _describe_eas,
    "xcrun-altool": _describe_app_upload,
    "stripe": _describe_stripe_cli,
    "db-migrate": _describe_migrate,
    "psql-write": _describe_psql,
    "curl-write": _describe_curl,
    "send-mail": _describe_mail,
}


def safe_command(rule_id: str, cmd: str) -> str:
    """The command as shown at the end of the details: redacted, with values that don't belong in a log masked."""
    s = redact(cmd)
    if rule_id in ("vercel-env", "railway", "fly", "wrangler"):
        s = re.sub(r"""\b([A-Z][A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)""", r"\1=[redacted]", s)
        s = re.sub(r"""(--value[= ])("[^"]*"|'[^']*'|\S+)""", r"\1[redacted]", s)
        s = re.sub(r"""\b(echo|printf)\s+("[^"]*"|'[^']*'|[^|;&]+?)(\s*\|)""", r"\1 [redacted]\3", s)
    if rule_id == "curl-write":
        s = re.sub(r"""(\s(?:-d|--data|--data-raw|--data-binary|--data-urlencode|--json|-F|--form|-H|--header|-u|--user)(?:\s+|=))("[^"]*"|'[^']*'|\S+)""", r"\1…", s)
        s = re.sub(r"""(https?://[^\s"'?]+)\?[^\s"']*""", r"\1?…", s)
        s = re.sub(r"""(hooks\.slack\.com|api\.telegram\.org)/[^\s"']*""", r"\1/…", s)
        s = re.sub(r"""(/webhooks/)[^\s"']*""", r"\1…", s)
    if rule_id == "psql-write":
        s = re.sub(r"""(\s(?:-c|--command)(?:\s+|=))("[^"]*"|'[^']*'|\S+)""", r'\1"…"', s)
    s = re.sub(r"""[^\s@"'<>,;]+@([\w-]+\.)+[\w-]+""", lambda m: "[email]" if re.match(r"^[\w.+-]+@[\w.-]+\.[a-z]{2,}$", m.group(0), re.I) else m.group(0), s)
    return _short(s, 1500)


def mask_quoted(cmd: str, quotes: bool = True) -> str:
    """The command with heredoc bodies (and, if quotes, quoted text) blanked out, keeping every index."""

    def blank(m):
        body, end = m.group(3), m.group(4)
        whole = m.group(0)
        return whole[: len(whole) - len(body) - len(end)] + re.sub(r"[^\n]", " ", body) + end

    s = re.sub(r"""<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(\n[ \t]*\2[ \t]*(?=\n|$)|$)""", blank, str(cmd))
    if not quotes:
        return s
    out, q = [], None
    for ch in s:
        if q:
            if ch == q:
                q = None
                out.append(ch)
            else:
                out.append(" ")
        else:
            if ch in "\"'":
                q = ch
            out.append(ch)
    return "".join(out)


def separators(cmd: str) -> list:
    """Shell separators (&&, ||, ;, |) outside quotes, as (index, length)."""
    out, q, i = [], None, 0
    while i < len(cmd):
        ch = cmd[i]
        if q:
            if ch == q:
                q = None
        elif ch in "\"'":
            q = ch
        elif ch == ";":
            out.append((i, 1))
        elif ch in "&|" and i + 1 < len(cmd) and cmd[i + 1] == ch:
            out.append((i, 2))
            i += 1
        elif ch == "|":
            out.append((i, 1))
        i += 1
    return out


_PUBLIC_HOST = re.compile(r"\b[\w-]+\.(?:vercel\.app|netlify\.app|fly\.dev|workers\.dev|pages\.dev|up\.railway\.app)\b")


def _redact_text(s) -> str:
    """redact() that leaves public deployment hostnames (app-x7k2-team.vercel.app) alone."""
    keep = []

    def hide(m):
        keep.append(m.group(0))
        return f"\x00{len(keep) - 1}\x00"

    return re.sub(r"\x00(\d+)\x00", lambda m: keep[int(m.group(1))], redact(_PUBLIC_HOST.sub(hide, str(s))))


def redact_keep_urls(s) -> str:
    """redact(), but a URL keeps its shape: each path segment is checked on its own."""
    parts = re.split(r"""(https?://[^\s"'<>]+)""", str(s))
    return "".join(
        "/".join(_redact_text(x) for x in re.sub(r"^(https?://)[^\s:@/]+:[^\s@/]+@", r"\1[redacted]@", p).split("/")) if i % 2 else _redact_text(p)
        for i, p in enumerate(parts)
    )


def _title(t) -> str:
    return _short(_redact_text(str(t)).replace("`", ""), 120)


# ---------- MCP ----------

_MCP_PAST = {
    "create": "created", "update": "updated", "delete": "deleted", "remove": "removed", "send": "sent", "post": "posted",
    "publish": "published", "deploy": "deployed", "merge": "merged", "push": "pushed", "submit": "submitted",
    "cancel": "cancelled", "refund": "refunded", "charge": "charged", "invite": "invited", "set": "set", "add": "added",
    "upload": "uploaded", "write": "wrote", "reply": "replied to", "comment": "commented on", "approve": "approved",
    "close": "closed", "archive": "archived",
}
_BRANDS = {"github": "GitHub", "gitlab": "GitLab", "hubspot": "HubSpot", "openai": "OpenAI", "posthog": "PostHog", "youtube": "YouTube", "linkedin": "LinkedIn", "clickup": "ClickUp", "gmail": "Gmail", "mcp": "MCP"}
_ID_KEYS = ["title", "name", "subject", "summary", "label", "filename", "file_name", "path", "url", "slug", "channel", "repo", "repository", "branch", "tag", "email_subject"]
_TEXT_KEYS = ["text", "message", "content", "body", "description", "query"]


def _mask_emails(s) -> str:
    return re.sub(r"[\w.+-]+@([\w-]+\.)+[a-z]{2,}", "[email]", str(s), flags=re.I)


def server_name(server: str) -> str:
    s = re.sub(r"^plugin_[^_]+_", "", re.sub(r"^claude_ai_", "", str(server), flags=re.I), flags=re.I)
    return " ".join(_BRANDS.get(x.lower(), _cap(x)) for x in re.split(r"[-_]+", s) if x) or "MCP"


def _scalar(v) -> str:
    return ("true" if v else "false") if isinstance(v, bool) else str(v)


def _identifying_arg(args):
    level = [args]
    for depth in range(4):
        if not level:
            break
        for keys in (_ID_KEYS, _TEXT_KEYS):
            for k in keys:
                for o in level:
                    v = o.get(k) if isinstance(o, dict) else None
                    if (isinstance(v, str) and v.strip()) or (isinstance(v, (int, float)) and not isinstance(v, bool)):
                        return _short(_mask_emails(redact(_scalar(v))), 60)
            if depth > 0:
                break
        nxt = []
        for o in level:
            if isinstance(o, list):
                nxt += o[:3]
            elif isinstance(o, dict):
                nxt += list(o.values())
        level = [o for o in nxt if isinstance(o, (dict, list)) and o]
    return None


def _describe_mcp(server, tool, args, c):
    S = server_name(server)
    server_words = set(str(server).lower().split("-")) | set(re.split(r"[-_]+", str(server).lower()))
    parts = [x for x in re.split(r"[_\-.\s]+", re.sub(r"([a-z])([A-Z])", r"\1_\2", tool).lower()) if x and x not in server_words]
    vi = next((i for i, x in enumerate(parts) if x in _MCP_PAST), -1)
    verb = parts[vi] if vi >= 0 else None
    after = parts[vi + 1 :] if vi >= 0 else parts
    obj = " ".join(after if after else (parts[:vi] if vi >= 0 else []))
    ident = _identifying_arg(args)
    lines = []
    scalars = [f"{k}: {_short(_mask_emails(redact(_scalar(v))), 80)}" for k, v in (args.items() if isinstance(args, dict) else []) if isinstance(v, (str, int, float, bool))]
    if scalars:
        lines.append(f"Arguments: {_short('; '.join(scalars), 600)}")
    link = re.search(r"""https://[^\s"'\\)]+""", _strip(c["output"]))
    if link:
        lines.append(f"Link: {link.group(0)}")
    failed = c["failed"]
    phrase = f"couldn't {verb or 'run'} {obj}".strip() if failed else f"{_MCP_PAST.get(verb, 'ran')} {obj}".strip()
    return {"failed": failed, "reason": failure_reason(c["output"], c["exit_code"]) if failed else None, "title": f"{S} → {phrase}" + (f": {ident}" if ident else ""), "lines": lines}


def _default_git(d):
    def run(args):
        if not d:
            raise RuntimeError("no dir")
        return subprocess.run(["git", "-C", d, *args], capture_output=True, text=True, timeout=2, check=True).stdout.strip()

    return run


def _default_read(f):
    try:
        p = Path(f)
        return p.read_text() if p.stat().st_size < 512 * 1024 else None
    except Exception:
        return None


def _default_ls(d):
    try:
        return os.listdir(d)
    except Exception:
        return []


def read_git(d):
    """{repo, branch, subject} of the git repo at d (repo = the main checkout's folder name), or None."""
    if not d:
        return None
    c = {"dir": d, "git": _default_git(d)}
    g = _repo_info(c)
    subject = _try_git(c, ["log", "-1", "--format=%s"]) if g else None
    return {**g, "subject": subject} if g and subject else None


def classify(tool_name: str, args: dict, cwd: str | None = None, failed: bool = False, output: str = "", exit_code=None, git=None, read_file=None, list_dir=None, now=None, home=None):
    """{type, title, details, rule, status} for a tool call worth recording, or None. git/read_file/list_dir/now/home are injectable (tests)."""
    args = args or {}
    base = {
        "output": str(output or ""),
        "failed": bool(failed),
        "exit_code": exit_code,
        "now": now if now is not None else time.time() * 1000,
        "home": home if home is not None else (os.environ.get("HOME") or str(Path.home())),
    }

    def finish(rule, typ, fallback, d, tail, where=cwd):
        note = "Recorded automatically by the WaveBrain hook" + (f" in {os.path.basename(where)}" if where else "") + "."
        bad = base["failed"] or bool(d and d.get("failed"))
        lines = []
        if bad:
            lines.append(f"Failed: {(d or {}).get('reason') or failure_reason(base['output'], base['exit_code']) or 'the command reported an error'}")
        lines += [redact_keep_urls(l) for l in ((d or {}).get("lines") or [])] + [note, tail]
        return {"type": typ, "title": _title((d or {}).get("title") or fallback), "details": "\n".join(lines), "rule": rule, "status": "failure" if bad else "success"}

    if tool_name.lower() in SHELL_TOOLS:
        cmd = args.get("command") or args.get("cmd") or ""
        if isinstance(cmd, list):
            cmd = " ".join(cmd)
        cmd = str(cmd).strip()
        if not cmd:
            return None
        masked, heredocless = mask_quoted(cmd), mask_quoted(cmd, False)
        for r, rx in _SHELL:
            # Rules fire on the command itself, not on text inside quotes or heredocs, unless the
            # rule looks inside (psql -c "...").
            m = rx.search(heredocless if r.get("match_quoted") else masked)
            if not m:
                continue
            frm = m.start() + len(m.group(1) or "")
            seps = separators(cmd)
            start = max([0] + [i + n for i, n in seps if i + n <= frm])
            ends = [i for i, _ in seps if i >= m.end()]
            seg = cmd[start : min(ends) if ends else len(cmd)].strip()
            d = command_dir(cmd[:start], cwd)
            c = {
                **base,
                "segment": seg,
                "cmd": cmd,
                "dir": d,
                "git": git or _default_git(d),
                "read_file": read_file or _default_read,
                "list_dir": list_dir or _default_ls,
            }
            try:
                desc = _DESCRIBE[r["id"]](c) if r["id"] in _DESCRIBE else None
            except Exception:
                desc = None
            return finish(r["id"], r["type"], r["title"].replace("{cmd}", _short(redact(seg), 120)), desc, f"Command: `{safe_command(r['id'], cmd)}`", d)
        return None
    parts = _mcp_parts(tool_name)
    if parts:
        server, tool = parts
        if server in _SKIP:
            return None
        if not set(re.split(r"[_\-.]+", tool.lower())) & _VERBS:
            return None
        try:
            desc = _describe_mcp(server, tool, args, base)
        except Exception:
            desc = None
        return finish("mcp-write", "api_call", f"Used {server}: {re.sub(r'[_-]+', ' ', tool)}", desc, f"Tool: {server}/{tool}")
    return None


def _queue(session: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", session or "default")[:80]
    return _home() / "queue" / f"hermes-{safe}.jsonl"


_lock = threading.Lock()


def _append(path: Path, item: dict):
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        with open(path, "a") as f:
            f.write(json.dumps(item) + "\n")
        os.chmod(path, 0o600)


def _read(path: Path) -> list:
    try:
        out = []
        for line in path.read_text().splitlines():
            try:
                out.append(json.loads(line))
            except Exception:
                pass
        return out
    except Exception:
        return []


def _rewrite(path: Path, items: list):
    if not items:
        path.unlink(missing_ok=True)
        return
    tmp = path.with_suffix(f".tmp-{os.getpid()}")
    tmp.write_text("".join(json.dumps(i) + "\n" for i in items))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def flush(session: str) -> dict:
    cfg = _config()
    path = _queue(session)
    with _lock:
        items = _read(path)
        if not items:
            return {"sent": 0, "skipped": 0, "kept": 0}
        now = time.time() * 1000
        last_log = max([i["at"] for i in items if i.get("kind") == "agent_logged"], default=float("-inf"))
        actions, seen = [], set()
        for i in items:
            if i.get("kind") != "action" or i["at"] <= last_log or now - i["at"] >= MAX_AGE * 1000:
                continue
            k = f"{i['payload'].get('title')}|{round(i['at'] / 5000)}"
            if k not in seen:
                seen.add(k)
                actions.append(i)
        skipped = sum(1 for i in items if i.get("kind") == "action") - len(actions)
        if not (cfg["apiKey"] and cfg["enabled"]):
            _rewrite(path, actions)
            return {"sent": 0, "skipped": skipped, "kept": len(actions)}
        keep, sent = [], 0
        for n, item in enumerate(actions):
            if n >= MAX_PER_FLUSH:
                keep.append(item)
                continue
            req = urllib.request.Request(
                cfg["apiUrl"],
                data=json.dumps(item["payload"]).encode(),
                headers={"content-type": "application/json", "authorization": f"Bearer {cfg['apiKey']}"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=5) as r:
                    if 200 <= r.status < 300:
                        sent += 1
            except urllib.error.HTTPError as e:
                if e.code not in (400, 401, 402):
                    keep.append(item)
            except Exception:
                keep.append(item)
        _rewrite(path, keep)
        return {"sent": sent, "skipped": skipped, "kept": len(keep)}


def _flush_bg(session: str):
    threading.Thread(target=flush, args=(session,), daemon=True).start()


def _result_text(result):
    """(output text, exit code) from a Hermes tool result: a JSON string like {"output", "exit_code", "error"}, or text."""
    exit_code = None
    data = result
    if isinstance(result, str):
        try:
            data = json.loads(result)
        except Exception:
            data = result
    if isinstance(data, dict):
        parts = [data[k] for k in ("output", "stdout", "stderr", "error", "result", "content") if isinstance(data.get(k), str)]
        ec = data.get("exit_code", data.get("returncode"))
        exit_code = ec if isinstance(ec, int) and not isinstance(ec, bool) else None
        text = "\n".join(parts) if parts else json.dumps(data, default=str)
    else:
        text = str(data or "")
        m = re.search(r'"exit_code"\s*:\s*(-?\d+)', text)
        exit_code = int(m.group(1)) if m else None
    if len(text) > 20000:
        text = text[:5000] + "\n…\n" + text[-15000:]
    return text, exit_code


def on_post_tool_call(tool_name=None, args=None, result=None, session_id=None, status=None, error_message=None, **kwargs):
    try:
        cfg = _config()
        if not cfg["enabled"]:
            return
        name = str(tool_name or "")
        args = args if isinstance(args, dict) else {}
        session = str(session_id or kwargs.get("task_id") or "default")
        now = time.time() * 1000
        if re.search(r"wavebrain.*log_action$", name, re.I):
            _append(_queue(session), {"kind": "agent_logged", "at": now})
            return
        failed = status not in (None, "success", "ok") or bool(error_message)
        output, exit_code = _result_text(result)
        if error_message:
            output = f"{output}\n{error_message}".strip()
        if exit_code not in (None, 0):
            failed = True
        action = classify(name, args, args.get("workdir") or os.getcwd(), failed, output, exit_code)
        if not action:
            return
        cwd = args.get("workdir")
        payload = {
            "agent": agent_name(),
            "type": action["type"],
            "title": action["title"],
            "details": action["details"],
            "status": action["status"],
            "metadata": {"source": "wavebrain-hook", "host": "hermes", "rule": action["rule"]},
        }
        bot = bot_name()
        if bot:
            payload["bot"] = bot
        if cwd:
            payload["project"] = os.path.basename(str(cwd))[:200]
        path = _queue(session)
        _append(path, {"kind": "action", "at": now, "payload": payload})
        if any(i.get("kind") == "action" and now - i["at"] > STALE * 1000 for i in _read(path)):
            _flush_bg(session)
    except Exception:
        pass


def on_session_end(session_id=None, **kwargs):
    try:
        _flush_bg(str(session_id or kwargs.get("task_id") or "default"))
    except Exception:
        pass


def register(ctx):
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("on_session_end", on_session_end)
    if hasattr(ctx, "register_system_prompt_section"):
        ctx.register_system_prompt_section("wavebrain.logging", instruction(), position="after_memory", max_chars=1500)
