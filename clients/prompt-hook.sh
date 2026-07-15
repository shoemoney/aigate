#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook → report the prompt to aigate.
# Register in ~/.claude/settings.json:
#   "hooks": { "UserPromptSubmit": [ { "hooks": [
#     { "type": "command", "command": "bash ~/.claude/aigate/prompt-hook.sh" } ] } ] }
# Runs LOCALLY on the official client; aigate is never in Anthropic's path.
# Hooks fire for ALL claude sessions but only cc exports AIGATE_*; fail-open.
[ -n "${AIGATE_URL:-}" ] || { set -a; . "$HOME/.claude/aigate/env" 2>/dev/null; set +a; }
in="$(cat)"
python3 - "$in" <<'PY' &
import json, os, sys, urllib.request
try:
    d = json.loads(sys.argv[1] or "{}")
    payload = json.dumps({
        "account": os.environ.get("AIGATE_ACCOUNT", ""),
        "host": os.uname().nodename,
        "cwd": d.get("cwd", ""),
        "model": d.get("model", ""),
        "prompt": d.get("prompt", ""),
    }).encode()
    req = urllib.request.Request(
        os.environ["AIGATE_URL"] + "/api/events/prompt", data=payload,
        headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                 "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass
PY
# Per-turn account re-evaluation (backgrounded, fail-open). Re-checks the CURRENT
# account's headroom EVERY turn; if it's exhausted, parks it server-side NOW so every
# selection — other hosts, this session's next `--continue` relaunch, headless `cc -p`
# calls — reroutes to a fresh account immediately, not only when this session exits.
# Cheap cached read first; only pay for a live refresh when already near the cap (≥85,
# same threshold as aigate-run.sh's supervise loop). aigate stays a SELECTOR: this only
# reports YOUR account's own usage — it is never in Anthropic's request path.
python3 - <<'PY' &
import json, os, urllib.request
def call(method, path, timeout):
    req = urllib.request.Request(
        os.environ["AIGATE_URL"] + path, method=method,
        headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                 "content-type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout).read()
try:
    acct = os.environ.get("AIGATE_ACCOUNT", "")   # only cc-launched sessions set this
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
