// WaveBrain auto-capture, shared by every agent plugin. No dependencies (Node >= 18).
//
// Hooks call two verbs:
//   observe: after a tool call. Records high-stakes actions (deploys, pushes, publishes,
//            payments, emails, database writes) to a local queue. Never touches the network
//            unless the queue has been waiting a long time.
//   flush:   at the end of a turn. Sends queued actions to WaveBrain, skipping any the agent
//            already logged itself with log_action during that turn.
//
// Capture is local-first: a failed upload stays in ~/.wavebrain/queue and is retried next turn.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_API_URL = "https://getwavebrain.com/api/v1/actions";
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // drop queued items older than a week
const STALE_MS = 10 * 60 * 1000; // flush from observe if something has waited this long
const MAX_PER_FLUSH = 25;

export function home(env = process.env) {
  return env.WAVEBRAIN_HOME || path.join(env.HOME || os.homedir(), ".wavebrain");
}

export function loadRules(file = path.join(HERE, "rules.json")) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  return {
    shell: raw.shell.map((r) => ({ ...r, re: new RegExp(r.pattern, "i") })),
    mcpWriteVerbs: raw.mcp_write_verbs,
    mcpSkipServers: new Set(raw.mcp_skip_servers),
  };
}

export function loadConfig(env = process.env) {
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(home(env), "config.json"), "utf8"));
  } catch {}
  return {
    apiKey: env.WAVEBRAIN_API_KEY || cfg.apiKey || null,
    apiUrl: env.WAVEBRAIN_API_URL || cfg.apiUrl || DEFAULT_API_URL,
    enabled: env.WAVEBRAIN_HOOKS !== "off" && cfg.autoCapture !== false,
  };
}

// ---------- secrets ----------

