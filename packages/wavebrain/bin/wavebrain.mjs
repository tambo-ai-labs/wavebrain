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
  ["Claude Code", ["claude plugin marketplace add tambo-ai-labs/wavebrain", "claude plugin install wavebrain@wavebrain"], () => onPath("claude") || exists(".claude.json") || exists(".claude")],
  ["Codex CLI", ["codex plugin marketplace add tambo-ai-labs/wavebrain", "codex plugin add wavebrain@wavebrain"], () => onPath("codex") || Boolean(env.CODEX_HOME) || exists(".codex")],
  ["Cursor", ["npx wavebrain-cursor install"], () => onPath("cursor") || exists(".cursor")],
  ["Hermes Agent", ["npx wavebrain-hermes install"], () => onPath("hermes") || exists(".hermes")],
];
const arg = process.argv[2];
if (arg === "-v" || arg === "--version") {
  console.log("0.4.1");
  process.exit(0);
}
const found = AGENTS.filter(([, , d]) => d());
console.log("Set up WaveBrain for each agent you use:\n");
for (const [label, cmds] of AGENTS) {
  console.log(`  ${label}${found.some((f) => f[0] === label) ? "  (found on this machine)" : ""}`);
  for (const c of cmds) console.log(`    ${c}`);
}
console.log("\n  Codex reads the key from WAVEBRAIN_API_KEY; Claude Code asks for it.");
console.log(
  "\nWindsurf, VS Code, Claude Desktop and other MCP clients: copy the config from\n" +
    "https://getwavebrain.com/dashboard/setup (no installer needed).",
);
if (arg === "init" || arg === "remove" || arg === "status" || arg === "uninstall") {
  console.log(`\n"wavebrain ${arg}" was replaced by the commands above.`);
}
process.exit(0);
