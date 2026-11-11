# WaveBrain for Claude Code

```
/plugin marketplace add tambo-ai-labs/wavebrain
/plugin install wavebrain@wavebrain
```

Claude Code asks for your WaveBrain API key (create one at https://getwavebrain.com/dashboard/setup) and stores it in the system keychain. Change it later with `/plugin configure wavebrain@wavebrain`.

From a terminal:

```sh
claude plugin marketplace add tambo-ai-labs/wavebrain
claude plugin install wavebrain@wavebrain
```

What it adds:
- **MCP server** `wavebrain` (log_action, sessions, recent actions). If you already added a `wavebrain` server by hand, Claude Code keeps yours.
- **Skill** telling Claude when to log and how to write a good entry.
- **Hooks**: `PostToolUse` and `PostToolUseFailure` record high-stakes commands (deploys, pushes, publishes, payments, emails, database writes) to a local queue in `~/.wavebrain/queue`; `Stop`/`SessionEnd` send them. Anything Claude already logged with `log_action` in that turn is skipped. Secrets are redacted before anything leaves the machine. Turn capture off with `WAVEBRAIN_HOOKS=off`.

Runs started with a narrow `--allowedTools` (for example `claude -p`) need WaveBrain's tools allowed to call `log_action`. The hooks still record actions either way.
