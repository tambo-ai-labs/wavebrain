# WaveBrain for Cursor

Logs your agent's deploys, pushes, releases, emails, payments and other real-world actions to [WaveBrain](https://getwavebrain.com), the audit log of what your AI agents did.

## Install

- **Cursor Marketplace** (once listed): open **Customize**, search for WaveBrain and select **Install**. Then set `WAVEBRAIN_API_KEY` under **Plugins** → **Configure**. Create a key at [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup).
- **Until then:** `npx wavebrain-cursor install` sets up the same MCP server and hooks in `~/.cursor`.

## What it adds

- **MCP server** `wavebrain`: `log_action`, sessions, and recent actions, authenticated with `WAVEBRAIN_API_KEY`.
- **Skill** telling the agent when to log and how to write a good entry.
- **Hooks:** `postToolUse` and `postToolUseFailure` (Shell and MCP tools) queue high-stakes actions (deploys, pushes, merges, publishes, payments, emails, database writes) in `~/.wavebrain/queue`. `stop` sends them. Anything the agent already logged with `log_action` in that turn is skipped. Secrets are removed on your machine before anything is sent.

The hooks need Node.js 18+ and read the key from `WAVEBRAIN_API_KEY` in their environment, or from `~/.wavebrain/config.json`. Pause capture with `WAVEBRAIN_HOOKS=off`.

[Privacy policy](https://getwavebrain.com/privacy) · Support: support@tambolabs.com · MIT license
