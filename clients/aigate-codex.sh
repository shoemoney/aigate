#!/usr/bin/env bash
# aigate-codex — ask the warden for the Codex (ChatGPT) account with the most
# headroom, write its auth.json, then run the OFFICIAL `codex` binary. No proxy.
#
#   env:   AIGATE_URL, AIGATE_TOKEN (sourced from ~/.claude/aigate/env if unset)
#   opt:   AIGATE_CODEX_BIN, AIGATE_CODEX_HOME / CODEX_HOME, AI_GPT_MODEL
#          (default gpt-6.1-sol), AI_GPT_EFFORT (default high), AI_GPT_YOLO=0,
#          AI_CODEX_FORCE=1 (switch even while a codex is running)
#   usage: aigate-codex [codex args...]   Claude-Code-style flags are translated:
#            -p/--print → `codex exec`;  -c/--continue (bare) → `codex resume --last`;
#            -p with -c → `codex exec resume --last`;  `-c key=value` and --config are
#            CODEX's config flag and pass through untouched;  codex's profile flag
#            is only reachable as --profile (-p is Claude-style print here).
#          aigate-codex --write-only      select + pre-sync + write auth.json, exit 0
#          aigate-codex --adopt           POST the local auth.json to /api/codex/sync
#          aigate-codex --keep            KEEPER: bring auth.json in step with the vault
#                                         (never picks, never switches account); fail-open
#
# The keeper step also runs at the start of every invocation. STICKY: while a codex
# process for this CODEX_HOME is alive the on-disk account is never switched (the
# keeper just keeps it current) unless that account is exhausted/re-auth/disabled, or
# AI_CODEX_FORCE=1. OpenAI refresh tokens rotate with reuse detection: a long-lived
# codex spending a token the vault already rotated would log out every box.
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

# >>> aigate-codex-bin (byte-identical in aigate-codex.sh, t3-codex.sh, ai; test/codex-client.test.js enforces it)
# Which codex binary? AIGATE_CODEX_BIN wins. Else the HIGHEST `--version` among the usual
# installs, so a stale ~/.local/bin/codex never shadows a newer brew one. The decision is cached
# 1h in $AIGATE_DIR/codex-bin.cache keyed by candidate mtimes: launches don't pay N version calls.
# AIGATE_CODEX_CANDIDATES (colon list) replaces the built-in candidate list (tests).
_cv_gt(){ # dotted version $1 strictly greater than $2 ?
  local a="${1:-0}." b="${2:-0}." x y i=0
  while [ "$i" -lt 4 ]; do
    x="${a%%.*}"; y="${b%%.*}"; a="${a#*.}"; b="${b#*.}"; x="${x:-0}"; y="${y:-0}"
    [ "$x" -gt "$y" ] 2>/dev/null && return 0
    [ "$x" -lt "$y" ] 2>/dev/null && return 1
    i=$((i+1))
  done
  return 1
}
aigate_codex_bin(){
  local c d list cs=() cand=() key="" best="" bestv="" v t now cache ck="" ct="" cb=""
  if [ -n "${AIGATE_CODEX_BIN:-}" ]; then
    case "$AIGATE_CODEX_BIN" in
      */*) [ -x "$AIGATE_CODEX_BIN" ] && { printf '%s' "$AIGATE_CODEX_BIN"; return 0; };;
      *) c="$(command -v "$AIGATE_CODEX_BIN" 2>/dev/null)" && [ -n "$c" ] && { printf '%s' "$c"; return 0; };;
    esac
    return 1
  fi
  list="${AIGATE_CODEX_CANDIDATES:-$HOME/.local/bin/codex:/opt/homebrew/bin/codex:/usr/local/bin/codex}"
  IFS=: read -r -a cand <<< "$list"
  for c in ${cand[@]+"${cand[@]}"}; do
    [ -x "$c" ] || continue
    case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
    cs+=("$c")
  done
  if [ "${#cs[@]}" -eq 0 ]; then
    local IFS=:
    for d in $PATH; do
      c="$d/codex"; [ -x "$c" ] || continue
      case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
      printf '%s' "$c"; return 0
    done
    return 1
  fi
  [ "${#cs[@]}" -eq 1 ] && { printf '%s' "${cs[0]}"; return 0; }
  for c in ${cs[@]+"${cs[@]}"}; do
    t="$(stat -Lf %m "$c" 2>/dev/null || stat -L -c %Y "$c" 2>/dev/null)"
    key="$key$c:$t|"
  done
  cache="${AIGATE_DIR:-$HOME/.claude/aigate}/codex-bin.cache"
  now="$(date +%s)"
  if [ -f "$cache" ]; then
    { IFS= read -r ck; IFS= read -r ct; IFS= read -r cb; } < "$cache" 2>/dev/null
    if [ "$ck" = "$key" ] && [ -x "$cb" ] && [ "$ct" -le "$now" ] 2>/dev/null && [ $((now - ct)) -lt 3600 ] 2>/dev/null; then
      printf '%s' "$cb"; return 0
    fi
  fi
  for c in ${cs[@]+"${cs[@]}"}; do
    v="$("$c" --version 2>/dev/null | sed -n 's/.*codex-cli \([0-9][0-9]*\(\.[0-9][0-9]*\)*\).*/\1/p' | head -n 1)"
    v="${v:-0}"
    if [ -z "$best" ] || _cv_gt "$v" "$bestv"; then best="$c"; bestv="$v"; fi
  done
  mkdir -p "$(dirname "$cache")" 2>/dev/null \
    && printf '%s\n%s\n%s\n' "$key" "$now" "$best" > "$cache.$$" 2>/dev/null \
    && mv -f "$cache.$$" "$cache" 2>/dev/null
  printf '%s' "$best"
}
# <<< aigate-codex-bin
resolve_codex(){ aigate_codex_bin; }

