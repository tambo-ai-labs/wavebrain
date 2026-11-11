#!/usr/bin/env node
import { runHarness } from "../lib/harness.mjs";

runHarness("codex", process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`wavebrain-codex: ${e?.message ?? e}`);
    process.exit(1);
  },
);
