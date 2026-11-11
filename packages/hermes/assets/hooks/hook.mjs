#!/usr/bin/env node
// Hook entry point: node hook.mjs <host> <observe|flush>
// Reads the agent's hook JSON on stdin. Always exits 0 and prints nothing, so a WaveBrain
// problem can never block or slow down the agent's own work.

import { flush, fromHookInput, observe } from "./core.mjs";

const [host = "agent", verb = "observe"] = process.argv.slice(2);

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  let input = {};
  try {
    input = JSON.parse((await readStdin()) || "{}");
  } catch {}
  const ev = fromHookInput(host, input);
  if (verb === "observe") await observe(ev);
  else if (verb === "flush") await flush(ev);
} catch (e) {
  if (process.env.WAVEBRAIN_DEBUG) console.error(`wavebrain hook: ${e?.stack || e}`);
}
process.exit(0);
