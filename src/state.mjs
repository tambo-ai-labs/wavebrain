// What `wavebrain init` added, so `wavebrain remove` undoes exactly that and nothing the user
// configured themselves. Stores file paths and entry names only, never keys.

import fs from "node:fs";
import path from "node:path";

export function statePath(ctx) {
  return path.join(ctx.home, ".wavebrain", "installed.json");
}

export function loadState(ctx) {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(ctx), "utf8"));
    return Array.isArray(s.records) ? s : { version: 1, records: [] };
  } catch {
    return { version: 1, records: [] };
  }
}

export function saveState(ctx, state) {
  const p = statePath(ctx);
  if (!state.records.length) {
    fs.rmSync(p, { force: true });
    try {
      fs.rmdirSync(path.dirname(p));
    } catch {}
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
}

/** Records owned by one target, keyed by ref. */
export function ownedBy(state, targetId) {
  return new Map(state.records.filter((r) => r.target === targetId).map((r) => [r.ref, r]));
}
