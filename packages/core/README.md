# wavebrain-core (internal)

The engine behind the per-agent installers in `packages/claude-code`, `packages/codex`,
`packages/cursor` and `packages/hermes`: config writers with backups and dry runs, the shared
install state in `~/.wavebrain/installed.json`, auto-capture staging, and `harness.mjs` (each
installer's install / uninstall / status). Not published. `node scripts/sync.mjs` copies `src/`
into each installer's `lib/` and `assets/` into its `assets/`.
