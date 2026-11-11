// One installer per agent harness: wavebrain-claude-code, wavebrain-codex, wavebrain-cursor and
// wavebrain-hermes. Each is a thin front end over the shared engine in cli.mjs, limited to its
// own agent's targets, with install / uninstall / status.

import { UsageError, VERSION, defaultCtx, defaultIo, init, pick, remove, status } from "./cli.mjs";
import { KEY_ENV, hermesProfiles, targetById } from "./targets.mjs";

const DEFAULT_URL = "https://getwavebrain.com/api/mcp";
const SETUP_URL = "https://getwavebrain.com/dashboard/setup";

/** The harness installers. `targets(ctx, o, io)` returns the engine targets to act on. */
export const HARNESSES = {
  "claude-code": {
    label: "Claude Code",
    gets: "the WaveBrain MCP server, auto-capture hooks and a when-to-log skill",
    options: `  --no-claude-permission  Don't pre-approve WaveBrain's tools (mcp__wavebrain__*), so
                          narrow --allowedTools runs (claude -p) can't log`,
    targets: (ctx) => [targetById(ctx, "claude-code")],
  },
  codex: {
    label: "Codex CLI",
    gets: "the WaveBrain MCP server, auto-capture hooks and a when-to-log skill",
    targets: (ctx) => [targetById(ctx, "codex")],
  },
  cursor: {
    label: "Cursor",
    gets: "the WaveBrain MCP server and auto-capture hooks",
    targets: (ctx) => [targetById(ctx, "cursor")],
  },
  hermes: {
    label: "Hermes Agent",
    gets: "the WaveBrain MCP server and the WaveBrain plugin, for each profile you pick",
    options: `  --profile <name>        Profile to set up (repeatable). "default" is ~/.hermes itself.
                          Without it you pick from a list (or get "default" when not
                          in a terminal).
  --all-profiles          Every profile, including default`,
    targets: hermesTargets,
  },
};

async function hermesTargets(ctx, o, io, verb) {
  const all = [targetById(ctx, "hermes"), ...hermesProfiles(ctx).map((p) => targetById(ctx, `hermes:${p}`))];
  if (o.allProfiles) return all;
  if (o.profiles.length) {
    const known = hermesProfiles(ctx);
    return o.profiles.map((p) => {
      const t = p === "default" ? all[0] : known.includes(p) ? targetById(ctx, `hermes:${p}`) : null;
      if (!t) throw new UsageError(`No Hermes profile "${p}". Profiles here: default${hermesProfiles(ctx).map((x) => `, ${x}`).join("")}`);
      return t;
    });
  }
  if (verb !== "install") return all; // uninstall / status: every profile WaveBrain touched
  if (all.length === 1 || !io.interactive) return [all[0]];
  return pick(ctx, io, all);
}

export function parseHarnessArgs(argv) {
  const o = { command: null, key: null, url: DEFAULT_URL, dryRun: false, yes: false, hooks: true, claudePermission: null, profiles: [], allProfiles: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--key") o.key = val();
    else if (a.startsWith("--key=")) o.key = a.slice(6);
    else if (a === "--url") o.url = val();
    else if (a === "--profile" || a === "-p") o.profiles.push(val());
    else if (a.startsWith("--profile=")) o.profiles.push(a.slice(10));
    else if (a === "--all-profiles") o.allProfiles = true;
    else if (a === "--dry-run") o.dryRun = true;
    else if (a === "--yes" || a === "-y") o.yes = true;
    else if (a === "--no-hooks") o.hooks = false;
    else if (a === "--no-claude-permission") o.claudePermission = false;
    else if (a === "--claude-permission") o.claudePermission = true;
    else if (a === "-h" || a === "--help") o.command = "help";
    else if (a === "-v" || a === "--version") o.command = "version";
    else if (!a.startsWith("-") && !o.command) o.command = a;
    else throw new UsageError(`Unknown option: ${a}`);
  }
  o.command ??= "install";
  if (o.command === "remove") o.command = "uninstall";
  if (o.command === "init") o.command = "install";
  return o;
}

function help(id, h) {
  const bin = `wavebrain-${id}`;
  return `${bin} ${VERSION}: connect ${h.label} to WaveBrain (https://getwavebrain.com)

Usage:
  npx ${bin} install     Add ${h.gets}
  npx ${bin} uninstall   Undo exactly what install added
  npx ${bin} status      Show whether ${h.label} is set up

Options:
  --key <key>             API key (or set ${KEY_ENV}). Create one at
                          ${SETUP_URL}
  --no-hooks              MCP server only, without auto-capture
${h.options ? h.options + "\n" : ""}  --dry-run               Show what would change without writing anything
  -y, --yes               Don't ask for confirmation
  --url <url>             MCP server URL (default ${DEFAULT_URL})
  -h, --help, -v, --version

Auto-capture records deploys, pushes, releases, payments, emails and database writes even
when the model doesn't call log_action. Secrets are redacted before anything is sent.
Pause it any time with WAVEBRAIN_HOOKS=off. Every file is backed up to
<file>.bak-wavebrain before it's changed.`;
}

/** Entry point for one harness installer. */
export async function runHarness(id, argv, ctx = defaultCtx(), io = defaultIo()) {
  const h = HARNESSES[id];
  if (!h) throw new Error(`unknown harness ${id}`);
  let o;
  try {
    o = parseHarnessArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    io.out(`${e.message}\n\n${help(id, h)}`);
    return 2;
  }
  if (id !== "hermes" && (o.profiles.length || o.allProfiles)) {
    io.out("--profile and --all-profiles are for wavebrain-hermes.");
    return 2;
  }
  try {
    if (o.command === "help") return io.out(help(id, h)), 0;
    if (o.command === "version") return io.out(VERSION), 0;
    const targets = await h.targets(ctx, o, io, o.command);
    if (o.command === "status") return status(ctx, io, targets);
    const undo = `npx wavebrain-${id} uninstall`;
    if (o.command === "install") {
      if (!targets.length) return io.out("Nothing selected; nothing changed."), 0;
      const code = await init({ ...o, agents: [], targets, undo }, ctx, io);
      if (h.after && code === 0 && o.hooks && !o.dryRun) io.out(`\n${h.after}`);
      return code;
    }
    if (o.command === "uninstall") return await remove({ ...o, agents: [], targets }, ctx, io);
    throw new UsageError(`Unknown command: ${o.command}. Use install, uninstall or status.`);
  } catch (e) {
    if (e instanceof UsageError) {
      io.out(e.message);
      return 2;
    }
    throw e;
  }
}
