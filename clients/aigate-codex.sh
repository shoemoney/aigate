#!/usr/bin/env bash
# aigate-codex — ask the warden for the Codex (ChatGPT) account with the most
# headroom, write its auth.json, then run the OFFICIAL `codex` binary. No proxy.
#
#   env:   AIGATE_URL, AIGATE_TOKEN (sourced from ~/.claude/aigate/env if unset)
#   opt:   AIGATE_CODEX_BIN, AIGATE_CODEX_HOME / CODEX_HOME, AI_GPT_MODEL
#          (default gpt-6.1-sol), AI_GPT_EFFORT (default high), AI_GPT_YOLO=0,
#          AI_CODEX_FORCE=1 (silence the "another codex is running" warning)
#   usage: aigate-codex [codex args...]   Claude-Code-style flags are translated
#          aigate-codex --write-only      select + pre-sync + write auth.json, exit 0
#          aigate-codex --adopt           POST the local auth.json to /api/codex/sync
#
# Print mode (-p/--print → `codex exec`) keeps stdout CLEAN, detects a usage limit,
# parks the account and retries on the next one (max 3). Interactive is a single
# pick. Either way a token codex rotated locally is synced BACK to aigate on exit.
# aigate down / 401 / no account → say why on stderr and run plain codex.
set -uo pipefail

AIGATE_DIR="${AIGATE_DIR:-$HOME/.claude/aigate}"
if [ -z "${AIGATE_URL:-}" ] || [ -z "${AIGATE_TOKEN:-}" ]; then
  [ -f "$AIGATE_DIR/env" ] && { set -a; . "$AIGATE_DIR/env"; set +a; }
fi
HOST="$(hostname -s)"
CODEX_HOME="${AIGATE_CODEX_HOME:-${CODEX_HOME:-$HOME/.codex}}"
AUTH="$CODEX_HOME/auth.json"
MODEL="${AI_GPT_MODEL:-gpt-6.1-sol}"
EFFORT="${AI_GPT_EFFORT:-high}"

