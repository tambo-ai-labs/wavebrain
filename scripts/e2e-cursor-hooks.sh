#!/bin/bash
# Runs the Cursor plugin's hooks.json commands exactly as written, with Cursor-format events, against
# a mock WaveBrain API. (Cursor itself isn't needed; this checks the plugin's wiring.)
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
T=$(mktemp -d); PORT=$((20000 + RANDOM % 20000))
cat > "$T/srv.py" <<'EOF'
import http.server, json, sys
T, P = sys.argv[1], int(sys.argv[2])
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        b = self.rfile.read(int(self.headers['content-length']))
        open(T + '/posts.jsonl', 'a').write(json.dumps(json.loads(b)) + "\n")
        self.send_response(201); self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', P), H).serve_forever()
EOF
python3 "$T/srv.py" "$T" $PORT > /dev/null 2>&1 < /dev/null &
SP=$!
trap 'kill $SP 2>/dev/null' EXIT
sleep 1
export CURSOR_PLUGIN_ROOT="$ROOT/plugins/cursor" WAVEBRAIN_HOME="$T/wb" WAVEBRAIN_API_URL="http://127.0.0.1:$PORT/api/v1/actions"
export WAVEBRAIN_API_KEY=al_e2e_test_key_000000000000000000
cmd() { python3 -c "import json,sys;print(json.load(open(sys.argv[2]))['hooks'][sys.argv[1]][0]['command'])" "$1" "$ROOT/plugins/cursor/hooks/hooks.json"; }
ev() { (cd "$T" && echo "$2" | sh -c "$(cmd "$1")") && echo "  $1: exit 0"; }
W='"workspace_roots":["/w/myapp"],"conversation_id":"c1"'
ev postToolUse "{\"hook_event_name\":\"postToolUse\",$W,\"tool_name\":\"Shell\",\"tool_input\":{\"command\":\"ls -la\"}}"
ev postToolUse "{\"hook_event_name\":\"postToolUse\",$W,\"tool_name\":\"Shell\",\"tool_input\":{\"command\":\"vercel deploy --prod --token sk_live_abcdefghijklmnopqrst\"}}"
ev postToolUseFailure "{\"hook_event_name\":\"postToolUseFailure\",$W,\"tool_name\":\"Shell\",\"tool_input\":{\"command\":\"git push origin main\"},\"error\":\"rejected\"}"
ev postToolUse "{\"hook_event_name\":\"postToolUse\",$W,\"tool_name\":\"MCP:create_refund\",\"tool_input\":{\"charge\":\"ch_1\",\"amount\":500},\"tool_output\":{\"redacted\":true}}"
ev postToolUse "{\"hook_event_name\":\"postToolUse\",$W,\"tool_name\":\"MCP:search_docs\",\"tool_input\":{\"q\":\"x\"}}"
ev stop "{\"hook_event_name\":\"stop\",$W,\"status\":\"completed\"}"
sleep 1
echo "--- mock WaveBrain received:"
python3 - "$T/posts.jsonl" <<'EOF'
import json, sys
rows = [json.loads(l) for l in open(sys.argv[1])] if __import__("os").path.exists(sys.argv[1]) else []
for d in rows: print(" ", d["agent"], d["type"], d["status"], "|", d["title"], "|", d.get("project"))
print("  secret in payload:", any("sk_live_abcdefghij" in json.dumps(d) for d in rows))
EOF
