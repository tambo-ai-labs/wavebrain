# wavebrain-claude-code

Connect Claude Code to [WaveBrain](https://getwavebrain.com), the audit log of what your AI agents do.

```sh
npx wavebrain-claude-code install
```

It asks for an API key (or opens [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup) to create one; `--key` or `WAVEBRAIN_API_KEY` skip the prompt).

Adds the `wavebrain` MCP server to `~/.claude.json`, pre-approves `mcp__wavebrain__*` in `~/.claude/settings.json` (skip with `--no-claude-permission`), adds the auto-capture hooks (PostToolUse, PostToolUseFailure, Stop, SessionEnd) to the same file, and installs the skill in `~/.claude/skills/wavebrain`.

Prefer Claude Code's plugin system? Once the repo is public: `/plugin marketplace add GuillermoCoding/wavebrain` then `/plugin install wavebrain@wavebrain`. Use one or the other, not both.

**Auto-capture:** the hooks record deploys, pushes, releases, publishes, payments, emails and database writes even when the model forgets to call `log_action`. They queue locally in `~/.wavebrain/queue`, send at the end of each turn, and skip anything the agent logged itself. Secrets are redacted first. `--no-hooks` installs the MCP server only; `WAVEBRAIN_HOOKS=off` pauses capture.

```sh
npx wavebrain-claude-code status
npx wavebrain-claude-code uninstall   # undoes exactly what install added
```

Every changed file is backed up to `<file>.bak-wavebrain`. `--dry-run` shows the changes without writing.
