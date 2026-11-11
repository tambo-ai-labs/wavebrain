# WaveBrain for Codex

```sh
codex plugin marketplace add tambo-ai-labs/wavebrain
codex plugin add wavebrain@wavebrain
```

Codex reads the API key from `WAVEBRAIN_API_KEY`. Add it to your shell profile (create a key at https://getwavebrain.com/dashboard/setup):

```sh
export WAVEBRAIN_API_KEY=al_...
```

Codex runs a plugin's hooks only after you trust them: start `codex`, open `/hooks` and trust the WaveBrain PostToolUse and Stop hooks. (After an update changes a hook, Codex asks again.)

What it adds: the `wavebrain` MCP server, the auto-capture hooks (high-stakes commands queued in `~/.wavebrain/queue` and sent at the end of each turn, secrets redacted, skipped when Codex logged the action itself) and a skill telling Codex when to log. Remove it with `codex plugin remove wavebrain@wavebrain`.

The hook runner in `hooks/` is copied from `shared/` by `scripts/sync.mjs`.
