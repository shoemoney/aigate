#!/usr/bin/env bash
# Claude Code statusLine → render a line AND report this account's rate-limit
# usage to aigate (so idle-ish accounts stay fresh from real use).
# settings.json: "statusLine": { "type": "command", "command": "bash ~/.claude/aigate/statusline-feed.sh" }
# Hooks fire for ALL claude sessions but only cc exports AIGATE_*; fail-open.
[ -n "${AIGATE_URL:-}" ] || { set -a; . "$HOME/.claude/aigate/env" 2>/dev/null; set +a; }
input="$(cat)"
python3 - "$input" <<'PY'
import json, os, sys, urllib.request
d = json.loads(sys.argv[1] or "{}")
rl = d.get("rate_limits") or {}
five = (rl.get("five_hour") or {}).get("used_percentage") or 0
week = (rl.get("seven_day") or {}).get("used_percentage") or 0
acct = os.environ.get("AIGATE_ACCOUNT", "")
ctx  = (d.get("context_window") or {}).get("used_percentage") or 0

def c(p): return "\033[31m" if p>=80 else "\033[33m" if p>=50 else "\033[32m"
line = f"🛡️ {acct or '?'} \033[2mctx\033[0m {int(ctx)}%"
if week: line += f" \033[2m· wk\033[0m {c(week)}{int(week)}%\033[0m"
sys.stdout.write(line)
sys.stdout.flush()  # before fork: exactly one copy of the line reaches claude

# POST from a detached fork — a daemon thread dies at interpreter exit before
# the request sends. rl-truthy guard: a missing rate_limits field must not
# clobber real usage with zeros (rl present with value 0 still posts).
if acct and rl and os.fork() == 0:
    try: os.setsid()
    except OSError: pass
    nul = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2): os.dup2(nul, fd)
    try:
        body = json.dumps({"account": acct, "five_hour_pct": five, "seven_day_pct": week}).encode()
        req = urllib.request.Request(os.environ["AIGATE_URL"] + "/api/events/usage", data=body,
              headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"], "content-type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception: pass
    os._exit(0)
PY
