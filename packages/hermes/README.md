# wavebrain-hermes

Connect Hermes Agent to [WaveBrain](https://getwavebrain.com), the audit log of what your AI agents do.

```sh
npx wavebrain-hermes install
```

It asks for an API key (or opens [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup) to create one; `--key` or `WAVEBRAIN_API_KEY` skip the prompt).

For each profile: adds the `wavebrain` MCP server to its `config.yaml`, `WAVEBRAIN_API_KEY` to its `.env`, and the WaveBrain plugin to `plugins/wavebrain` (enabled with `hermes plugins enable`).

```sh
npx wavebrain-hermes install                    # pick profiles from a list
npx wavebrain-hermes install --profile coder    # one profile (repeatable; "default" is ~/.hermes)
npx wavebrain-hermes install --all-profiles
```

Then restart the gateway (`hermes gateway restart`).

**Auto-capture:** the hooks record deploys, pushes, releases, publishes, payments, emails and database writes even when the model forgets to call `log_action`. They queue locally in `~/.wavebrain/queue`, send at the end of each turn, and skip anything the agent logged itself. Secrets are redacted first. `--no-hooks` installs the MCP server only; `WAVEBRAIN_HOOKS=off` pauses capture.

```sh
npx wavebrain-hermes status
npx wavebrain-hermes uninstall   # undoes exactly what install added
```

Every changed file is backed up to `<file>.bak-wavebrain`. `--dry-run` shows the changes without writing.