resolve_codex(){
  local c
  if [ -n "${AIGATE_CODEX_BIN:-}" ]; then
    case "$AIGATE_CODEX_BIN" in
      */*) [ -x "$AIGATE_CODEX_BIN" ] && { printf '%s' "$AIGATE_CODEX_BIN"; return 0; };;
      *) c="$(command -v "$AIGATE_CODEX_BIN" 2>/dev/null)" && [ -n "$c" ] && { printf '%s' "$c"; return 0; };;
    esac
    return 1
  fi
  for c in "$HOME/.local/bin/codex" /opt/homebrew/bin/codex /usr/local/bin/codex; do
    [ -x "$c" ] || continue
    case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
    printf '%s' "$c"; return 0
  done
  local IFS=:
  for d in $PATH; do
    c="$d/codex"
    [ -x "$c" ] || continue
    case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
    printf '%s' "$c"; return 0
  done
  return 1
}

write_only=0 adopt=0 sub=() args=() yolo=1 is_print=0 has_model=0
while [ $# -gt 0 ]; do
  case "$1" in
    --write-only) write_only=1;;
    --adopt) adopt=1;;
    -p|--print) sub=(exec); is_print=1;;
    -m|--model|--model=*) has_model=1; args+=("$1");;
    # caller took the wheel on approvals/sandbox → don't also force ours
    -s|--sandbox|-a|--ask-for-approval|--full-auto) yolo=0; args+=("$1");;
    --dangerously-skip-permissions) ;;
    --continue|-c) sub=(resume); args+=(--last);;
    *) args+=("$1");;
  esac
  shift
done
[ "${sub[0]:-}" = exec ] && args+=(--skip-git-repo-check)
[ "$yolo" = 1 ] && [ "${AI_GPT_YOLO:-1}" = 1 ] && args+=(--dangerously-bypass-approvals-and-sandbox)
mdl=()
[ "$has_model" = 0 ] && mdl=(-m "$MODEL" -c "model_reasoning_effort=$EFFORT")

TMPD="$(mktemp -d)"; chmod 700 "$TMPD"
AUTHF="$TMPD/auth.hdr"; RESPF="$TMPD/resp.json"; OUTF="$TMPD/out"; ERRF="$TMPD/err"
BODYF="$TMPD/body.json"; SYNCF="$TMPD/sync.json"
umask 077
[ -n "${AIGATE_TOKEN:-}" ] && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"
cpid=""
reap(){ [ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null; rm -rf "$TMPD"; }
trap reap EXIT
# forward, don't die: codex must exit first so the post-sync still runs
trap '[ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null; got_term=1' TERM
trap ':' INT
got_term=0

jp(){ python3 -c 'import sys,json
try:
    d=json.load(open(sys.argv[1]))
    for k in sys.argv[2].split("."):
        d=d.get(k) if isinstance(d,dict) else None
    print("" if d is None else d)
except Exception:
    print("")' "$1" "$2" 2>/dev/null; }

# one manual retry on a transport failure (timeout / refused). NOT curl --retry: that also
# retries a 503 and APPENDS the second body, leaving two JSON documents glued together.
select_codex(){ # $1 = exclude csv → response body in RESPF
  local u="$AIGATE_URL/api/select?kind=codex&host=$HOST&exclude=$1"
  curl -s -m15 -H "@$AUTHF" "$u" > "$RESPF" 2>/dev/null \
    || { sleep 2; curl -s -m15 -H "@$AUTHF" "$u" > "$RESPF" 2>/dev/null || : > "$RESPF"; }
}
resp_ok(){ [ -n "$(jp "$RESPF" auth_json.tokens.refresh_token)" ] || [ -n "$(jp "$RESPF" auth_json.OPENAI_API_KEY)" ]; }
diag(){
  local raw; raw="$(cat "$RESPF" 2>/dev/null)"
  case "$raw" in
    "") echo "aigate: cannot reach the server (down / wrong AIGATE_URL / network)" >&2;;
    *unauthorized*) echo "aigate: AIGATE_TOKEN rejected (401) — wrong or rotated token; re-source ~/.claude/aigate/env" >&2;;
    *) python3 -c 'import sys,json
raw=open(sys.argv[1]).read()
try:d=json.loads(raw)
except Exception:d={}
print("aigate: no codex account available — {} accts ({} parked, {} re-auth, {} off)".format(d.get("accounts",0),d.get("parked",0),d.get("reauth",0),d.get("disabled",0)) if "accounts" in d else "aigate: "+str(d.get("error") or raw[:200] or "unknown error"))' "$RESPF" >&2;;
  esac
}
post_json(){ # $1 path  $2 body file  → response in SYNCF
  curl -s -m15 -X POST -H "@$AUTHF" -H 'content-type: application/json' --data "@$2" \
    "$AIGATE_URL$1" > "$SYNCF" 2>/dev/null || : > "$SYNCF"
}
sync_file(){ # POST {auth_json: <file>} to /api/codex/sync
  python3 -c 'import sys,json
print(json.dumps({"auth_json":json.load(open(sys.argv[1]))}))' "$1" > "$BODYF" 2>/dev/null || return 1
  post_json /api/codex/sync "$BODYF"
}
report_limit(){
  python3 -c 'import sys,json;print(json.dumps({"account":sys.argv[1],"host":sys.argv[2]}))' "$1" "$HOST" > "$BODYF"
  post_json /api/events/limit "$BODYF"
}

# A token codex rotated locally (refresh tokens are single-use) must reach the vault
# BEFORE we overwrite it with the picked account's older copy.
presync(){
  [ -f "$AUTH" ] || return 1
  local lrt lacct prt
  lrt="$(jp "$AUTH" tokens.refresh_token)"; lacct="$(jp "$AUTH" tokens.account_id)"
  prt="$(jp "$RESPF" auth_json.tokens.refresh_token)"
  [ -n "$lrt" ] && [ -n "$lacct" ] && [ "$lrt" != "$prt" ] || return 1
  sync_file "$AUTH" || return 1
  [ "$(jp "$SYNCF" applied)" = "True" ]
}

backup_once(){
  [ -f "$AUTH" ] || return 0
  local f
  for f in "$CODEX_HOME"/auth.json.bak-pre-aigate-*; do [ -e "$f" ] && return 0; done
  cp "$AUTH" "$CODEX_HOME/auth.json.bak-pre-aigate-$(date +%Y%m%d-%H%M%S)" 2>/dev/null \
    && chmod 600 "$CODEX_HOME"/auth.json.bak-pre-aigate-* 2>/dev/null
  return 0
}

warn_concurrent(){
  [ "${AI_CODEX_FORCE:-0}" = 1 ] && return 0
  [ -f "$AUTH" ] || return 0
  local lacct nacct; lacct="$(jp "$AUTH" tokens.account_id)"; nacct="$(jp "$RESPF" auth_json.tokens.account_id)"
  [ -n "$lacct" ] && [ -n "$nacct" ] && [ "$lacct" != "$nacct" ] || return 0
  pgrep -x codex >/dev/null 2>&1 \
    && echo "aigate: another codex is running — switching its account on disk (AI_CODEX_FORCE=1 silences)" >&2
  return 0
}

write_auth(){ # atomic: temp in the same dir, mode 600, rename
  mkdir -p "$CODEX_HOME"
  python3 - "$RESPF" "$AUTH" <<'PY'
import sys, json, os, tempfile
d = json.load(open(sys.argv[1]))["auth_json"]
dest = sys.argv[2]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".auth.json.")
with os.fdopen(fd, "w") as f:
    json.dump(d, f, indent=2); f.write("\n")
os.chmod(tmp, 0o600)
os.replace(tmp, dest)
PY
}

banner(){
  python3 - "$RESPF" >&2 <<'PY'
import sys, json, time
d = json.load(open(sys.argv[1]))
def left(ts):
    try: s = int(ts) - int(time.time())
    except Exception: return ""
    if s <= 0: return "now"
    dd, r = divmod(s, 86400); h, r = divmod(r, 3600); m = r // 60
    return (f"{dd}d{h}h" if dd else f"{h}h{m}m" if h else f"{m}m")
parts = []
if d.get("plan"): parts.append(str(d["plan"]))
if isinstance(d.get("five_hour_pct"), (int, float)) and d.get("five_hour_reset"):
    parts.append("5h %d%%" % round(d["five_hour_pct"]))
if isinstance(d.get("seven_day_pct"), (int, float)): parts.append("7d %d%%" % round(d["seven_day_pct"]))
r = left(d.get("seven_day_reset"))
if r: parts.append("resets in " + r)
print("aigate → codex account: %s%s" % (d.get("account", "?"), " (" + " · ".join(parts) + ")" if parts else ""))
PY
}

# sync a locally-rotated token back to aigate (no-op if auth.json is untouched)
post_sync(){
  [ -f "$AUTH" ] || return 0
  local now; now="$(jp "$AUTH" tokens.refresh_token)"
  [ -n "$now" ] && [ "$now" != "${WROTE_RT:-}" ] || return 0
  sync_file "$AUTH" && echo "aigate: synced rotated codex token back ($(jp "$SYNCF" reason))" >&2
  return 0
}

plain_codex(){ # no aigate route → plain codex on whatever auth.json exists
  local why="$1"; echo "aigate: $why → running plain codex on the existing login" >&2
  [ "$write_only" = 1 ] && exit 1
  local C; C="$(resolve_codex)" || { echo "aigate-codex: no codex binary found" >&2; exit 127; }
  rm -rf "$TMPD"; trap - EXIT
  exec "$C" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"}
}

CODEX="$(resolve_codex)" || { [ "$write_only" = 1 ] || { echo "aigate-codex: no codex binary found (set AIGATE_CODEX_BIN)" >&2; exit 127; }; CODEX=""; }

if [ -z "${AIGATE_URL:-}" ] || [ -z "${AIGATE_TOKEN:-}" ]; then
  [ "$adopt" = 1 ] && { echo "aigate: AIGATE_URL/AIGATE_TOKEN not set" >&2; exit 1; }
  plain_codex "no aigate env"
fi

if [ "$adopt" = 1 ]; then
  [ -f "$AUTH" ] || { echo "aigate: no $AUTH to adopt" >&2; exit 1; }
  sync_file "$AUTH" || { echo "aigate: $AUTH is not valid JSON" >&2; exit 1; }
  r="$(cat "$SYNCF")"; echo "aigate: codex adopt → ${r:-no response}"
  [ "$(jp "$SYNCF" ok)" = "True" ]; exit $?
fi

# pick (+ at most one re-pick after a pre-sync that changed the vault)
pick(){ # $1 exclude
  select_codex "$1"
  resp_ok || return 1
  if presync; then select_codex "$1"; resp_ok || return 1; fi
  return 0
}
install_pick(){
  warn_concurrent
  backup_once
  write_auth || { echo "aigate: could not write $AUTH" >&2; return 1; }
  WROTE_RT="$(jp "$AUTH" tokens.refresh_token)"
  banner
}

if [ "$write_only" = 1 ]; then
  pick "" || { diag; exit 1; }
  install_pick || exit 1
  exit 0
fi

if [ "$is_print" != 1 ]; then
  pick "" || { diag; plain_codex "no codex account from aigate"; }
  install_pick || plain_codex "could not install the picked account"
  "$CODEX" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"} <&0 & cpid=$!
  rc=0
  while kill -0 "$cpid" 2>/dev/null; do wait "$cpid"; rc=$?; done
  cpid=""
  post_sync
  [ "$got_term" = 1 ] && exit 143
  exit "$rc"
fi

tried=""
for attempt in 1 2 3; do
  pick "$tried" || { diag; [ -z "$tried" ] && plain_codex "no codex account from aigate"; exit 1; }
  acct="$(jp "$RESPF" account)"
  install_pick || plain_codex "could not install the picked account"
  # split streams: stdout stays CLEAN; <&0 because a bg job's stdin is /dev/null otherwise
  "$CODEX" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"} <&0 >"$OUTF" 2>"$ERRF" & cpid=$!
  rc=0
  while kill -0 "$cpid" 2>/dev/null; do wait "$cpid"; rc=$?; done
  cpid=""
  post_sync
  [ "$got_term" = 1 ] && exit 143
  if [ "$rc" -eq 0 ]; then cat "$OUTF"; cat "$ERRF" >&2; exit 0; fi
  if cat "$OUTF" "$ERRF" | grep -qiE 'usage limit|rate limit|429|quota|limit reached'; then
    echo "aigate: codex account $acct over limit/unavailable → retrying next" >&2
    report_limit "$acct"; tried="${tried:+$tried,}$acct"; continue
  fi
  cat "$OUTF"; cat "$ERRF" >&2; exit "$rc"
done
echo "aigate: all codex accounts exhausted (tried: $tried)" >&2
exit 1
