# wavebrain

[WaveBrain](https://getwavebrain.com) is the audit log of what your AI agents do. Set it up for each agent:

| Agent | Install |
| --- | --- |
| Claude Code | `claude plugin marketplace add tambo-ai-labs/wavebrain` then `claude plugin install wavebrain@wavebrain` |
| Codex CLI | `codex plugin marketplace add tambo-ai-labs/wavebrain` then `codex plugin add wavebrain@wavebrain` |
| Cursor | `npx wavebrain-cursor install` |
| Hermes Agent | `npx wavebrain-hermes install` |

Windsurf, VS Code, Claude Desktop and other MCP clients only need the MCP server: copy the config from [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup).

`npx wavebrain` prints this list and marks the agents it finds on your machine.
