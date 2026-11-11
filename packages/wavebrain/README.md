# wavebrain

[WaveBrain](https://getwavebrain.com) is the audit log of what your AI agents do. Each agent has its own installer:

| Agent | Install |
| --- | --- |
| Claude Code | `npx wavebrain-claude-code install` |
| Codex CLI | `npx wavebrain-codex install` |
| Cursor | `npx wavebrain-cursor install` |
| Hermes Agent | `npx wavebrain-hermes install` |

Windsurf, VS Code, Claude Desktop and other MCP clients only need the MCP server: copy the config from [getwavebrain.com/dashboard/setup](https://getwavebrain.com/dashboard/setup).

`npx wavebrain` prints this list and marks the agents it finds on your machine. (`wavebrain init` from versions before 0.3 was replaced by these installers.)
