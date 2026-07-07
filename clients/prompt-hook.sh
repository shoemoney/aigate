#!/usr/bin/env bash
# Claude Code UserPromptSubmit hook → report the prompt to cclb.
# Register in ~/.claude/settings.json:
#   "hooks": { "UserPromptSubmit": [ { "hooks": [
#     { "type": "command", "command": "bash ~/.claude/cclb/prompt-hook.sh" } ] } ] }
# Runs LOCALLY on the official client; cclb is never in Anthropic's path.
in="$(cat)"
python3 - "$in" <<'PY' &
import json, os, sys, urllib.request
try:
    d = json.loads(sys.argv[1] or "{}")
    payload = json.dumps({
        "account": os.environ.get("CCLB_ACCOUNT", ""),
        "host": os.uname().nodename,
        "cwd": d.get("cwd", ""),
        "model": d.get("model", ""),
        "prompt": d.get("prompt", ""),
    }).encode()
    req = urllib.request.Request(
        os.environ["CCLB_URL"] + "/api/events/prompt", data=payload,
        headers={"Authorization": "Bearer " + os.environ["CCLB_TOKEN"],
                 "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=3).read()
except Exception:
    pass
PY
exit 0
