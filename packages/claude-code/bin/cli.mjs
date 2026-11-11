#!/usr/bin/env node
import { runHarness } from "../lib/harness.mjs";

runHarness("claude-code", process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`wavebrain-claude-code: ${e?.message ?? e}`);
    process.exit(1);
  },
);
