# wavebrain-cursor

Connect Cursor to [WaveBrain](https://getwavebrain.com), the audit log of what your AI agents do.

```sh
npx wavebrain-cursor install
```

It asks for an API key (or opens [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup) to create one; `--key` or `WAVEBRAIN_API_KEY` skip the prompt).

Adds the `wavebrain` MCP server to `~/.cursor/mcp.json` and the hooks (`postToolUse`, `stop`) to `~/.cursor/hooks.json`.

**Auto-capture:** the hooks record deploys, pushes, releases, publishes, payments, emails and database writes even when the model forgets to call `log_action`. They queue locally in `~/.wavebrain/queue`, send at the end of each turn, and skip anything the agent logged itself. Secrets are redacted first. `--no-hooks` installs the MCP server only; `WAVEBRAIN_HOOKS=off` pauses capture.

```sh
npx wavebrain-cursor status
npx wavebrain-cursor uninstall   # undoes exactly what install added
```

Every changed file is backed up to `<file>.bak-wavebrain`. `--dry-run` shows the changes without writing.
