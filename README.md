# WaveBrain agent integrations

Everything that connects AI agents to [WaveBrain](https://getwavebrain.com), the audit log of what your agents did: the `npx wavebrain init` installer and a plugin for every agent platform, in one repo.

```sh
npx wavebrain init
```

`init` finds the agents on this machine, asks which to connect, and installs everything each one supports:

| Agent | MCP server | Auto-capture hooks | When-to-log instructions |
| --- | --- | --- | --- |
| Claude Code | `~/.claude.json` | `~/.claude/settings.json` (PostToolUse, PostToolUseFailure, Stop, SessionEnd) | skill in `~/.claude/skills/wavebrain` |
| Codex CLI | `~/.codex/config.toml` | `~/.codex/hooks.json` (PostToolUse, Stop) + `[features] hooks = true` | skill in `~/.codex/skills/wavebrain` |
| Cursor | `~/.cursor/mcp.json` | `~/.cursor/hooks.json` (postToolUse, stop) | MCP server instructions |
| Hermes Agent | each profile's `config.yaml` | plugin in `<profile>/plugins/wavebrain` (post_tool_call, on_session_end) | plugin system-prompt section |
| Windsurf, VS Code, Claude Desktop | their MCP config | no hook support | MCP server instructions |

**Codex** reviews new hooks before running them: after `init`, start `codex`, open `/hooks` and trust the two WaveBrain hooks. Until then Codex still has the MCP server, just not auto-capture.

`npx wavebrain remove` undoes exactly what `init` added. `--no-hooks` installs the MCP server only.

## Why hooks

With only an MCP server, an action is logged only if the model remembers to call `log_action`. Hooks make the record dependable:

1. **observe** (after each tool call): if the call is high-stakes (deploy, push, merge, release, publish, payment, email, database write, a write-type MCP tool), queue it in `~/.wavebrain/queue/`. Local only, instant, never blocks the agent.
2. **flush** (end of each turn): send queued actions to `POST /api/v1/actions`. Anything captured before the agent's own `log_action` in that turn is dropped, so the agent's clearer entry wins and nothing is counted twice. Failed uploads stay queued and retry next turn.

Secrets (Stripe, GitHub, npm, AWS, OpenAI/Anthropic, Slack, JWTs, bearer tokens, `password=`, URL credentials, long opaque strings) are redacted before anything leaves the machine. Turn capture off with `WAVEBRAIN_HOOKS=off`, or `"autoCapture": false` in `~/.wavebrain/config.json`.

## Layout

```
.claude-plugin/marketplace.json   Claude Code marketplace (lists plugins/claude-code)
packages/cli/                     npx wavebrain (npm: wavebrain)
plugins/claude-code/              Claude Code plugin: MCP + hooks + skill
plugins/hermes/                   Hermes plugin: hooks + system-prompt section (Python)
plugins/codex/                    Codex skill (hooks are installed by the CLI)
shared/                           the one copy of the hook runner, rules, and skill
scripts/sync.mjs                  copies shared/ into every plugin and the CLI package
```

Edit `shared/` (or `plugins/hermes/__init__.py`), then run `node scripts/sync.mjs`. The tests fail if a copy is out of date.

## Other ways to install

- **Claude Code marketplace:** `/plugin marketplace add GuillermoCoding/wavebrain`, then `/plugin install wavebrain@wavebrain`. Set `WAVEBRAIN_API_KEY`.
- **Hermes:** `hermes plugins install GuillermoCoding/wavebrain#plugins/hermes`, then `hermes plugins enable wavebrain`.

Use one route per agent; installing both the marketplace plugin and `init`'s hooks would capture twice (duplicates are collapsed, but don't rely on it).

(The repo is private for now; those two routes need it public.)

## Development

```sh
npm test                 # shared core, Hermes parity, CLI
node scripts/sync.mjs    # after editing shared/
bash scripts/e2e-claude-code.sh "$PWD/shared/hook.mjs"   # real Claude Code run against a mock API
```
