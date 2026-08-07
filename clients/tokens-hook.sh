#!/usr/bin/env bash
# Claude Code Stop hook → report REAL token usage to aigate.
#
# Why this exists: prompt-hook.sh fires on UserPromptSubmit, which is BEFORE the model
# responds — no token count exists yet, so every request_log row's `tokens` column has
# always been 0. This hook fires on Stop (turn finished), reads the session transcript
# JSONL that Claude Code already writes to disk, pulls token usage off the LAST assistant
# message, and posts it.
#
# NOT INSTALLED by clients/install.sh (proposal only — wire it in yourself for now):
#   Register in ~/.claude/settings.json:
#     "hooks": { "Stop": [ { "hooks": [
#       { "type": "command", "command": "bash ~/.claude/aigate/tokens-hook.sh" } ] } ] }
#   And copy this file to ~/.claude/aigate/tokens-hook.sh (install -m 0755).
#
# ASSUMPTION: tokens are posted as a NEW /api/events/prompt row (prompt left empty — the
# text was already logged by prompt-hook.sh), not an UPDATE to that earlier row. The server
# has no endpoint to target/UPDATE a specific request_log row by id, and adding one is out
# of scope for a client-only script (src/server.js already accepts `tokens` on INSERT, per
# the ~line 768 `b.tokens ?? null`). Trade-off: /api/stats' per-host `requests` count will
# roughly double per turn (one prompt row + one tokens row); `tokens`/`tps` stay correct
# since the prompt row always carries tokens=null. To dodge the OTHER double-count failure
# mode — resubmitting the same usage on every Stop within one long session — this only ever
# reads the transcript's LAST assistant message and skips posting if its message id matches
# the last id we already reported for this session (best-effort local dedup cache).
#
# Runs LOCALLY on the official client; aigate is never in Anthropic's path. Fail-open:
# network/vault down, missing/unreadable transcript, or unexpected JSONL shape must NEVER
# break the user's shell or block Stop from completing.
[ -n "${AIGATE_URL:-}" ] || { set -a; . "$HOME/.claude/aigate/env" 2>/dev/null; set +a; }
in="$(cat)"
python3 - "$in" <<'PY' &
import json, os, sys, urllib.request

try:
    d = json.loads(sys.argv[1] or "{}")
    transcript = d.get("transcript_path") or d.get("transcript") or ""
    session_id = d.get("session_id", "")
    if not transcript or not os.path.isfile(transcript):
        sys.exit(0)

    # walk the JSONL, keep the LAST assistant message that carries a usage block —
    # transcript format is Claude Code internal and has shifted before, so every
    # access here is defensive (.get with defaults, skip unparsable lines).
    last_usage, last_model, last_id = None, "", ""
    with open(transcript, "r", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except Exception:
                continue
            if entry.get("type") != "assistant":
                continue
            msg = entry.get("message") or {}
            usage = msg.get("usage")
            if not isinstance(usage, dict):
                continue
            last_usage = usage
            last_model = msg.get("model", "") or ""
            last_id = msg.get("id", "") or ""

    if not last_usage:
        sys.exit(0)

    tokens = sum(int(last_usage.get(k) or 0) for k in (
        "input_tokens", "output_tokens",
        "cache_creation_input_tokens", "cache_read_input_tokens"))
    if tokens <= 0:
        sys.exit(0)

    # best-effort dedup: skip if we already reported this exact assistant message
    # for this session (e.g. a re-fired Stop with no new turn appended).
    cache = os.path.expanduser(f"~/.claude/aigate/.tokens-last-{session_id}") if session_id else ""
    if cache and last_id:
        try:
            with open(cache) as f:
                if f.read().strip() == last_id:
                    sys.exit(0)
        except Exception:
            pass

    payload = json.dumps({
        "account": os.environ.get("AIGATE_ACCOUNT", ""),
        "host": os.uname().nodename,
        "cwd": d.get("cwd", ""),
        "model": last_model,
        "prompt": "",
        "tokens": tokens,
    }).encode()
    req = urllib.request.Request(
        os.environ["AIGATE_URL"] + "/api/events/prompt", data=payload,
        headers={"Authorization": "Bearer " + os.environ["AIGATE_TOKEN"],
                 "content-type": "application/json"})
    urllib.request.urlopen(req, timeout=3).read()

    if cache and last_id:
        try:
            with open(cache, "w") as f:
                f.write(last_id)
        except Exception:
            pass
except Exception:
    pass
PY
exit 0