write_only=0 adopt=0 keep=0 sub=() args=() yolo=1 is_print=0 is_cont=0 has_model=0
while [ $# -gt 0 ]; do
  case "$1" in
    --write-only) write_only=1;;
    --adopt) adopt=1;;
    --keep) keep=1;;
    -p|--print) is_print=1;;
    # -c key=value is CODEX's config flag → untouched; bare -c / --continue = continue
    -c) case "${2:-}" in *=*) args+=("$1" "$2"); shift;; *) is_cont=1;; esac;;
    --continue) is_cont=1;;
    -m|--model|--model=*) has_model=1; args+=("$1");;
    # caller took the wheel on approvals/sandbox → don't also force ours
    -s|--sandbox|-a|--ask-for-approval|--full-auto) yolo=0; args+=("$1");;
    --dangerously-skip-permissions) ;;
    *) args+=("$1");;
  esac
  shift
done
[ "$is_print" = 1 ] && sub=(exec)
[ "$is_cont" = 1 ] && { sub+=(resume); args=(--last ${args[@]+"${args[@]}"}); }
[ "${sub[0]:-}" = exec ] && args+=(--skip-git-repo-check)
[ "$yolo" = 1 ] && [ "${AI_GPT_YOLO:-1}" = 1 ] && args+=(--dangerously-bypass-approvals-and-sandbox)
mdl=()
[ "$has_model" = 0 ] && mdl=(-m "$MODEL" -c "model_reasoning_effort=$EFFORT")

TMPD="$(mktemp -d)"; chmod 700 "$TMPD"
AUTHF="$TMPD/auth.hdr"; RESPF="$TMPD/resp.json"; OUTF="$TMPD/out"; ERRF="$TMPD/err"
BODYF="$TMPD/body.json"; SYNCF="$TMPD/sync.json"; KEEPF="$TMPD/keep.json"; ACCTF="$TMPD/accts.json"
HTTPF="$TMPD/http"; STDINF=""
umask 077
[ -n "${AIGATE_TOKEN:-}" ] && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"
# codex reads CODEX_HOME, we write AUTH under the resolved one: keep them the same
export CODEX_HOME

