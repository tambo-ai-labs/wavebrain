# WaveBrain for Codex

Codex has no plugin store, so `npx wavebrain init --agent codex` installs these pieces:

- `[mcp_servers.wavebrain]` in `~/.codex/config.toml`
- hooks in `~/.codex/hooks.json` (PostToolUse: observe, Stop: flush) and `[features] hooks = true`
- `skills/wavebrain/SKILL.md` into `~/.codex/skills/wavebrain/`

The hook runner itself is `shared/hook.mjs`, staged to `~/.wavebrain/hooks/`.
