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


def read_git(d):
    """{repo, branch, subject} of the git repo at d (repo = the main checkout's folder name), or None."""
    if not d:
        return None
    try:
        def run(*a):
            return subprocess.run(["git", "-C", d, *a], capture_output=True, text=True, timeout=2, check=True).stdout.strip()

        common = os.path.normpath(os.path.join(d, run("rev-parse", "--git-common-dir")))
        base = os.path.basename(common)
        repo = os.path.basename(os.path.dirname(common)) if base == ".git" else re.sub(r"\.git$", "", base)
        branch = run("rev-parse", "--abbrev-ref", "HEAD")
        subject = run("log", "-1", "--format=%s")
        return {"repo": repo, "branch": "" if branch == "HEAD" else branch, "subject": subject} if repo and subject else None
    except Exception:
        return None


def pushed_branch(segment: str):
    words = str(segment).split()
    i = words.index("push") + 1 if "push" in words else len(words)
    args = [w for w in words[i:] if not w.startswith("-")]
    if len(args) < 2:
        return None
    ref = args[1].lstrip("+").split(":")[-1]
    ref = re.sub(r"^refs/heads/", "", ref)
    return ref if ref and ref != "HEAD" else None


def git_title(template, rule_id, segment, git):
    if not template or not git:
        return None
    branch = (rule_id == "git-push" and pushed_branch(segment)) or git["branch"]
    t = template
    if not branch:
        t = t.replace("/{branch}", "").replace("{branch}", "")
    return t.replace("{repo}", git["repo"]).replace("{branch}", branch or "").replace("{subject}", _short(redact(git["subject"]), 120))


def classify(tool_name: str, args: dict, cwd: str | None = None, failed: bool = False, git_reader=read_git):
    args = args or {}
    where = f" in {os.path.basename(cwd)}" if cwd else ""
    outcome = " It failed." if failed else ""
    if tool_name.lower() in SHELL_TOOLS:
        cmd = args.get("command") or args.get("cmd") or ""
        if isinstance(cmd, list):
            cmd = " ".join(cmd)
        cmd = str(cmd).strip()
        if not cmd:
            return None
        for r, rx in _SHELL:
            m = rx.search(cmd)
            if not m:
                continue
            frm = m.start() + len(m.group(1) or "")
            start = max([0] + [cmd.rfind(d, 0, frm) + len(d) for d in ("&&", ";", "|") if cmd.rfind(d, 0, frm) >= 0])
            ends = [i for i in (cmd.find(d, m.end()) for d in ("&&", ";", "|")) if i >= 0]
            seg = cmd[start : min(ends) if ends else len(cmd)].strip()
            # Readable git titles when the repo can be read; the command itself otherwise.
            pretty = None
            if r.get("git_title") and not failed:
                pretty = git_title(r["git_title"], r["id"], seg, git_reader(command_dir(cmd[:start], cwd)))
            return {
                "type": r["type"],
                "title": _short(pretty or r["title"].replace("{cmd}", _short(redact(seg), 120)), 200),
                "details": f"Ran `{_short(redact(cmd), 1500)}`{where}.{outcome} (Recorded automatically by the WaveBrain hook.)",
                "rule": r["id"],
            }
        return None
    parts = _mcp_parts(tool_name)
    if parts:
        server, tool = parts
        if server in _SKIP:
            return None
        if not set(re.split(r"[_\-.]+", tool.lower())) & _VERBS:
            return None
        return {
            "type": "api_call",
            "title": _short(f"Used {server}: {re.sub(r'[_-]+', ' ', tool)}", 200),
            "details": f"Called the MCP tool {server}/{tool}{where} with {redact(json.dumps(args, default=str))[:1500]}.{outcome} (Recorded automatically by the WaveBrain hook.)",
            "rule": "mcp-write",
        }
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
        if not failed and isinstance(result, str):
            m = re.search(r'"exit_code"\s*:\s*(-?\d+)', result)
            failed = bool(m and m.group(1) != "0")
        action = classify(name, args, args.get("workdir") or os.getcwd(), failed)
        if not action:
            return
        cwd = args.get("workdir")
        payload = {
            "agent": agent_name(),
            "type": action["type"],
            "title": action["title"],
            "details": action["details"],
            "status": "failure" if failed else "success",
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
