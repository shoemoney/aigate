#!/usr/bin/env bash
# aigate-worker — one kanban worker. Claims the next 'todo' card from the aigate
# board over HTTP, runs the prompt through `ai` (the account-rotating wrapper →
# official claude binary, NEVER relayed through the server), and posts the result
# back. SQLite on the server is the source of truth; this is a stateless puller.
#
#   env: AIGATE_URL, AIGATE_TOKEN   (sourced from ~/.claude/aigate/env)
#        AIGATE_AI_CMD   (default: ai)   AIGATE_WORKER_IDLE (default: 3s)
#   usage: aigate-worker.sh          # loops forever; run N copies for N workers
set -uo pipefail
[ -f "$HOME/.claude/aigate/env" ] && { set -a; . "$HOME/.claude/aigate/env"; set +a; }
: "${AIGATE_URL:?not set — run: set -a; . ~/.claude/aigate/env; set +a}"
: "${AIGATE_TOKEN:?not set — run: set -a; . ~/.claude/aigate/env; set +a}"
AI_CMD="${AIGATE_AI_CMD:-ai}"
# extra args passed BEFORE -p (e.g. the `ai` wrapper defaults to --chrome, which hangs a
# headless worker — set AIGATE_AI_PREARGS=--no-chrome). Word-split on spaces.
PRE=(); [ -n "${AIGATE_AI_PREARGS:-}" ] && read -ra PRE <<< "$AIGATE_AI_PREARGS"
IDLE="${AIGATE_WORKER_IDLE:-3}"
WORKER="$(hostname -s)/$$"
AUTH=(-H "Authorization: Bearer $AIGATE_TOKEN")

# top-level JSON field → stdout (empty on any error); same convention as hydrate.sh
jget(){ python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("'"$1"'","") or "")
except Exception: print("")' 2>/dev/null; }

# claude `-p --output-format json` returns EITHER a single result object OR an ARRAY of
# events whose LAST element carries result/session_id (varies by claude version) — handle both.
aiget(){ python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    if isinstance(d,list): d=(d[-1] if d else {})
    print(d.get("'"$1"'","") or "")
except Exception: print("")' 2>/dev/null; }

# post {ok,result,session_id,error} for a card; body built with json.dumps so a
# result full of quotes/newlines can never break the JSON. ponytail: result rides
# argv (fine for normal -p output); a multi-MB result would hit ARG_MAX — stream a
# temp file then if that ever bites.
post_result(){ # id ok result session_id error
  python3 -c 'import json,sys
print(json.dumps({"ok": sys.argv[2]=="true", "result": sys.argv[3],
                  "session_id": sys.argv[4], "error": sys.argv[5]}))' "$@" \
    | curl -s -m20 -X POST "${AUTH[@]}" -H 'content-type: application/json' \
        --data-binary @- "$AIGATE_URL/api/board/$1/result" >/dev/null 2>&1
}

# the card asks Claude to finish with a tight bullet summary — that's what the board shows.
# ponytail: effort has no native claude CLI flag, so we pass it as a directive line;
# tune this mapping (or wire a real flag) if the fleet grows a proper effort knob.
SUMMARY_RULE='When finished, end your reply with a section titled "Done:" listing, as specific bullet points, exactly what you did (files changed, commands run, decisions made). Be concrete, not vague.'

echo "aigate-worker $WORKER → $AIGATE_URL" >&2
while :; do
  claim="$(curl -s -m10 -X POST "${AUTH[@]}" -H 'content-type: application/json' \
      -d "{\"worker\":\"$WORKER\"}" "$AIGATE_URL/api/board/claim")"
  id="$(printf '%s' "$claim" | jget id)"
  [ -n "$id" ] || { sleep "$IDLE"; continue; }   # 204/empty = queue empty
  prompt="$(printf '%s' "$claim" | jget prompt)"
  cwd="$(printf '%s' "$claim" | jget cwd)"
  model="$(printf '%s' "$claim" | jget model)"
  effort="$(printf '%s' "$claim" | jget effort)"
  sid="$(printf '%s' "$claim" | jget session_id)"
  echo "aigate-worker $WORKER → card $id${sid:+ (resume $sid)}${cwd:+ in $cwd}" >&2

  # run in the card's directory (subshell so cd never leaks to the next card)
  if [ -n "$cwd" ] && [ ! -d "$cwd" ]; then
    post_result "$id" false "" "" "directory not found: $cwd"; continue
  fi
  resume=();  [ -n "$sid" ]   && resume=(--resume "$sid")
  modelarg=(); [ -n "$model" ] && modelarg=(--model "$model")
  full_prompt="$prompt"$'\n\n'"[effort: ${effort:-medium}] $SUMMARY_RULE"
  out="$( cd "${cwd:-$PWD}" && "$AI_CMD" "${PRE[@]}" -p --output-format json "${resume[@]}" "${modelarg[@]}" "$full_prompt" 2>/dev/null )"; rc=$?
  if [ "$rc" -eq 0 ] && [ -n "$out" ]; then
    # claude --output-format json envelope: {result, session_id, ...} (or an array whose last elem has them)
    post_result "$id" true "$(printf '%s' "$out" | aiget result)" "$(printf '%s' "$out" | aiget session_id)" ""
  else
    post_result "$id" false "" "" "ai run failed (rc=$rc): $(printf '%.500s' "$out")"
  fi
done
