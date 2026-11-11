#!/bin/bash
# Real end-to-end checks against a mock WaveBrain API, with each agent set up by our own installers.
#   bash scripts/e2e.sh codex      (needs codex logged in)
#   bash scripts/e2e.sh claude     (needs claude logged in)
# Everything is written under a temp dir; your real agent configs are not touched.
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
        if self.path != "/api/v1/actions":
            self.send_response(404); self.end_headers(); return
        open('posts.jsonl', 'a').write(json.dumps({"auth": self.headers.get('authorization', '')[:12], "body": json.loads(b)}) + "\n")
        self.send_response(201); self.end_headers(); self.wfile.write(b'{"id":"x"}')
    def do_GET(self):
        self.send_response(404); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
python3 srv.py $PORT > /dev/null 2>&1 < /dev/null &
SP=$!
trap 'kill $SP 2>/dev/null; rm -rf "$T/codex-home/auth.json"' EXIT
sleep 1
mkdir repo && cd repo && git init -q && git commit -q --allow-empty -m init && cd ..
KEY=al_e2e_test_key_000000000000000000
export WAVEBRAIN_HOME="$T/wb"
inst() { local h="$1"; shift; node "$ROOT/packages/$h/bin/cli.mjs" install --key $KEY --url http://127.0.0.1:$PORT/api/mcp --yes "$@"; }

if [ "$WHICH" = codex ]; then
  export CODEX_HOME="$T/codex-home"; mkdir -p "$CODEX_HOME"
  cp ~/.codex/auth.json "$CODEX_HOME/auth.json"
  HOME="$T" inst codex | sed 's/^/  install: /'
  echo "--- hooks.json:"; cat "$CODEX_HOME/hooks.json"
  cd repo
  codex exec ${CODEX_EXTRA:---dangerously-bypass-hook-trust} --skip-git-repo-check -s danger-full-access -c approval_policy='"never"' \
    'Run these shell commands one at a time: `ls`, then `git push --dry-run origin main` (it will fail, that is fine). Then reply DONE.' 2>&1 | tail -5 | sed 's/^/  codex: /'
elif [ "$WHICH" = claude ]; then
  HOME="$T" CLAUDE_CONFIG_DIR="$T/.claude" inst claude-code --no-claude-permission | sed 's/^/  install: /'
  cd repo
  # Use the settings file init wrote (auth stays in the real login).
  claude -p 'Run these bash commands one at a time: `ls`, then `git commit -q --allow-empty -m e2e`, then `git push --dry-run origin main` (it will fail, that is fine). Then reply DONE.' \
    --settings "$T/.claude/settings.json" --allowedTools Bash --model haiku --max-turns 8 2>&1 | tail -2 | sed 's/^/  claude: /'
elif [ "$WHICH" = claude-plugin ]; then
  # The marketplace plugin, loaded straight from plugins/claude-code (hooks + skill + .mcp.json).
  cd repo
  WAVEBRAIN_API_KEY=$KEY WAVEBRAIN_API_URL=http://127.0.0.1:$PORT/api/v1/actions \
  claude -p 'Run these bash commands one at a time: `ls`, then `git commit -q --allow-empty -m plugin-e2e`. Then reply with the list of skills you have whose name contains "wavebrain", or NONE.' \
    --plugin-dir "$ROOT/plugins/claude-code" --allowedTools Bash --model haiku --max-turns 8 2>&1 | tail -3 | sed 's/^/  claude: /'
elif [[ "$WHICH" == hermes:* ]]; then
  # A real Hermes profile (pass a throwaway one, e.g. hermes profile create wbtest --clone).
  PROFILE="${WHICH#hermes:}"
  env -u HERMES_HOME node "$ROOT/packages/hermes/bin/cli.mjs" install --key $KEY --url http://127.0.0.1:$PORT/api/mcp --yes --profile "$PROFILE" | sed 's/^/  install: /'
  echo "  plugins.enabled has wavebrain: $(grep -A5 '^plugins:' ~/.hermes/profiles/$PROFILE/config.yaml | grep -c wavebrain)"
  cd repo
  env -u HERMES_HOME hermes -p "$PROFILE" chat -Q -q "Use the terminal tool to run these commands in $T/repo, one at a time: \`ls\`, then \`git commit -q --allow-empty -m hermes-e2e\`, then \`git push --dry-run origin main\` (it will fail, that's expected). Don't call any WaveBrain tools. Then reply DONE." 2>&1 | tail -3 | sed 's/^/  hermes: /'
fi
sleep 3
echo "--- mock WaveBrain received:"; cat "$T/posts.jsonl" 2>/dev/null || echo NONE
echo "--- left in queue:"; ls "$T/wb/queue" 2>/dev/null || echo "(empty)"
