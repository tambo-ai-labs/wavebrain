# WaveBrain for Cursor

`npx wavebrain-cursor install` installs:

- the `wavebrain` MCP server in `~/.cursor/mcp.json`
- hooks in `~/.cursor/hooks.json`: `postToolUse` (matcher `Shell|MCP`) records high-stakes actions, `stop` sends them

The hook runner is `shared/hook.mjs`, staged to `~/.wavebrain/hooks/`.
