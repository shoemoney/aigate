#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook → report the prompt to aigate and record the
# session→account mapping the spend collector attributes usage events with.
# Register in ~/.claude/settings.json:
#   "hooks": { "UserPromptSubmit": [ { "hooks": [
#     { "type": "command", "command": "bash ~/.claude/aigate/prompt-hook.sh" } ] } ] }
# Runs LOCALLY on the official client; aigate is never in Anthropic's path.
# Hooks fire for ALL claude sessions but only the ai launcher (and the T3/cmux launchers) export AIGATE_*; fail-open.
[ -n "${AIGATE_URL:-}" ] || { set -a; . "$HOME/.claude/aigate/env" 2>/dev/null; set +a; }
in="$(cat)"
# Detach the child's stdio (>/dev/null 2>&1) so it does NOT hold this hook's inherited
# pipe open — otherwise a hook runner that waits on stdio-EOF blocks the turn until the
# backgrounded HTTP calls finish. We want truly zero-latency fire-and-forget.
python3 - "$in" >/dev/null 2>&1 <<'PY' &
import datetime, json, os, sys, urllib.request
def post(path, obj, timeout):
    req = urllib.request.Request(
        os.environ["AIGATE_URL"] + path, data=json.dumps(obj).encode(),
        headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                 "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=timeout).read()
try:
    d = json.loads(sys.argv[1] or "{}")
except Exception:
    d = {}
# Spend attribution: the hook is the one place that sees BOTH the real session_id and the aigate
# account (AIGATE_ACCOUNT, only exported by ai/T3/cmux launches). Append the mapping to the local
# sidecar FIRST (the collector replays it if aigate was down), then POST it fire-and-forget.
# Ids and timestamps only: never the prompt or any transcript text.
try:
    acct, sid = os.environ.get("AIGATE_ACCOUNT", ""), d.get("session_id", "")
    if acct and sid:
        now = datetime.datetime.now(datetime.timezone.utc)
        line = {"source": "claude_code", "host": os.uname().nodename, "session_id": sid, "scope": "",
                "account": acct, "kind": "claude", "via": "hook",
                "ts": now.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (now.microsecond // 1000)}
        try:
            adir = os.environ.get("AIGATE_DIR") or os.path.join(os.path.expanduser("~"), ".claude", "aigate")
            os.makedirs(adir, exist_ok=True)
            fd = os.open(os.path.join(adir, "spend-sessions.jsonl"), os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
            try:
                os.write(fd, (json.dumps(line) + "\n").encode())
            finally:
                os.close(fd)
        except Exception:
            pass
        post("/api/spend/sessions", line, 3)
except Exception:
    pass
try:
    post("/api/events/prompt", {
        "account": os.environ.get("AIGATE_ACCOUNT", ""),
        "host": os.uname().nodename,
        "cwd": d.get("cwd", ""),
        "model": d.get("model", ""),
        "prompt": d.get("prompt", ""),
    }, 3)
except Exception:
    pass
PY
# Per-turn account re-evaluation (backgrounded, fail-open). Re-checks the CURRENT
# account's headroom EVERY turn; if it's exhausted, parks it server-side NOW so every
# selection — other hosts, this session's next `--continue` relaunch, headless `ai -p`
# calls — reroutes to a fresh account immediately, not only when this session exits.
# Cheap cached read first; only pay for a live refresh when already near the cap (≥85,
# same threshold as aigate-run.sh's supervise loop). aigate stays a SELECTOR: this only
# reports YOUR account's own usage — it is never in Anthropic's request path.
# stdio detached (>/dev/null 2>&1) so these serial HTTP calls never block the turn.
python3 - >/dev/null 2>&1 <<'PY' &
import json, os, urllib.request
def call(method, path, timeout):
    req = urllib.request.Request(
        os.environ["AIGATE_URL"] + path, method=method,
        headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                 "content-type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()
try:
    acct = os.environ.get("AIGATE_ACCOUNT", "")   # only ai/T3/cmux-launched sessions set this
    if not acct:
        raise SystemExit
    me = next((a for a in json.loads(call("GET", "/api/accounts", 4))
               if a.get("account") == acct), None)
    if not me or max(me.get("five_hour_pct") or 0, me.get("seven_day_pct") or 0) < 85:
        raise SystemExit                          # unknown or headroom left → nothing to do
    if str(json.loads(call("POST", "/api/accounts/%s/refresh" % acct, 15)).get("maxed")) == "1":
        body = json.dumps({"account": acct, "host": os.uname().nodename}).encode()
        req = urllib.request.Request(
            os.environ["AIGATE_URL"] + "/api/events/limit", data=body,
            headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                     "content-type": "application/json"})
        urllib.request.urlopen(req, timeout=5).read()
except Exception:
    pass
PY
exit 0
