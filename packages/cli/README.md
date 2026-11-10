# wavebrain

Connect your AI agents to [WaveBrain](https://getwavebrain.com), the audit log of what your agents do.

```sh
npx wavebrain init
```

`init` finds the agents installed on this machine, lets you pick which ones to connect (nothing is
selected unless you choose it), asks for an API key (or opens
[getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup) to create one), and adds
the WaveBrain MCP server to each agent's own config:

| Agent | File | Key stored |
| --- | --- | --- |
| Claude Code | `~/.claude.json` (+ optional `mcp__wavebrain__*` in `~/.claude/settings.json`) | in the server's header |
| Codex CLI | `~/.codex/config.toml` | header, or `bearer_token_env_var` when you run with `WAVEBRAIN_API_KEY` set |
| Cursor | `~/.cursor/mcp.json` | header |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | header |
| Claude Desktop | `claude_desktop_config.json` (via `mcp-remote`) | `env` of the server entry |
| VS Code (Copilot) | user-profile `mcp.json` | header |
| Hermes Agent | `~/.hermes/config.yaml` and each profile's | `WAVEBRAIN_API_KEY` in the profile's `.env`; config.yaml only references it |

For Claude Code, Codex, Cursor and Hermes, `init` also installs **auto-capture**: hooks (a Hermes
plugin for Hermes) that record deploys, pushes, releases, payments, emails and database writes even
when the model forgets to call `log_action`, plus a short skill telling it when to log. Actions are
queued locally in `~/.wavebrain/queue`, sent at the end of each turn, and skipped if the agent logged
them itself. Secrets are redacted first. Use `--no-hooks` for the MCP server only, or set
`WAVEBRAIN_HOOKS=off` to pause capture.

Every file is copied to `<file>.bak-wavebrain` before it's changed, re-running is safe, and the full
key is never printed. Servers named `wavebrain` that you added yourself are left alone.

## Commands

```sh
npx wavebrain init                         # interactive
npx wavebrain init --agent cursor --agent hermes --key al_…   # non-interactive
WAVEBRAIN_API_KEY=al_… npx wavebrain init --agent codex
npx wavebrain init --dry-run               # show what would change
npx wavebrain status                       # which agents are configured
npx wavebrain remove                       # undo exactly what init added
```

Agent names: `claude-code`, `codex`, `cursor`, `windsurf`, `claude-desktop`, `vscode`, `hermes`,
`hermes:<profile>`. Other options: `--no-hooks`, `--no-claude-permission`, `--yes`, `--url <mcp url>`.

What init added is recorded (file paths only, no keys) in `~/.wavebrain/installed.json`, so `remove`
can undo it without touching anything else.
