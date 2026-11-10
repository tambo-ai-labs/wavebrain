#!/usr/bin/env node
import { run } from "../src/cli.mjs";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`wavebrain: ${e?.message ?? e}`);
    process.exit(1);
  },
);