cpid=""; bgp=""; got_term=0
reap(){
  [ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null
  [ -n "$bgp" ] && kill -TERM "$bgp" 2>/dev/null
  rm -rf "$TMPD"
}
trap reap EXIT
# Before codex exists a TERM/INT must END us (143/130) — never fall through to launching
# a yolo codex. After launch: forward TERM and let codex exit first so the post-sync
# still runs; INT is left to codex (it shares the tty's process group).
trap 'got_term=1; if [ -n "$cpid" ]; then kill -TERM "$cpid" 2>/dev/null; else exit 143; fi' TERM
trap '[ -n "$cpid" ] || exit 130' INT

# Run a command in the background and `wait`: unlike a foreground child, `wait` is
# interrupted by a trapped signal at once, so Ctrl-C/TERM never sits out a 15s curl.
bgwait(){ "$@" <&0 & bgp=$!; wait "$bgp"; local rc=$?; bgp=""; return $rc; }
# a curl killed by a signal (rc>=128) is the user interrupting, NOT "aigate unreachable"
die_if_signaled(){ [ "$1" -ge 128 ] && exit "$1"; return 0; }

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
  local u="$AIGATE_URL/api/select?kind=codex&host=$HOST&exclude=$1" rc
  bgwait curl -s -m15 -H "@$AUTHF" "$u" > "$RESPF" 2>/dev/null; rc=$?
  die_if_signaled "$rc"
  if [ "$rc" -ne 0 ]; then
    sleep 2
    bgwait curl -s -m15 -H "@$AUTHF" "$u" > "$RESPF" 2>/dev/null; rc=$?
    die_if_signaled "$rc"
    [ "$rc" -eq 0 ] || : > "$RESPF"
  fi
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
  local rc
  bgwait curl -s -m15 -X POST -H "@$AUTHF" -H 'content-type: application/json' --data "@$2" \
    "$AIGATE_URL$1" > "$SYNCF" 2>/dev/null; rc=$?
  [ "$rc" -eq 0 ] || : > "$SYNCF"
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

# ── keeper ───────────────────────────────────────────────────────────────────
# Keep $AUTH in step with the vault for the account it is ALREADY logged in as.
# Never picks, never switches account. Fail-open: any aigate trouble → return 0.
# Sets KEEP_STATE (skip|down|error|unknown|reauth|ok|changed) and KEEP_NAME.
KEEP_STATE=skip KEEP_NAME="" KEEP_NOISY=0
keep_say(){ echo "aigate-keeper: $*" >&2; }
iso_cmp(){ # $1 vault last_refresh  $2 local last_refresh → newer|older|same|unknown (vault vs local)
  python3 - "$1" "$2" <<'PY' 2>/dev/null || echo unknown
import sys, re
from datetime import datetime, timezone
def p(s):
    if not s: return None
    s = s.strip().replace("Z", "+00:00")
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        d = datetime.fromisoformat(s)
    except Exception:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
a, b = p(sys.argv[1]), p(sys.argv[2])
print("unknown" if a is None or b is None else "newer" if a > b else "older" if a < b else "same")
PY
}
keep(){
  KEEP_STATE=skip; KEEP_NAME=""
  [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ] || return 0
  [ -f "$AUTH" ] || return 0
  local id idq http lrt vrt vid cmp vrf lrf
  id="$(jp "$AUTH" tokens.account_id)"; [ -n "$id" ] || return 0
  idq="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$id" 2>/dev/null)"
  [ -n "$idq" ] || return 0
  : > "$KEEPF"; : > "$HTTPF"
  bgwait curl -s -m15 -H "@$AUTHF" -o "$KEEPF" -w '%{http_code}' \
    "$AIGATE_URL/api/codex/auth?account_id=$idq&host=$HOST" > "$HTTPF" 2>/dev/null
  die_if_signaled $?
  http="$(cat "$HTTPF" 2>/dev/null)"
  case "$http" in
    200) ;;
    404) KEEP_STATE=unknown; return 0;;
    ""|000) KEEP_STATE=down; [ "$KEEP_NOISY" = 1 ] && keep_say "cannot reach the server"; return 0;;
    401) KEEP_STATE=error; [ "$KEEP_NOISY" = 1 ] && keep_say "AIGATE_TOKEN rejected (401)"; return 0;;
    *) KEEP_STATE=error; [ "$KEEP_NOISY" = 1 ] && keep_say "server answered HTTP $http"; return 0;;
  esac
  KEEP_NAME="$(jp "$KEEPF" account)"
  KEEP_STATE=ok
  local flagged=0
  case "$(jp "$KEEPF" reauth_needed)" in 1|True|true) flagged=1;; esac
  case "$(jp "$KEEPF" refresh_unknown)" in 1|True|true) flagged=1;; esac
  vid="$(jp "$KEEPF" auth_json.tokens.account_id)"
  vrt="$(jp "$KEEPF" auth_json.tokens.refresh_token)"
  lrt="$(jp "$AUTH" tokens.refresh_token)"
  vrf="$(jp "$KEEPF" last_refresh)"; [ -n "$vrf" ] || vrf="$(jp "$KEEPF" auth_json.last_refresh)"
  lrf="$(jp "$AUTH" last_refresh)"
  cmp="$(iso_cmp "$vrf" "$lrf")"
  if [ "$flagged" = 1 ]; then
    # The vault's token is dead (re-auth / unknown refresh outcome). NEVER write it to disk. But
    # if THIS box holds the same account with a different, NEWER login (a re-login here), push it:
    # that is exactly how a re-login repairs the vault. Report re-auth only if the server declined.
    KEEP_STATE=reauth
    if [ -z "$vid" ] || [ "$vid" = "$id" ]; then
      if [ -n "$lrt" ] && [ "$vrt" != "$lrt" ] && [ "$cmp" = older ] && sync_file "$AUTH" \
         && [ "$(jp "$SYNCF" applied)" = "True" ]; then
        KEEP_STATE=changed
        keep_say "re-login on this box repaired the vault (${KEEP_NAME:-$id})"
        return 0
      fi
    fi
    [ "$KEEP_NOISY" = 1 ] && keep_say "account ${KEEP_NAME:-$id} needs re-auth (log in again with codex, then: ai codex adopt)"
    return 0
  fi
  [ -z "$vid" ] || [ "$vid" = "$id" ] || return 0        # never cross to a different account
  [ -n "$vrt" ] || return 0
  [ "$vrt" != "$lrt" ] || return 0
  case "$cmp" in
    newer)
      write_auth "$KEEPF" && { WROTE_RT="$vrt"; KEEP_STATE=changed
        keep_say "auth.json updated from the vault (${KEEP_NAME:-$id}, newer token)"; }
      ;;
    older)
      if sync_file "$AUTH"; then KEEP_STATE=changed
        keep_say "pushed the newer local token to the vault (${KEEP_NAME:-$id}: $(jp "$SYNCF" reason))"; fi
      ;;
  esac
  return 0
}

