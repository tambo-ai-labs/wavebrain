import { spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { Conflict, Session, hasBlock, readText } from "./files.mjs";
import { loadState, ownedBy, saveState, statePath } from "./state.mjs";
import { stageCapture, unstageCapture } from "./capture.mjs";
import { KEY_ENV, allTargets, targetById, tilde } from "./targets.mjs";

export const VERSION = "0.4.1";
const DEFAULT_URL = "https://getwavebrain.com/api/mcp";
const SETUP_URL = "https://getwavebrain.com/dashboard/setup";

// Internal multi-agent entry, used by tests; the published installers go through harness.mjs.
const HELP = `wavebrain ${VERSION}: connect your AI agents to WaveBrain (https://getwavebrain.com)

Usage:
  npx wavebrain init      Pick agents and connect them to WaveBrain
  npx wavebrain remove    Undo exactly what init added
  npx wavebrain status    Show which agents are configured

Options:
  --agent <name>          Agent to set up (repeatable). Skips the picker. Names:
                          claude-code, codex, cursor, windsurf, claude-desktop,
                          vscode, hermes, hermes:<profile>
  --key <key>             API key (or set ${KEY_ENV}). Create one at
                          ${SETUP_URL}
  --dry-run               Show what would change without writing anything
  --no-hooks              MCP server only: skip the hooks, skill and Hermes plugin
                          that record actions the model forgets to log
  --no-claude-permission  Don't pre-approve WaveBrain's tools in Claude Code
  -y, --yes               Don't ask for confirmation
  --url <url>             MCP server URL (default ${DEFAULT_URL})
  -h, --help, -v, --version

For Claude Code, Codex, Cursor and Hermes, init also installs auto-capture: hooks that
record deploys, pushes, releases, payments, emails and database writes even when the model
doesn't call log_action, plus a short skill telling it when to log. Secrets are redacted
before anything is sent. Turn capture off any time with WAVEBRAIN_HOOKS=off.

Every file is backed up to <file>.bak-wavebrain before it's changed.`;

export function parseArgs(argv) {
  const o = { command: null, agents: [], key: null, dryRun: false, yes: false, claudePermission: null, url: DEFAULT_URL, hooks: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--agent" || a === "-a") o.agents.push(val());
    else if (a.startsWith("--agent=")) o.agents.push(a.slice(8));
    else if (a === "--key") o.key = val();
    else if (a.startsWith("--key=")) o.key = a.slice(6);
    else if (a === "--url") o.url = val();
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-claude-permission") o.claudePermission = false;
    else if (a === "--no-hooks") o.hooks = false;
    else if (a === "--claude-permission") o.claudePermission = true;
    else if (a === "-h" || a === "--help") o.command = "help";
    else if (a === "-v" || a === "--version") o.command = "version";
    else if (!a.startsWith("-") && !o.command) o.command = a;
    else throw new UsageError(`Unknown option: ${a}`);
  }
  o.command ??= "help";
  return o;
}

export class UsageError extends Error {}

export const mask = (key) => (key.length > 12 ? `${key.slice(0, 10)}…` : "al_…");
const validKey = (k) => /^al_[A-Za-z0-9_-]{20,}$/.test(k);

/** io: { out(line), interactive, ask(q), askSecret(q), open(url) } — swapped out in tests. */
export async function run(argv, ctx = defaultCtx(), io = defaultIo()) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.out(`${e.message}\n\n${HELP}`);
    return 2;
  }
  try {
    if (o.command === "help") return io.out(HELP), 0;
    if (o.command === "version") return io.out(VERSION), 0;
    if (o.command === "status") return status(ctx, io);
    if (o.command === "init") return await init(o, ctx, io);
    if (o.command === "remove" || o.command === "uninstall") return await remove(o, ctx, io);
    throw new UsageError(`Unknown command: ${o.command}`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.out(e.message);
      return 2;
    }
    throw e;
  }
}

function resolveTargets(ctx, names) {
  return names.map((n) => {
    const t = targetById(ctx, n.trim().toLowerCase());
    if (!t) throw new UsageError(`Unknown agent "${n}". Run with --help for the list.`);
    return t;
  });
}

