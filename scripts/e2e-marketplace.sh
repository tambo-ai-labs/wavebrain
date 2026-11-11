#!/bin/bash
# Real runs of the marketplace plugins (installed the way users install them) against a mock
# WaveBrain REST endpoint for the hooks. The MCP server is the real one: pass a real key in
# WAVEBRAIN_API_KEY to check it connects (the prompt only asks for a read-only tool).
#   WAVEBRAIN_API_KEY=al_... bash scripts/e2e-marketplace.sh codex|claude
set -e
WHICH="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); cd "$T"
PORT=$((20000 + RANDOM % 20000))
cat > srv.py <<'EOF'
import http.server, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers.get('content-length') or 0))
        open('posts.jsonl', 'a').write(json.dumps({"auth": self.headers.get('authorization', '')[:12], "body": json.loads(b)}) + "\n")
        self.send_response(201); self.end_headers(); self.wfile.write(b'{"id":"x"}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
python3 srv.py $PORT > /dev/null 2>&1 < /dev/null &
SP=$!
trap 'kill $SP 2>/dev/null; rm -f "$T/ch/auth.json"' EXIT
sleep 1
mkdir repo && cd repo && git init -q && git commit -q --allow-empty -m init && cd ..
export WAVEBRAIN_HOME="$T/wb" WAVEBRAIN_API_URL="http://127.0.0.1:$PORT/api/v1/actions"
PROMPT='Do these in order: 1) run the shell command `ls`; 2) run `git commit -q --allow-empty -m mkt-e2e`; 3) run `git push --dry-run origin main` (it will fail, that is expected); 4) call the WaveBrain MCP tool list_recent_actions with limit 1 and say whether it worked (do not call log_action). Then reply DONE.'
if [ "$WHICH" = codex ]; then
  export CODEX_HOME="$T/ch"; mkdir -p "$CODEX_HOME"; cp ~/.codex/auth.json "$CODEX_HOME/"
  codex plugin marketplace add "${SOURCE:-$ROOT}" >/dev/null
  codex plugin add wavebrain@wavebrain | sed 's/^/  install: /'
  cd repo
  codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -s danger-full-access -c approval_policy='"never"' "$PROMPT" 2>&1 | grep -vE "^\s*$" | tail -4 | sed 's/^/  codex: /'
elif [ "$WHICH" = claude ]; then
  cd repo
  # --plugin-dir loads the plugin as installed; the key arrives the way Claude Code passes a saved userConfig value.
  CLAUDE_PLUGIN_OPTION_API_KEY="$WAVEBRAIN_API_KEY" claude -p "$PROMPT" --plugin-dir "$ROOT/plugins/claude-code" \
    --allowedTools 'Bash mcp__plugin_wavebrain_wavebrain__list_recent_actions' --model haiku --max-turns 10 2>&1 | tail -3 | sed 's/^/  claude: /'
fi
sleep 3
echo "--- mock WaveBrain received:"; cat "$T/posts.jsonl" 2>/dev/null || echo NONE
