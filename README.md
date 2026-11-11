# WaveBrain agent integrations

Everything that connects AI agents to [WaveBrain](https://getwavebrain.com), the audit log of what your agents did: a one-command installer and a plugin for each agent platform, in one repo.

Each agent harness has its own installer:

| Agent | Install | What it adds |
| --- | --- | --- |
| Claude Code | `npx wavebrain-claude-code install` | MCP server in `~/.claude.json`; hooks (PostToolUse, PostToolUseFailure, Stop, SessionEnd) in `~/.claude/settings.json`; skill in `~/.claude/skills/wavebrain` |
| Codex CLI | `npx wavebrain-codex install` | MCP server in `~/.codex/config.toml`; hooks in `~/.codex/hooks.json` + `[features] hooks = true`; skill in `~/.codex/skills/wavebrain` |
| Cursor | `npx wavebrain-cursor install` | MCP server in `~/.cursor/mcp.json`; hooks in `~/.cursor/hooks.json` |
| Hermes Agent | `npx wavebrain-hermes install [--profile <name>] [--all-profiles]` | MCP server in each profile's `config.yaml`; key in its `.env`; plugin in `<profile>/plugins/wavebrain` |

Windsurf, VS Code and Claude Desktop only need the MCP server, so they have no installer: the setup page at getwavebrain.com/dashboard/setup has copy-paste config and one-click links. `npx wavebrain` lists these commands and marks the agents it finds.

Every installer has `install`, `status` and `uninstall` (which undoes exactly what install added), plus `--no-hooks` (MCP server only), `--dry-run` and `--key`.

**Codex** reviews new hooks before running them: after installing, start `codex`, open `/hooks` and trust the two WaveBrain hooks. Until then Codex still has the MCP server, just not auto-capture.

## Why hooks

With only an MCP server, an action is logged only if the model remembers to call `log_action`. Hooks make the record dependable:

1. **observe** (after each tool call): if the call is high-stakes (deploy, push, merge, release, publish, payment, email, database write, a write-type MCP tool), queue it in `~/.wavebrain/queue/`. Local only, instant, never blocks the agent.
2. **flush** (end of each turn): send queued actions to `POST /api/v1/actions`. Anything captured before the agent's own `log_action` in that turn is dropped, so the agent's clearer entry wins and nothing is counted twice. Failed uploads stay queued and retry next turn.

Secrets (Stripe, GitHub, npm, AWS, OpenAI/Anthropic, Slack, JWTs, bearer tokens, `password=`, URL credentials, long opaque strings) are redacted before anything leaves the machine. Turn capture off with `WAVEBRAIN_HOOKS=off`, or `"autoCapture": false` in `~/.wavebrain/config.json`.

## Layout

```
.claude-plugin/marketplace.json   Claude Code marketplace (lists plugins/claude-code)
packages/claude-code/             npx wavebrain-claude-code (npm: wavebrain-claude-code)
packages/codex/                   npx wavebrain-codex
packages/cursor/                  npx wavebrain-cursor
packages/hermes/                  npx wavebrain-hermes
packages/wavebrain/               npx wavebrain: points to the installers above
packages/core/                    the engine all four share (not published; copied into each lib/)
plugins/claude-code/              Claude Code plugin: MCP + hooks + skill
plugins/hermes/                   Hermes plugin: hooks + system-prompt section (Python)
plugins/codex/                    Codex skill
shared/                           the one copy of the hook runner, rules, and skill
scripts/sync.mjs                  copies shared/ and packages/core into every plugin and installer
```

Edit `shared/`, `plugins/hermes/__init__.py` or `packages/core/src`, then run `node scripts/sync.mjs`. The tests fail if a copy is out of date.

## Other ways to install

- **Claude Code marketplace:** `/plugin marketplace add GuillermoCoding/wavebrain`, then `/plugin install wavebrain@wavebrain`. Set `WAVEBRAIN_API_KEY`.
- **Hermes:** `hermes plugins install GuillermoCoding/wavebrain#plugins/hermes`, then `hermes plugins enable wavebrain`.

Use one route per agent; installing both the marketplace plugin and the installer's hooks would capture twice (duplicates are collapsed, but don't rely on it).

(The repo is private for now; those two routes need it public.)

## Development

```sh
npm test                 # shared core, Hermes parity, CLI
node scripts/sync.mjs    # after editing shared/
bash scripts/e2e.sh claude|claude-plugin|codex|hermes:<profile>   # real agent runs against a mock API
```