export async function init(o, ctx, io) {
  let targets;
  if (o.targets) targets = o.targets;
  else if (o.agents.length) {
    targets = resolveTargets(ctx, o.agents);
  } else {
    if (!io.interactive) throw new UsageError("Not a terminal: pass --agent <name> (repeatable) to choose agents.");
    targets = await pick(ctx, io);
    if (!targets.length) return io.out("Nothing selected; nothing changed."), 0;
  }

  let key = o.key ?? null;
  let keyFromEnv = false;
  if (!key && ctx.env[KEY_ENV]) {
    key = ctx.env[KEY_ENV];
    keyFromEnv = true;
  }
  if (!key) {
    if (!io.interactive) throw new UsageError(`No API key: pass --key or set ${KEY_ENV}. Create one at ${SETUP_URL}`);
    key = await askKey(io);
  }
  key = key.trim();
  if (!validKey(key)) throw new UsageError(`That doesn't look like a WaveBrain API key (they start with "al_"). Create one at ${SETUP_URL}`);

  let claudePermission = o.claudePermission;
  if (claudePermission === null && targets.some((t) => t.id === "claude-code")) {
    if (io.interactive && !o.yes) {
      io.out(
        "\nClaude Code: runs started with a narrow --allowedTools (claude -p, browser automations, Hermes delegations)\n" +
          "can't call log_action unless WaveBrain's tools are pre-approved (mcp__wavebrain__* in ~/.claude/settings.json).",
      );
      claudePermission = !/^n/i.test((await io.ask("Allow logging in non-interactive runs? (Y/n) ")).trim());
    } else claudePermission = true;
  }

  io.out(`\n${o.dryRun ? "Dry run: nothing will be written.\n" : ""}Using key ${mask(key)} and ${o.url}\n`);
  const state = loadState(ctx);
  const session = new Session({ dryRun: o.dryRun });
  const opts = { url: o.url, key, keyFromEnv, claudePermission, hooks: o.hooks };
  let failed = 0;
  const nextSteps = [];

  for (const t of targets) {
    const owned = ownedBy(state, t.id);
    try {
      const results = t.install(ctx, session, opts, owned);
      for (const r of results) {
        if (r.kind !== "unchanged" || owned.has(r.ref)) {
          state.records = state.records.filter((x) => x.ref !== r.ref);
          state.records.push({
            ref: r.ref,
            target: t.id,
            file: r.file,
            createdFile: Boolean(r.createdFile),
            ...(r.pruneFrom !== undefined && { pruneFrom: r.pruneFrom }),
          });
        }
      }
      const changed = results.filter((r) => r.kind !== "unchanged");
      if (!changed.length) io.out(`• ${t.label}: already set up`);
      else {
        io.out(`✓ ${t.label}`);
        for (const r of changed) io.out(`    ${o.dryRun ? "would " + verb(r.kind) : verb(r.kind, true)} ${describe(ctx, r)}`);
        nextSteps.push(`${t.label}: ${t.next}`);
      }
      if (t.id === "codex" && keyFromEnv) io.out(`    Codex reads the key from ${KEY_ENV}; keep it exported in your shell.`);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      failed++;
      io.out(`! ${t.label}: ${e.message}`);
    }
  }

  // The hook runner and the key it uses, shared by every agent with auto-capture.
  if (o.hooks && targets.some((t) => t.capture)) {
    const results = stageCapture(ctx, session, opts);
    const changed = results.filter((r) => r.kind !== "unchanged");
    for (const r of results) {
      const prev = state.records.find((x) => x.ref === r.ref);
      state.records = state.records.filter((x) => x.ref !== r.ref);
      state.records.push({ ref: r.ref, target: "capture", file: r.file, createdFile: prev?.createdFile ?? Boolean(r.createdFile) });
    }
    if (changed.length) {
      io.out(`✓ Auto-capture`);
      for (const r of changed) io.out(`    ${o.dryRun ? "would " + verb(r.kind) : verb(r.kind, true)} ${describe(ctx, r)}`);
    }
  }

  if (!o.dryRun) saveState(ctx, state);
  if (nextSteps.length) io.out(`\nNext:\n${nextSteps.map((s) => `  ${s}`).join("\n")}`);
  if (!o.dryRun && session.changes.length) {
    const backups = session.changes.some((c) => c.backup) ? "Backups end in .bak-wavebrain. " : "";
    io.out(`\n${backups}Undo with: ${o.undo ?? "npx wavebrain remove"}`);
  }
  return failed ? 1 : 0;
}

function verb(kind, past) {
  return { created: past ? "created" : "create", updated: past ? "updated" : "update", deleted: past ? "deleted" : "delete" }[kind] ?? kind;
}

function describe(ctx, r) {
  const ref = r.ref;
  const what = ref.endsWith(":permission")
    ? " (allow mcp__wavebrain__*)"
    : ref.endsWith(":env")
      ? ` (${KEY_ENV})`
      : ref.endsWith(":hooks")
        ? " (auto-capture hooks)"
        : ref.endsWith(":features")
          ? " ([features] hooks = true)"
          : ref.endsWith(":skill")
            ? " (when-to-log skill)"
            : ref.includes(":plugin:")
              ? " (WaveBrain plugin)"
              : ref.endsWith(":plugin-enabled")
                ? " (plugins.enabled: wavebrain)"
                : ref === "capture:config"
                  ? " (API key for the hooks)"
                  : ref.startsWith("capture:")
                    ? " (hook runner)"
                    : " (wavebrain server)";
  return tilde(ctx, r.file) + what;
}

