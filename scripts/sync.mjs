#!/usr/bin/env node
// Copies shared/ into every place that ships it, so there's one source of truth.
//   node scripts/sync.mjs          write the copies
//   node scripts/sync.mjs --check  exit 1 if any copy is out of date (CI / tests)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const S = (f) => path.join(ROOT, "shared", f);

const COPIES = [
  // Claude Code marketplace plugin
  [S("core.mjs"), "plugins/claude-code/hooks/core.mjs"],
  [S("hook.mjs"), "plugins/claude-code/hooks/hook.mjs"],
  [S("rules.json"), "plugins/claude-code/hooks/rules.json"],
  [S("SKILL.md"), "plugins/claude-code/skills/wavebrain/SKILL.md"],
  // Hermes plugin
  [S("rules.json"), "plugins/hermes/rules.json"],
  // Codex skill (hooks are installed by the CLI)
  [S("SKILL.md"), "plugins/codex/skills/wavebrain/SKILL.md"],
  // Everything `npx wavebrain init` installs
  [S("core.mjs"), "packages/cli/assets/hooks/core.mjs"],
  [S("hook.mjs"), "packages/cli/assets/hooks/hook.mjs"],
  [S("rules.json"), "packages/cli/assets/hooks/rules.json"],
  [S("SKILL.md"), "packages/cli/assets/SKILL.md"],
  [path.join(ROOT, "plugins/hermes/__init__.py"), "packages/cli/assets/hermes/__init__.py"],
  [path.join(ROOT, "plugins/hermes/plugin.yaml"), "packages/cli/assets/hermes/plugin.yaml"],
  [S("rules.json"), "packages/cli/assets/hermes/rules.json"],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [src, rel] of COPIES) {
  const dest = path.join(ROOT, rel);
  const want = fs.readFileSync(src);
  const have = fs.existsSync(dest) ? fs.readFileSync(dest) : null;
  if (have && want.equals(have)) continue;
  stale++;
  if (check) console.log(`out of date: ${rel}`);
  else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, want);
    console.log(`wrote ${rel}`);
  }
}
if (check && stale) {
  console.log("Run: node scripts/sync.mjs");
  process.exit(1);
}
if (!stale) console.log("all copies up to date");
