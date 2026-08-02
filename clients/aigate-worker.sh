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
HOST="$(hostname -s)"
WORKER="$HOST/$$"
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

# report what this worker is doing right now (drives the live activity panel)
post_activity(){ # cardId activity
  python3 -c 'import json,sys;print(json.dumps({"worker":sys.argv[1],"host":sys.argv[2],"cardId":int(sys.argv[3]),"activity":sys.argv[4][:90]}))' \
    "$WORKER" "$HOST" "$1" "$2" \
    | curl -s -m5 -X POST "${AUTH[@]}" -H 'content-type: application/json' --data-binary @- "$AIGATE_URL/api/board/activity" >/dev/null 2>&1 || true
}
# one stream-json line -> a short human activity string ("using Bash — npm test", "responding", …)
activity_of(){ python3 -c 'import sys,json
try:
    d=json.loads(sys.stdin.read()); t=d.get("type")
    if t=="assistant":
        for c in d.get("message",{}).get("content",[]):
            if c.get("type")=="tool_use":
                i=c.get("input",{}) or {}; hint=i.get("command") or i.get("file_path") or i.get("path") or i.get("pattern") or i.get("url") or ""
                print(("using "+c.get("name","tool")+((" — "+str(hint)) if hint else ""))[:90]); break
            if c.get("type")=="text" and c.get("text","").strip(): print("responding"); break
    elif t=="user": print("ran tool")
    elif t=="result": print("finishing")
except Exception: pass' 2>/dev/null; }
# scan the whole NDJSON stream for the final result event -> {"result":..,"session_id":..}
stream_final(){ python3 -c 'import sys,json
res="";sid=""
for ln in sys.stdin:
    ln=ln.strip()
    if not ln: continue
    try: d=json.loads(ln)
    except Exception: continue
    if d.get("session_id"): sid=d.get("session_id")
    if d.get("type")=="result": res=d.get("result","") or res
print(json.dumps({"result":res,"session_id":sid}))' 2>/dev/null; }

# the card asks Claude to finish with a tight bullet summary — that's what the board shows.
# ponytail: effort has no native claude CLI flag, so we pass it as a directive line;
# tune this mapping (or wire a real flag) if the fleet grows a proper effort knob.
SUMMARY_RULE='When finished, end your reply with a section titled "Done:" listing, as specific bullet points, exactly what you did (files changed, commands run, decisions made). Be concrete, not vague.'

# Operating briefing prepended to every card so headless card-Claude knows its context + where
# the fleet's credentials live (it runs in a bare cwd and otherwise has no idea these exist).
BRIEF='You are running headlessly as an autonomous aigate BOARD WORKER on the fleet (host '"$HOST"'). No human is watching — do not ask questions; make reasonable decisions and finish. Permissions are already bypassed.

WORK QUALITY (self-review loop) — for any non-trivial task, do NOT stop at first draft: (1) do the work, (2) switch hats to a skeptical REVIEWER and check it — run the tests/build/linter, re-read your own diff, hunt for errors, edge cases, and broken assumptions, (3) fix what you find, (4) re-check. Loop until it genuinely passes. Only then write the summary.

GIT — if you change anything in a git repo: commit (conventional message; house rule = NO AI attribution), MERGE back to the main branch if you branched, PUSH, and clean up (delete stray branches/temp files; leave the working tree clean). Changes sync across the fleet via git + Syncthing. Never leave uncommitted work.

CREDENTIALS / APIs — secrets are NOT in the repo; they live in the aigate vault:
    set -a; . ~/.claude/aigate/env; set +a
    curl -s -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/keys/<provider>"   # -> {provider,label,key}
  Providers: openrouter google github brave exa firecrawl perplexity replicate fal elevenlabs deepgram huggingface groq together fireworks xai kimi cloudflare aws tavily apify context7 gmail venice fontawesome. Full live list: GET "$AIGATE_URL/api/capabilities". (You do NOT need a raw Anthropic API key — you already ARE Claude via the selected account.)
  - EMAIL: operator is jeremy@shoemoney.com; Gmail app-cred vaulted under provider "gmail" -> imap.gmail.com:993 / smtp.gmail.com:587, or the gmail-imap-watch skill.
  - AWS: credentials are already on this box at ~/.aws (config/credentials/sso) — the aws CLI is configured; no vault fetch needed.

FLEET SSH + SUDO — you have PASSWORDLESS SUDO on every host, and ssh keys to the whole LAN (192.168.1.0/24):
  - Macs + NAS (.3 hueb, .4 reek, .5 wick, .7, .10 nas, .33 mbp): default key ~/.ssh/id_ed25519.
  - Pi docker swarm (.11 Pstan, .12 Pkyle, .13 Pcartman … .11-.20): key ~/.ssh/pi  (use: ssh -i ~/.ssh/pi <ip>).
  Reach hosts by LAN IP/hostname. Some hosts firewall-DENY outside IPs but are reachable on the LAN — always use the LAN address, never a public one.

NEW HOSTS/SERVICES — if you stand up a new service/host, register it so it resolves + proxies:
  - Local DNS: add an A-record in Pi-hole (runs in the pi docker swarm — reach it via the swarm-ops / shoemoney-swarm skill).
  - Public hostname / reverse proxy: add an NPM (Nginx Proxy Manager) proxy-host alias — use the nginx-proxy-manager-ops skill.

SKILLS — you have the full local skill set (add-key, nginx-proxy-manager-ops, swarm-ops, network-scan, etc.). Invoke a skill by DESCRIBING the task in natural language (e.g. "vault this openai key: sk-..."), not a raw /slash-command (this prompt has trailing instructions appended).'

echo "aigate-worker $WORKER → $AIGATE_URL" >&2
while :; do
  claim="$(curl -s -m10 -X POST "${AUTH[@]}" -H 'content-type: application/json' \
      -d "{\"worker\":\"$WORKER\",\"host\":\"$HOST\"}" "$AIGATE_URL/api/board/claim")"
  id="$(printf '%s' "$claim" | jget id)"
  [ -n "$id" ] || { sleep "$IDLE"; continue; }   # 204/empty = queue empty
  prompt="$(printf '%s' "$claim" | jget prompt)"
  cwd="$(printf '%s' "$claim" | jget cwd)"
  # expand a leading ~ / ~/… ourselves — it's a literal char inside a quoted var, the shell
  # never expands it, so `[ -d "~" ]` and `cd "~"` would both fail "directory not found"
  case "$cwd" in
    "~")   cwd="$HOME" ;;
    "~/"*) cwd="$HOME/${cwd#\~/}" ;;
  esac
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
  full_prompt="$BRIEF"$'\n\n=== YOUR TASK ===\n'"$prompt"$'\n\n'"[effort: ${effort:-medium}] $SUMMARY_RULE"
  post_activity "$id" "starting"
  # stream-json so we can report tool/thinking activity LIVE while it runs; capture to a file,
  # tail it in the background posting heartbeats, then parse the final result off the stream.
  tmpf="$(mktemp)"
  ( cd "${cwd:-$PWD}" && "$AI_CMD" "${PRE[@]}" -p --output-format stream-json --verbose "${resume[@]}" "${modelarg[@]}" "$full_prompt" ) >"$tmpf" 2>/dev/null &
  aipid=$!
  ( tail -n +1 -F "$tmpf" 2>/dev/null | while IFS= read -r line; do
      act="$(printf '%s' "$line" | activity_of)"; [ -n "$act" ] && post_activity "$id" "$act"
    done ) & tailpid=$!
  wait "$aipid"; rc=$?
  sleep 0.4; kill "$tailpid" 2>/dev/null; wait "$tailpid" 2>/dev/null
  out="$(cat "$tmpf")"; rm -f "$tmpf"
  parsed="$(printf '%s' "$out" | stream_final)"
  if [ "$rc" -eq 0 ] && [ -n "$parsed" ] && [ "$(printf '%s' "$parsed" | jget result)" != "" ]; then
    post_result "$id" true "$(printf '%s' "$parsed" | jget result)" "$(printf '%s' "$parsed" | jget session_id)" ""
  else
    post_result "$id" false "" "" "ai run failed (rc=$rc): $(printf '%.400s' "$out" | tr -d '\000')"
  fi
done
