#!/usr/bin/env node
import { runHarness } from "../lib/harness.mjs";

runHarness("cursor", process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`wavebrain-cursor: ${e?.message ?? e}`);
    process.exit(1);
  },
);
