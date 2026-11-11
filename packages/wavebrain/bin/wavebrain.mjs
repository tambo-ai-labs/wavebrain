#!/usr/bin/env node
// WaveBrain has one installer per agent now. This prints the right command for the agents found here.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
const env = process.env;
const onPath = (bin) =>
  (env.PATH || "").split(path.delimiter).some((d) => d && fs.existsSync(path.join(d, bin)));
const exists = (...p) => fs.existsSync(path.join(home, ...p));
const AGENTS = [
  ["Claude Code", "claude-code", () => onPath("claude") || exists(".claude.json") || exists(".claude")],
  ["Codex CLI", "codex", () => onPath("codex") || Boolean(env.CODEX_HOME) || exists(".codex")],
  ["Cursor", "cursor", () => onPath("cursor") || exists(".cursor")],
  ["Hermes Agent", "hermes", () => onPath("hermes") || exists(".hermes")],
];
const arg = process.argv[2];
if (arg === "-v" || arg === "--version") {
  console.log("0.3.0");
  process.exit(0);
}
const found = AGENTS.filter(([, , d]) => d());
console.log("WaveBrain has one installer per agent. Run the one for each agent you use:\n");
for (const [label, id, d] of AGENTS) {
  console.log(`  ${label.padEnd(14)} npx wavebrain-${id} install${found.some((f) => f[1] === id) ? "   (found on this machine)" : ""}`);
}
console.log(
  "\nWindsurf, VS Code, Claude Desktop and other MCP clients: copy the config from\n" +
    "https://getwavebrain.com/dashboard/setup (no installer needed).",
);
if (arg === "init" || arg === "remove" || arg === "status" || arg === "uninstall") {
  console.log(`\n"wavebrain ${arg}" was replaced by the per-agent commands above (install, uninstall, status).`);
}
process.exit(0);
