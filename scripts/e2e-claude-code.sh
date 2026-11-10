#!/bin/bash
# Real end-to-end check: Claude Code -> WaveBrain hook -> mock WaveBrain REST endpoint.
set -e
T=$(mktemp -d); cd "$T"
cat > srv.py <<'EOF'
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers['content-length']))
        open('posts.jsonl', 'a').write(json.dumps({"auth": self.headers.get('authorization', '')[:12], "path": self.path, "body": json.loads(b)}) + "\n")
        self.send_response(201); self.end_headers(); self.wfile.write(b'{"id":"x"}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', 8765), H).serve_forever()
EOF
python3 srv.py > /dev/null 2>&1 < /dev/null &
SP=$!
trap 'kill $SP 2>/dev/null' EXIT
sleep 1
mkdir repo && cd repo && git init -q && git commit -q --allow-empty -m init && cd ..
H="$1"
cat > settings.json <<EOF
{"hooks":{"PostToolUse":[{"matcher":"Bash|mcp__.*","hooks":[{"type":"command","command":"node \"$H\" claude-code observe","timeout":10}]}],
"PostToolUseFailure":[{"matcher":"Bash|mcp__.*","hooks":[{"type":"command","command":"node \"$H\" claude-code observe","timeout":10}]}],
"Stop":[{"hooks":[{"type":"command","command":"node \"$H\" claude-code flush","timeout":30}]}]}}
EOF
cd repo
WAVEBRAIN_HOME=$T/wb WAVEBRAIN_API_KEY=al_e2e_test_key_00000000000000 WAVEBRAIN_API_URL=http://127.0.0.1:8765/api/v1/actions \
  claude -p 'Run exactly these two bash commands, one at a time: first `ls -la`, then `git push --dry-run origin main`. The second will fail; that is expected. Then reply DONE.' \
  --settings "$T/settings.json" --allowedTools Bash --model haiku --max-turns 6 --output-format json 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('claude:',d.get('subtype'),'turns',d.get('num_turns'),d.get('result','')[:60])"
sleep 2
echo "--- mock WaveBrain received:"; cat "$T/posts.jsonl" 2>/dev/null || echo NONE
echo "--- queue left:"; ls "$T/wb/queue" 2>/dev/null || echo empty