# Is a codex process for THIS $CODEX_HOME alive (excluding our own pid tree)?
codex_live(){
  python3 - "$CODEX_HOME" "$$" "$HOME" <<'PY' 2>/dev/null
import os, re, subprocess, sys
ch = os.path.realpath(sys.argv[1]); me = int(sys.argv[2]); home = sys.argv[3]
out = subprocess.run(["ps", "-axo", "pid=,ppid=,command="], capture_output=True, text=True).stdout
rows = {}
for l in out.splitlines():
    f = l.split(None, 2)
    if len(f) < 3: continue
    try: rows[int(f[0])] = (int(f[1]), f[2])
    except ValueError: pass
mine = {me}; grew = True
while grew:
    grew = False
    for pid, (pp, _) in rows.items():
        if pp in mine and pid not in mine: mine.add(pid); grew = True
def is_codex(cmd):
    t = cmd.split()
    if not t: return False
    b = os.path.basename(t[0])
    if b == "codex": return True
    return b in ("node", "bun") and len(t) > 1 and os.path.basename(t[1]) in ("codex", "codex.js")
for pid, (_, cmd) in rows.items():
    if pid in mine or not is_codex(cmd): continue
    env = subprocess.run(["ps", "eww", "-o", "command=", "-p", str(pid)], capture_output=True, text=True).stdout
    if not env.strip(): continue
    m = re.search(r"(?:^|\s)CODEX_HOME=(\S+)", env)
    eff = m.group(1) if m else os.path.join(home, ".codex")
    if os.path.realpath(eff) == ch: sys.exit(0)
sys.exit(1)
PY
}

