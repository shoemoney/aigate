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
exit 0
