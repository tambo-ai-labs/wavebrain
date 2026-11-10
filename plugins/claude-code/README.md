# WaveBrain for Claude Code

```
/plugin marketplace add GuillermoCoding/wavebrain
/plugin install wavebrain@wavebrain
```

Set your key once (create one at https://getwavebrain.com/dashboard/setup):

```sh
export WAVEBRAIN_API_KEY=al_...   # or run: npx wavebrain init --agent claude-code
```

What it adds:
- **MCP server** `wavebrain` (log_action, sessions, recent actions).
- **Skill** telling Claude when to log and how to write a good entry.
- **Hooks**: `PostToolUse` records high-stakes commands (deploys, pushes, publishes, payments, emails, database writes) to a local queue in `~/.wavebrain/queue`; `Stop`/`SessionEnd` send them. Anything Claude already logged with `log_action` in that turn is skipped. Secrets are redacted before anything leaves the machine. Turn capture off with `WAVEBRAIN_HOOKS=off`.

Installed with `npx wavebrain init` instead? Don't also install this plugin, or actions are captured twice.