const SECRET_PATTERNS = [
  /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bwhsec_[A-Za-z0-9]{8,}/g,
  /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{16,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bal_[A-Za-z0-9_-]{16,}/g, // WaveBrain keys
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google
  /\b(sk-(proj-|ant-)?)[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:@/]+:[^\s@/]+@/gi, // user:pass@ in URLs
  /((?:password|passwd|secret|token|api[_-]?key|apikey|auth|access[_-]?key|private[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /(--(?:password|token|api-key|secret|auth)[= ])("[^"]*"|'[^']*'|\S+)/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // long opaque blobs
];

export function redact(text) {
  let s = String(text ?? "");
  for (const re of SECRET_PATTERNS) {
    s = s.replace(re, (m, a, b) => {
      if (re.source.startsWith("((?:password") || re.source.startsWith("(--(")) return `${a}[redacted]`;
      if (re.source.startsWith("(Bearer")) return `${a} [redacted]`;
      if (re.source.startsWith("\\b([a-z]")) return `${a}[redacted]@`;
      return "[redacted]";
    });
  }
  return s;
}

// ---------- classification ----------

export function shellCommand(input) {
  const c = input?.command ?? input?.cmd;
  if (Array.isArray(c)) return c.join(" ");
  return typeof c === "string" ? c : "";
}

const SHELL_TOOLS = new Set(["bash", "shell", "local_shell", "exec", "terminal", "run_terminal_cmd", "execute_command"]);

/** Splits "mcp__server__tool" (Claude Code, Codex) or "mcp_server_tool" (Hermes) into parts. */
export function mcpParts(name) {
  let m = name.match(/^mcp__(.+?)__(.+)$/);
  if (m) return { server: m[1], tool: m[2] };
  m = name.match(/^mcp_([a-z0-9-]+)_(.+)$/i);
  if (m) return { server: m[1], tool: m[2] };
  return null;
}

export function isAgentLog(toolName, toolInput) {
  const n = String(toolName || "");
  if (/wavebrain.*log_action$/i.test(n)) return true;
  // Cursor reports MCP calls as tool "MCP" with the real name inside the input.
  const inner = toolInput?.toolName || toolInput?.tool_name || toolInput?.name;
  return /^mcp$/i.test(n) && /log_action$/i.test(String(inner || "")) && /wavebrain/i.test(JSON.stringify(toolInput));
}

const firstLine = (s, n = 140) => {
  const one = String(s).replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
};

/**
 * Returns { type, title, details, rule } for a tool call worth recording, or null.
 * ev: { toolName, toolInput, cwd, failed }
 */
export function classify(rules, ev) {
  const name = String(ev.toolName || "");
  const input = ev.toolInput || {};
  const where = ev.cwd ? ` in ${path.basename(ev.cwd)}` : "";
  const outcome = ev.failed ? " It failed." : "";

  if (SHELL_TOOLS.has(name.toLowerCase())) {
    const cmd = shellCommand(input).trim();
    if (!cmd) return null;
    for (const r of rules.shell) {
      const m = cmd.match(r.re);
      if (!m) continue;
      // The segment that matched, not the whole compound command.
      const from = m.index + (m[1]?.length ?? 0);
      const start = Math.max(0, ...["&&", ";", "|"].map((d) => {
        const i = cmd.lastIndexOf(d, from - 1);
        return i < 0 ? 0 : i + d.length;
      }));
      const ends = ["&&", ";", "|"].map((d) => cmd.indexOf(d, m.index + m[0].length)).filter((i) => i >= 0);
      const segment = cmd.slice(start, ends.length ? Math.min(...ends) : cmd.length).trim();
      const safe = redact(segment);
      return {
        type: r.type,
        title: firstLine(r.title.replace("{cmd}", firstLine(safe, 120)), 200),
        details: `Ran \`${firstLine(redact(cmd), 1500)}\`${where}.${outcome} (Recorded automatically by the WaveBrain hook.)`,
        rule: r.id,
      };
    }
    return null;
  }

  const mcp = mcpParts(name) ?? (/^mcp$/i.test(name) ? { server: String(input.server || input.serverName || "mcp"), tool: String(input.toolName || input.tool_name || input.name || "") } : null);
  if (mcp && mcp.tool) {
    if (rules.mcpSkipServers.has(mcp.server)) return null;
    const verbs = mcp.tool.toLowerCase().split(/[_\-.]+/);
    if (!verbs.some((v) => rules.mcpWriteVerbs.includes(v))) return null;
    const args = redact(JSON.stringify(input.arguments ?? input.args ?? input)).slice(0, 1500);
    return {
      type: "api_call",
      title: firstLine(`Used ${mcp.server}: ${mcp.tool.replace(/[_-]+/g, " ")}`, 200),
      details: `Called the MCP tool ${mcp.server}/${mcp.tool}${where} with ${args}.${outcome} (Recorded automatically by the WaveBrain hook.)`,
      rule: "mcp-write",
    };
  }
  return null;
}

// ---------- queue ----------

const safeId = (s) => String(s || "default").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

export function queueFile(host, session, env = process.env) {
  return path.join(home(env), "queue", `${safeId(host)}-${safeId(session)}.jsonl`);
}

function readQueue(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function append(file, item) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(item) + "\n", { mode: 0o600 });
}

/** After a tool call. Returns what was queued (for tests), or null. */
export async function observe({ host, session, toolName, toolInput, cwd, failed }, { env = process.env, rules = loadRules(), now = Date.now() } = {}) {
  const cfg = loadConfig(env);
  if (!cfg.enabled) return null;
  const file = queueFile(host, session, env);
  if (isAgentLog(toolName, toolInput)) {
    append(file, { kind: "agent_logged", at: now });
    return { kind: "agent_logged" };
  }
  const action = classify(rules, { toolName, toolInput, cwd, failed });
  if (!action) return null;
  const item = {
    kind: "action",
    at: now,
    payload: {
      agent: host,
      type: action.type,
      title: action.title,
      details: action.details,
      ...(cwd && { project: path.basename(cwd) }),
      status: failed ? "failure" : "success",
      metadata: { source: "wavebrain-hook", host, rule: action.rule },
    },
  };
  append(file, item);
  // Hosts without a reliable end-of-turn hook still get their actions out eventually.
  const q = readQueue(file);
  if (q.some((x) => x.kind === "action" && now - x.at > STALE_MS)) await flush({ host, session }, { env, now });
  return item;
}

/** End of turn: send queued actions the agent didn't log itself. Returns counts. */
export async function flush({ host, session }, { env = process.env, now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const cfg = loadConfig(env);
  const file = queueFile(host, session, env);
  const items = readQueue(file);
  if (!items.length) return { sent: 0, skipped: 0, kept: 0 };

  // The agent described its own work: drop what was captured before its last log_action.
  const lastLog = Math.max(-Infinity, ...items.filter((x) => x.kind === "agent_logged").map((x) => x.at));
  let actions = items.filter((x) => x.kind === "action" && x.at > lastLog && now - x.at < MAX_AGE_MS);
  // Two installs (plugin + init hooks) would queue the same call twice within moments.
  const seen = new Set();
  actions = actions.filter((x) => {
    const k = `${x.payload?.title}|${Math.round(x.at / 5000)}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  const skipped = items.filter((x) => x.kind === "action").length - actions.length;

  if (!cfg.apiKey || !cfg.enabled || !fetchImpl) {
    rewrite(file, actions);
    return { sent: 0, skipped, kept: actions.length };
  }

  const keep = [];
  let sent = 0;
  for (const [i, item] of actions.entries()) {
    if (i >= MAX_PER_FLUSH) {
      keep.push(item);
      continue;
    }
    try {
      const res = await fetchImpl(cfg.apiUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(item.payload),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) sent++;
      else if (res.status === 400 || res.status === 401 || res.status === 402) {
        // Not retryable: bad payload, bad key, or plan quota. Drop rather than retry forever.
      } else keep.push(item);
    } catch {
      keep.push(item);
    }
  }
  rewrite(file, keep);
  return { sent, skipped, kept: keep.length };
}

function rewrite(file, items) {
  if (!items.length) {
    try {
      fs.unlinkSync(file);
    } catch {}
    return;
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, items.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- host payloads ----------

/** Plain-text tool output (Codex) has no exit code: treat a clear error line at the start or end as a failure. */
export function looksFailed(resp) {
  if (typeof resp !== "string") return false;
  const lines = resp.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return false;
  const bad = (l) => /^(fatal|error|Error|ERROR)(\[[^\]]*\])?:/.test(l) || /: command not found$|^Permission denied|^npm ERR!|^Traceback \(most recent call last\)/.test(l);
  return bad(lines[0]) || bad(lines[lines.length - 1]);
}

/** Normalizes a hook's stdin JSON into { session, toolName, toolInput, cwd, failed }. */
export function fromHookInput(host, input) {
  const resp = input.tool_response ?? input.tool_output ?? input.result ?? {};
  const exit = resp?.exit_code ?? resp?.exitCode ?? input.exit_code ?? input.exitCode;
  const failed =
    (typeof exit === "number" && exit !== 0) ||
    looksFailed(resp) || // Codex sends only the output text, without an exit code

    resp?.interrupted === true ||
    resp?.success === false ||
    input.status === "error" ||
    /Failure$/.test(input.hook_event_name || "") || // Claude Code: PostToolUseFailure
    Boolean(input.error);
  return {
    host,
    session: input.session_id || input.conversation_id || input.sessionId || "default",
    toolName: input.tool_name || input.toolName || (input.command !== undefined ? "Shell" : ""),
    toolInput: input.tool_input || input.toolInput || (input.command !== undefined ? { command: input.command } : {}),
    cwd: input.cwd || (Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined),
    failed: Boolean(failed),
  };
}
