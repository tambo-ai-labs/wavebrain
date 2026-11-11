# WaveBrain agent integrations

Everything that connects AI agents to [WaveBrain](https://getwavebrain.com), the audit log of what your agents did: a one-command installer and a plugin for each agent platform, in one repo.

Install the way each agent installs plugins:

| Agent | Install | What it adds |
| --- | --- | --- |
| Claude Code | `/plugin marketplace add tambo-ai-labs/wavebrain`<br>`/plugin install wavebrain@wavebrain` | MCP server, hooks (PostToolUse, PostToolUseFailure, Stop, SessionEnd) and a when-to-log skill. Claude Code asks for your API key and keeps it in the system keychain. |
| Codex CLI | `codex plugin marketplace add tambo-ai-labs/wavebrain`<br>`codex plugin add wavebrain@wavebrain` | MCP server, hooks (PostToolUse, Stop) and the skill. Reads the key from `WAVEBRAIN_API_KEY`, so export it in your shell profile. Then open `/hooks` in Codex once and trust the two WaveBrain hooks. |
| Cursor | `npx wavebrain-cursor install` | MCP server in `~/.cursor/mcp.json`; hooks in `~/.cursor/hooks.json` |
| Hermes Agent | `npx wavebrain-hermes install [--profile <name>] [--all-profiles]` | MCP server in each profile's `config.yaml`; key in its `.env`; plugin in `<profile>/plugins/wavebrain` |

Cursor and Hermes keep an installer for now. Cursor's marketplace only lists plugins after Cursor reviews them, and a Hermes plugin with hooks can't also add the MCP server or cover several profiles. The installers have `install`, `status` and `uninstall` (which undoes exactly what install added), plus `--no-hooks` (MCP server only), `--dry-run` and `--key`.

Windsurf, VS Code and Claude Desktop only need the MCP server: the setup page at getwavebrain.com/dashboard/setup has copy-paste config and one-click links. `npx wavebrain` prints all of these commands.

## Why hooks

With only an MCP server, an action is logged only if the model remembers to call `log_action`. Hooks make the record dependable:

1. **observe** (after each tool call): if the call is high-stakes (deploy, push, merge, release, publish, payment, email, database write, a write-type MCP tool), queue it in `~/.wavebrain/queue/`. Local only, instant, never blocks the agent.
2. **flush** (end of each turn): send queued actions to `POST /api/v1/actions`. Anything captured before the agent's own `log_action` in that turn is dropped, so the agent's clearer entry wins and nothing is counted twice. Failed uploads stay queued and retry next turn.

Secrets (Stripe, GitHub, npm, AWS, OpenAI/Anthropic, Slack, JWTs, bearer tokens, `password=`, URL credentials, long opaque strings) are redacted before anything leaves the machine. Turn capture off with `WAVEBRAIN_HOOKS=off`, or `"autoCapture": false` in `~/.wavebrain/config.json`.

## Layout

```
.claude-plugin/marketplace.json   Claude Code marketplace (lists plugins/claude-code)
.agents/plugins/marketplace.json  Codex marketplace (lists plugins/codex)
packages/cursor/                  npx wavebrain-cursor
packages/hermes/                  npx wavebrain-hermes
packages/wavebrain/               npx wavebrain: points to the installers above
packages/core/                    the engine both installers share (not published; copied into each lib/)
plugins/claude-code/              Claude Code plugin: MCP + hooks + skill
plugins/hermes/                   Hermes plugin: hooks + system-prompt section (Python)
plugins/codex/                    Codex plugin: MCP + hooks + skill
shared/                           the one copy of the hook runner, rules, and skill
scripts/sync.mjs                  copies shared/ and packages/core into every plugin and installer
```

Edit `shared/`, `plugins/hermes/__init__.py` or `packages/core/src`, then run `node scripts/sync.mjs`. The tests fail if a copy is out of date.

## Hermes without the installer

`hermes plugins install tambo-ai-labs/wavebrain#plugins/hermes` installs only the auto-capture plugin, for one profile. You then add the MCP server and `WAVEBRAIN_API_KEY` yourself; the installer does all of that, for every profile you pick.

## Development

```sh
npm test                 # shared core, Hermes parity, CLI
node scripts/sync.mjs    # after editing shared/
bash scripts/e2e-marketplace.sh claude|codex   # marketplace plugins in real agent runs
bash scripts/e2e.sh hermes:<profile>          # the Hermes installer in a real run
```