# Is the account the vault knows as $1 unusable right now (parked/re-auth/disabled/over cutoff)?
account_exhausted(){
  [ -n "$1" ] || return 1
  : > "$ACCTF"
  bgwait curl -s -m15 -H "@$AUTHF" "$AIGATE_URL/api/accounts" > "$ACCTF" 2>/dev/null
  die_if_signaled $?
  python3 - "$ACCTF" "$1" "${AIGATE_HEADROOM_CUTOFF:-95}" <<'PY' 2>/dev/null
import sys, json
try: rows = json.load(open(sys.argv[1]))
except Exception: sys.exit(1)
cut = float(sys.argv[3])
for r in rows if isinstance(rows, list) else []:
    if r.get("account") != sys.argv[2]: continue
    pct = max(float(r.get("five_hour_pct") or 0), float(r.get("seven_day_pct") or 0))
    bad = r.get("parked") or r.get("reauth_needed") or r.get("disabled") or pct >= cut
    sys.exit(0 if bad else 1)
sys.exit(1)
PY
}

# STICKY: a codex for this CODEX_HOME is alive → do NOT switch the on-disk account; the
# keeper already refreshed it. Switch (and say so) only if that account is unusable.
# Returns 0 = reuse the on-disk account (name in KEEP_NAME), 1 = go select/switch.
sticky_reuse(){
  [ "${AI_CODEX_FORCE:-0}" = 1 ] && return 1
  [ -f "$AUTH" ] || return 1
  [ -n "$(jp "$AUTH" tokens.account_id)" ] || return 1
  codex_live || return 1
  case "$KEEP_STATE" in
    unknown) return 1;;                                  # not an aigate-managed login
    reauth) echo "aigate: on-disk codex account ${KEEP_NAME:-?} needs re-auth while another codex is running — switching its login on disk" >&2; return 1;;
  esac
  case "$(jp "$KEEPF" disabled)" in 1|True|true)
    echo "aigate: on-disk codex account ${KEEP_NAME:-?} is disabled while another codex is running — switching its login on disk" >&2; return 1;;
  esac
  if [ "$KEEP_STATE" != down ] && [ "$KEEP_STATE" != error ] && account_exhausted "$KEEP_NAME"; then
    echo "aigate: on-disk codex account ${KEEP_NAME:-?} is exhausted while another codex is running — switching its login on disk" >&2
    return 1
  fi
  WROTE_RT="$(jp "$AUTH" tokens.refresh_token)"
  echo "aigate → codex account: ${KEEP_NAME:-on-disk login} (kept: another codex is running; AI_CODEX_FORCE=1 to switch)" >&2
  return 0
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
  codex_live \
    && echo "aigate: another codex is running — switching its account on disk (AI_CODEX_FORCE=1 silences)" >&2
  return 0
}

write_auth(){ # $1 = response file holding {auth_json} (default RESPF). atomic: temp in the same dir, 0600 BEFORE content, rename
  mkdir -p "$CODEX_HOME"
  python3 - "${1:-$RESPF}" "$AUTH" <<'PY'
import sys, json, os, tempfile
d = json.load(open(sys.argv[1]))["auth_json"]
dest = sys.argv[2]
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(dest), prefix=".auth.json.")
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(d, f, indent=2); f.write("\n")
    os.replace(tmp, dest)
except Exception:
    try: os.unlink(tmp)
    except OSError: pass
    raise
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
  [ -n "$STDINF" ] && exec <"$STDINF"     # replay the buffered prompt; the open fd outlives the rm
  rm -rf "$TMPD"; trap - EXIT
  exec "$C" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"}
}

