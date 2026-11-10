# WaveBrain for Hermes Agent

```sh
npx wavebrain init --agent hermes            # default profile
npx wavebrain init --agent hermes:<profile>  # one profile
# or, once the repo is public:
hermes plugins install GuillermoCoding/wavebrain#plugins/hermes && hermes plugins enable wavebrain
```

- `post_tool_call`: records high-stakes `terminal` commands and write-type MCP tools to `~/.wavebrain/queue/`.
- `on_session_end`: sends them (in a background thread), skipping what the agent logged itself.
- A short system-prompt section tells the model when to call `log_action`.

Reads `WAVEBRAIN_API_KEY` from the profile's `.env` (or `~/.wavebrain/config.json`). Agent name: `hermes` or `hermes-<profile>`.
`rules.json` is copied from `shared/` by `scripts/sync.mjs`.
