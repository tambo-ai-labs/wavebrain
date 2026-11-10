# WaveBrain for Codex

Codex has no plugin store, so `npx wavebrain init --agent codex` installs these pieces:

- `[mcp_servers.wavebrain]` in `~/.codex/config.toml`
- hooks in `~/.codex/hooks.json` (PostToolUse: observe, Stop: flush) and `[features] hooks = true`
- `skills/wavebrain/SKILL.md` into `~/.codex/skills/wavebrain/`

The hook runner itself is `shared/hook.mjs`, staged to `~/.wavebrain/hooks/`.

Codex runs a new hook only after you trust it. After `init`, start `codex`, open `/hooks`, and trust the WaveBrain PostToolUse and Stop hooks. (`codex exec --dangerously-bypass-hook-trust` skips this for one run; the e2e script uses it.)
