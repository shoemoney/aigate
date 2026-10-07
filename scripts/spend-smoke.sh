#!/usr/bin/env bash
# Spend rollout smoke: posts a 3-event batch twice (accepted 3, then duplicate 3), posts a session
# mapping (resolved >= 1), and round-trips GET /api/spend. Needs AIGATE_URL + AIGATE_TOKEN in the
# environment or in ~/.claude/aigate/env. Exits non-zero naming the failing step.
# Each run uses fresh ids under host "spend-smoke" so it is safe to repeat against a live instance.
set -u

if [ -z "${AIGATE_URL:-}" ] || [ -z "${AIGATE_TOKEN:-}" ]; then
  ENVFILE="${AIGATE_ENV_FILE:-$HOME/.claude/aigate/env}"
  if [ -f "$ENVFILE" ]; then set -a; . "$ENVFILE"; set +a; fi
fi

step=""
fail() { echo "spend-smoke: FAIL at step '$step': $*" >&2; exit 1; }

step="config"
[ -n "${AIGATE_URL:-}" ] || fail "AIGATE_URL not set (env or ~/.claude/aigate/env)"
[ -n "${AIGATE_TOKEN:-}" ] || fail "AIGATE_TOKEN not set (env or ~/.claude/aigate/env)"
command -v curl >/dev/null || fail "curl not found"
command -v python3 >/dev/null || fail "python3 not found"
BASE="${AIGATE_URL%/}"

RUN="$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
SESSION="smoke-$RUN"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

call() { # method path [json-body-file]; body lands in $TMP/out, prints the http status
  local m="$1" p="$2" f="${3:-}"
  if [ -n "$f" ]; then
    curl -s -m 20 -o "$TMP/out" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $AIGATE_TOKEN" \
      -H 'Content-Type: application/json' --data-binary "@$f" "$BASE$p"
  else
    curl -s -m 20 -o "$TMP/out" -w '%{http_code}' -X "$m" -H "Authorization: Bearer $AIGATE_TOKEN" "$BASE$p"
  fi
}

jget() {
  python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
for k in sys.argv[2].split("."): d=d[k]
print(d)' "$TMP/out" "$1" 2>/dev/null
}

python3 - "$RUN" "$SESSION" "$TMP" <<'PY'
import json, sys, datetime
run, session, tmp = sys.argv[1:4]
now = datetime.datetime.now(datetime.timezone.utc)
def ts(sec): return (now - datetime.timedelta(seconds=sec)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
events = [{
    "source_event_id": f"smoke-{run}-{i}", "ts": ts(30 - i * 5),
    "provider": "anthropic", "model": "claude-opus-5-5",
    "input_tokens": 10 + i, "output_tokens": 20 + i, "cache_read_tokens": 300 + i,
    "cache_write_tokens": 40 + i, "cache_write_1h_tokens": 0,
    "cache_tokens_in_prompt": False, "status": "success",
    "project": "spend-smoke", "session_id": session, "session_started_at": None, "scope": "",
} for i in range(3)]
json.dump({"source": "claude_code", "host": "spend-smoke", "collector_version": "smoke",
           "summary": {"files": 0, "scanned": 0, "errors": 0}, "events": events},
          open(f"{tmp}/events.json", "w"))
json.dump({"source": "claude_code", "host": "spend-smoke", "session_id": session, "scope": "",
           "account": "spend-smoke", "kind": "claude", "via": "smoke", "ts": ts(0)},
          open(f"{tmp}/session.json", "w"))
PY

step="health"
code="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/health")"
[ "$code" = "200" ] || fail "GET /health returned $code"

step="post-events"
code="$(call POST /api/spend/events "$TMP/events.json")"
[ "$code" = "200" ] || fail "POST /api/spend/events returned $code: $(cat "$TMP/out")"
[ "$(jget accepted)" = "3" ] || fail "expected accepted 3, got: $(cat "$TMP/out")"
echo "ok  post-events: accepted 3"

step="post-events-duplicate"
code="$(call POST /api/spend/events "$TMP/events.json")"
[ "$code" = "200" ] || fail "duplicate POST /api/spend/events returned $code: $(cat "$TMP/out")"
[ "$(jget accepted)" = "0" ] || fail "re-post must accept 0, got: $(cat "$TMP/out")"
[ "$(jget duplicate)" = "3" ] || fail "expected duplicate 3, got: $(cat "$TMP/out")"
echo "ok  post-events-duplicate: accepted 0, duplicate 3"

step="post-session"
code="$(call POST /api/spend/sessions "$TMP/session.json")"
[ "$code" = "200" ] || fail "POST /api/spend/sessions returned $code: $(cat "$TMP/out")"
resolved="$(jget resolved)"
[ -n "$resolved" ] && [ "$resolved" -ge 1 ] 2>/dev/null || fail "expected resolved >= 1, got: $(cat "$TMP/out")"
echo "ok  post-session: resolved $resolved"

step="get-spend"
FROM="$(python3 -c 'import datetime as d;print((d.datetime.now(d.timezone.utc)-d.timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
code="$(call GET "/api/spend?from=$FROM")"
[ "$code" = "200" ] || fail "GET /api/spend returned $code: $(cat "$TMP/out")"
python3 - "$TMP/out" <<'PY' || fail "GET /api/spend shape check failed (see above)"
import json, sys
d = json.load(open(sys.argv[1]))
t = d.get("totals")
if not isinstance(t, dict):
    sys.exit("totals missing")
need = ["value_usd", "spend_usd", "unknown_usd",
        "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"]
missing = [k for k in need if k not in t]
if missing:
    sys.exit("totals missing fields: " + ", ".join(missing))
if t["events"] < 3:
    sys.exit("totals.events < 3 after posting 3 events")
def walk(o, path):
    if isinstance(o, dict):
        for k, v in o.items():
            if k == "tokens":
                sys.exit("forbidden key 'tokens' at " + path)
            walk(v, path + "." + k)
    elif isinstance(o, list):
        for i, v in enumerate(o):
            walk(v, f"{path}[{i}]")
walk(d, "$")
PY
echo "ok  get-spend: three dollar fields + four token buckets present, no 'tokens' key"

echo "spend-smoke: PASS ($BASE, run $RUN)"