export async function pick(ctx, io, among = null) {
  const targets = among ?? allTargets(ctx);
  const found = targets.filter((t) => t.detect(ctx));
  const list = found.length ? found : targets;
  io.out(found.length ? "Agents found on this machine:" : "No agents detected. Available:");
  list.forEach((t, i) => io.out(`  ${i + 1}) ${t.label}${t.configured(ctx) ? "  (already has wavebrain)" : ""}`));
  const answer = (await io.ask("\nWhich should log to WaveBrain? Numbers separated by spaces, 'all', or Enter for none: ")).trim();
  if (!answer) return [];
  if (answer.toLowerCase() === "all") return list;
  const picked = [];
  for (const part of answer.split(/[\s,]+/)) {
    const t = list[Number(part) - 1];
    if (!t) throw new UsageError(`"${part}" isn't one of the numbers above.`);
    if (!picked.includes(t)) picked.push(t);
  }
  io.out(`Selected: ${picked.map((t) => t.label).join(", ")}`);
  return picked;
}

async function askKey(io) {
  io.out(`\nPaste a WaveBrain API key, or press Enter to open ${SETUP_URL} and create one.`);
  let key = (await io.askSecret("API key: ")).trim();
  if (!key) {
    io.open(SETUP_URL);
    io.out(`Opened ${SETUP_URL}. Click "Create a key", copy it, and paste it here.`);
    key = (await io.askSecret("API key: ")).trim();
  }
  return key;
}

export async function remove(o, ctx, io) {
  const state = loadState(ctx);
  const ids = o.targets
    ? o.targets.map((t) => t.id).filter((id) => state.records.some((r) => r.target === id) || markerOnly(ctx, targetById(ctx, id)))
    : o.agents.length
    ? resolveTargets(ctx, o.agents).map((t) => t.id)
    : [...new Set([...state.records.map((r) => r.target), ...allTargets(ctx).filter((t) => markerOnly(ctx, t)).map((t) => t.id)])];
  if (!ids.length) return io.out("Nothing to remove: WaveBrain hasn't added anything here."), 0;
  const targets = ids.map((id) => targetById(ctx, id)).filter(Boolean);

  if (io.interactive && !o.yes && !o.dryRun) {
    const ok = (await io.ask(`Remove WaveBrain from ${targets.map((t) => t.label).join(", ")}? (y/N) `)).trim();
    if (!/^y/i.test(ok)) return io.out("Nothing changed."), 0;
  }

  const session = new Session({ dryRun: o.dryRun });
  for (const t of targets) {
    try {
      const results = t.uninstall(ctx, session, ownedBy(state, t.id)).filter((r) => r.kind !== "unchanged");
      if (!results.length) io.out(`• ${t.label}: nothing added by WaveBrain`);
      else {
        io.out(`✓ ${t.label}`);
        for (const r of results) io.out(`    ${o.dryRun ? "would " + verb(r.kind) : verb(r.kind, true)} ${describe(ctx, r)}`);
      }
      state.records = state.records.filter((r) => r.target !== t.id);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
      io.out(`! ${t.label}: ${e.message}`);
    }
  }
  // Last agent with auto-capture gone: remove the hook runner and its key too.
  const captureLeft = state.records.some((r) => r.target !== "capture" && targetById(ctx, r.target)?.capture);
  if (!captureLeft && state.records.some((r) => r.target === "capture")) {
    const results = unstageCapture(ctx, session).filter((r) => r.kind !== "unchanged");
    if (results.length) {
      io.out(`✓ Auto-capture`);
      for (const r of results) io.out(`    ${o.dryRun ? "would " + verb(r.kind) : verb(r.kind, true)} ${tilde(ctx, r.file)}`);
    }
    state.records = state.records.filter((r) => r.target !== "capture");
  }
  if (!o.dryRun) saveState(ctx, state);
  return 0;
}

// Codex and Hermes edits are marked in the file itself, so they're found even without the state file.
function markerOnly(ctx, t) {
  return (t.id === "codex" || t.id.startsWith("hermes")) && t.configured(ctx) && t.files(ctx).some((f) => hasMarker(f));
}
const hasMarker = (f) => hasBlock(readText(f));

export function status(ctx, io, only = null) {
  const state = loadState(ctx);
  io.out("Agent                         Detected  WaveBrain");
  for (const t of only ?? allTargets(ctx)) {
    const ours = state.records.some((r) => r.target === t.id) || markerOnly(ctx, t);
    const conf = t.configured(ctx) ? (ours ? "configured (by WaveBrain)" : "configured") : "not configured";
    io.out(`${t.label.padEnd(30)}${(t.detect(ctx) ? "yes" : "no").padEnd(10)}${conf}`);
  }
  io.out(`\nState: ${tilde(ctx, statePath(ctx))}`);
  return 0;
}

export function defaultCtx() {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

export function defaultIo() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const ask = (q, secret = false) =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
      if (secret) {
        process.stdout.write(q);
        rl._writeToOutput = (s) => {
          if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
          else process.stdout.write("*".repeat(s.length));
        };
      }
      rl.question(secret ? "" : q, (a) => {
        rl.close();
        resolve(a);
      });
    });
  return {
    interactive,
    out: (line) => console.log(line),
    ask: (q) => ask(q),
    askSecret: (q) => ask(q, true),
    open(url) {
      const [cmd, args] =
        process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
      try {
        spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
      } catch {}
    },
  };
}
