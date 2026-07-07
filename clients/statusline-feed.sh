#!/usr/bin/env bash
# Claude Code statusLine → render a line AND report this account's rate-limit
# usage to aigate (so idle-ish accounts stay fresh from real use).
# settings.json: "statusLine": { "type": "command", "command": "bash ~/.claude/aigate/statusline-feed.sh" }
input="$(cat)"
python3 - "$input" <<'PY'
import json, os, sys, urllib.request, threading
d = json.loads(sys.argv[1] or "{}")
rl = d.get("rate_limits") or {}
five = (rl.get("five_hour") or {}).get("used_percentage") or 0
week = (rl.get("seven_day") or {}).get("used_percentage") or 0
acct = os.environ.get("AIGATE_ACCOUNT", "")
ctx  = (d.get("context_window") or {}).get("used_percentage") or 0

def report():
    if not acct: return
    try:
        body = json.dumps({"account": acct, "five_hour_pct": five, "seven_day_pct": week}).encode()
        req = urllib.request.Request(os.environ["AIGATE_URL"] + "/api/events/usage", data=body,
              headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"], "content-type": "application/json"})
        urllib.request.urlopen(req, timeout=2).read()
    except Exception: pass
threading.Thread(target=report, daemon=True).start()

def c(p): return "\033[31m" if p>=80 else "\033[33m" if p>=50 else "\033[32m"
line = f"🛡️ {acct or '?'} \033[2mctx\033[0m {int(ctx)}%"
if week: line += f" \033[2m· wk\033[0m {c(week)}{int(week)}%\033[0m"
sys.stdout.write(line)
PY
