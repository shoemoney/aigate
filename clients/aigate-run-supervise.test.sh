#!/bin/bash
# Killing aigate-run in print mode must kill the claude it launched.
#
# Print mode captured claude via out="$(claude ...)". Bash defers a trapped TERM
# until that foreground child exits, and when the wrapper did die the child was
# orphaned: on 2026-09-29 a `claude -p` whose API sockets had all gone CLOSED
# outlived its caller's 180s timeout by 20 minutes (pid 49743), and the remember
# consolidation waiting on it stalled with it. Every caller's timeout must reach
# the claude process, and plain output/stdin passthrough must still work.
# Run: bash clients/aigate-run-supervise.test.sh  (also installed beside ~/.claude/aigate/aigate-run.sh)
set -u

fail=0
check() { # desc, expected, actual
    if [ "$2" = "$3" ]; then echo "ok   — $1"; else echo "FAIL — $1: want $2, got $3"; fail=1; fi
}

here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'kill $srv 2>/dev/null; rm -rf "$tmp"' EXIT

# Fake aigate: every GET selects account "t"; every POST is accepted.
port=$((20000 + RANDOM % 20000))
python3 - "$port" >/dev/null 2>&1 <<'EOF' &
import sys, http.server
class H(http.server.BaseHTTPRequestHandler):
    def _ok(self, body):
        self.send_response(200); self.send_header('content-type','application/json'); self.end_headers(); self.wfile.write(body)
    def do_GET(self):  self._ok(b'{"account":"t","setup_token":"x"}')
    def do_POST(self): self.rfile.read(int(self.headers.get('content-length') or 0)); self._ok(b'{}')
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
EOF
srv=$!
for _ in $(seq 50); do curl -s -m1 "http://127.0.0.1:$port/" >/dev/null && break; sleep 0.1; done

# Keep the test off the real Keychain login and settings.
mkdir -p "$tmp/bin" "$tmp/home/.claude"
printf '#!/bin/sh\nexit 1\n' > "$tmp/bin/security"
cat > "$tmp/bin/fake-claude" <<'EOF'
#!/bin/sh
echo "ARGS:$*"; echo "STDIN:$(cat)"
EOF
cat > "$tmp/bin/hang-claude" <<EOF
#!/bin/sh
echo \$\$ > "$tmp/hang.pid"; exec sleep 300
EOF
chmod +x "$tmp/bin/"*
run() { env HOME="$tmp/home" PATH="$tmp/bin:$PATH" AIGATE_URL="http://127.0.0.1:$port" AIGATE_TOKEN=test "$@"; }

out="$(echo piped | run AIGATE_CLAUDE_BIN=fake-claude bash "$here/aigate-run.sh" -p hello 2>/dev/null)"
check "print mode passes args through"   1 "$(printf '%s' "$out" | grep -c '^ARGS:.*-p hello')"
check "print mode passes stdin through"  1 "$(printf '%s' "$out" | grep -c '^STDIN:piped$')"

# exec, not the run() function: a backgrounded function is a subshell, so $! would
# name that subshell and the TERM would never reach aigate-run itself.
( exec env HOME="$tmp/home" PATH="$tmp/bin:$PATH" AIGATE_URL="http://127.0.0.1:$port" AIGATE_TOKEN=test \
    AIGATE_CLAUDE_BIN=hang-claude bash "$here/aigate-run.sh" -p stuck </dev/null >/dev/null 2>&1 ) &
wrapper=$!
for _ in $(seq 50); do [ -s "$tmp/hang.pid" ] && break; sleep 0.1; done
child="$(cat "$tmp/hang.pid" 2>/dev/null)"
check "hung claude started" 1 "$([ -n "$child" ] && kill -0 "$child" 2>/dev/null && echo 1 || echo 0)"
kill -TERM "$wrapper"
for _ in $(seq 30); do kill -0 "$wrapper" 2>/dev/null || break; sleep 0.1; done
check "wrapper exits promptly on TERM"   0 "$(kill -0 "$wrapper" 2>/dev/null && echo 1 || echo 0)"
sleep 0.5
alive="$(kill -0 "$child" 2>/dev/null && echo 1 || echo 0)"
check "TERM reaches the claude it launched" 0 "$alive"
[ "$alive" = 1 ] && kill -9 "$child" 2>/dev/null

[ $fail -eq 0 ] && echo "all ok" || exit 1
