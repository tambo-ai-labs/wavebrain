# wavebrain-codex

Connect Codex CLI to [WaveBrain](https://getwavebrain.com), the audit log of what your AI agents do.

```sh
npx wavebrain-codex install
```

It asks for an API key (or opens [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup) to create one; `--key` or `WAVEBRAIN_API_KEY` skip the prompt).

Adds `[mcp_servers.wavebrain]` to `~/.codex/config.toml` (or `$CODEX_HOME`), the hooks to `~/.codex/hooks.json` with `[features] hooks = true`, and the skill to `~/.codex/skills/wavebrain`.

**One manual step:** Codex runs a new hook only after you trust it. Start `codex`, open `/hooks` and trust the two WaveBrain hooks.

**Auto-capture:** the hooks record deploys, pushes, releases, publishes, payments, emails and database writes even when the model forgets to call `log_action`. They queue locally in `~/.wavebrain/queue`, send at the end of each turn, and skip anything the agent logged itself. Secrets are redacted first. `--no-hooks` installs the MCP server only; `WAVEBRAIN_HOOKS=off` pauses capture.

```sh
npx wavebrain-codex status
npx wavebrain-codex uninstall   # undoes exactly what install added
```

Every changed file is backed up to `<file>.bak-wavebrain`. `--dry-run` shows the changes without writing.