# ── mode: keeper (launchd) ───────────────────────────────────────────────────
if [ "$keep" = 1 ]; then
  KEEP_NOISY=1
  if [ -z "${AIGATE_URL:-}" ] || [ -z "${AIGATE_TOKEN:-}" ]; then keep_say "no aigate env — nothing to do"; exit 0; fi
  keep
  # launchd/systemd fire at boot and on wake BEFORE the network is up: an UNREACHABLE aigate
  # (connect refused / timeout / DNS → KEEP_STATE=down) is retried with backoff (~4 min total).
  # 401/404/503 are answers, not outages: never retried. Gives up fail-open (exit 0).
  for _w in ${AIGATE_KEEP_BACKOFF:-5 10 20 40 60 60}; do
    [ "$KEEP_STATE" = down ] || break
    bgwait sleep "$_w"
    KEEP_NOISY=0; keep
  done
  [ "$KEEP_STATE" = down ] && keep_say "aigate still unreachable after retries — giving up until the next tick"
  exit 0
fi

CODEX="$(resolve_codex)" || { [ "$write_only" = 1 ] || [ "$adopt" = 1 ] || { echo "aigate-codex: no codex binary found (set AIGATE_CODEX_BIN)" >&2; exit 127; }; CODEX=""; }

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

# keeper step first, every invocation: never spend a token the vault already rotated
keep

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
  # machine-readable result for ai-desktop: the account whose login is NOW in auth.json
  if sticky_reuse; then echo "aigate-account: ${KEEP_NAME:-}"; exit 0; fi
  pick "" || { diag; exit 1; }
  install_pick || exit 1
  echo "aigate-account: $(jp "$RESPF" account)"
  exit 0
fi

if [ "$is_print" != 1 ]; then
  if ! sticky_reuse; then
    pick "" || { diag; plain_codex "no codex account from aigate"; }
    install_pick || plain_codex "could not install the picked account"
  fi
  "$CODEX" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"} <&0 & cpid=$!
  rc=0
  while kill -0 "$cpid" 2>/dev/null; do wait "$cpid"; rc=$?; done
  cpid=""
  post_sync
  [ "$got_term" = 1 ] && exit 143
  exit "$rc"
fi

# print mode: buffer a piped prompt ONCE so every retry attempt replays it
if [ ! -t 0 ]; then
  STDINF="$TMPD/stdin"
  # NB: -p with a never-closing stdin pipe waits for EOF here AND in the raw claude/codex
  # binaries (measured: raw `claude -p` sat the full 12s on an open pipe). Not a wrapper bug.
  bgwait cat > "$STDINF" 2>/dev/null
fi
run_print(){
  if [ -n "$STDINF" ]; then
    "$CODEX" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"} <"$STDINF" >"$OUTF" 2>"$ERRF" & cpid=$!
  else
    # <&0 because a bg job's stdin is /dev/null otherwise
    "$CODEX" ${sub[@]+"${sub[@]}"} ${mdl[@]+"${mdl[@]}"} ${args[@]+"${args[@]}"} <&0 >"$OUTF" 2>"$ERRF" & cpid=$!
  fi
}

tried=""
for attempt in 1 2 3; do
  acct=""
  if [ "$attempt" = 1 ] && sticky_reuse; then
    acct="$KEEP_NAME"
  else
    pick "$tried" || { diag; [ -z "$tried" ] && plain_codex "no codex account from aigate"; exit 1; }
    acct="$(jp "$RESPF" account)"
    install_pick || plain_codex "could not install the picked account"
  fi
  run_print
  rc=0
  while kill -0 "$cpid" 2>/dev/null; do wait "$cpid"; rc=$?; done
  cpid=""
  post_sync
  [ "$got_term" = 1 ] && exit 143
  if [ "$rc" -eq 0 ]; then cat "$OUTF"; cat "$ERRF" >&2; exit 0; fi
  if cat "$OUTF" "$ERRF" | grep -qiE 'usage limit|rate limit|429|quota|limit reached'; then
    echo "aigate: codex account ${acct:-?} over limit/unavailable → retrying next" >&2
    [ -n "$acct" ] && { report_limit "$acct"; tried="${tried:+$tried,}$acct"; }
    [ -n "$acct" ] || { cat "$OUTF"; cat "$ERRF" >&2; exit "$rc"; }
    continue
  fi
  cat "$OUTF"; cat "$ERRF" >&2; exit "$rc"
done
echo "aigate: all codex accounts exhausted (tried: $tried)" >&2
exit 1
