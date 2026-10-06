#!/usr/bin/env bash
# aigate-run — ask the warden for the account with the most headroom, then run
# the OFFICIAL `claude` binary with that account's token. No proxy, no relay.
#
#   env: AIGATE_URL (e.g. https://aigate.example.com), AIGATE_TOKEN
#   usage: aigate-run [claude args...]
#
# In print mode (-p/--print) it DETECTS an over-limit / unavailable account from
# claude's output, reports it to aigate, and RETRIES with the next-best account
# (up to 3). Interactive sessions get a single pick + exec passthrough.
set -uo pipefail
: "${AIGATE_URL:?not set — run: set -a; . ~/.claude/aigate/env; set +a  (or add it to your shell rc)}"
: "${AIGATE_TOKEN:?not set — run: set -a; . ~/.claude/aigate/env; set +a  (or add it to your shell rc)}"
HOST="$(hostname -s)"
CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-claude}"

# auth header lives in a mode-600 file, not argv — argv is visible to any local user via `ps`
AUTHF="$(mktemp)"; chmod 600 "$AUTHF"; printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"
# A caller's timeout kills THIS wrapper; it must take claude with it. Capturing via
# out="$(claude ...)" orphaned the child: a claude -p hung on dead sockets outlived
# its caller's 180s cap by 20 min (2026-09-29). Print mode runs it in the background
# and `wait`s (interruptible) so TERM/INT are forwarded. See aigate-run-supervise.test.sh
cpid=""
reap(){ [ -n "$cpid" ] && kill -TERM "$cpid" 2>/dev/null; rm -f "$AUTHF" "${errf:-}" "${outf:-}"; }
trap reap EXIT
trap 'reap; exit 143' TERM
trap 'reap; exit 130' INT

jget(){ python3 -c 'import sys,json;print(json.load(sys.stdin).get("'"$1"'",""))' 2>/dev/null; }
# -m15 + one retry on a transport failure: -m8 lost to aigate under a NAS IO stall
# (2026-10-05). Manual, not curl --retry — that retries a 503 too and APPENDS the second
# body, so a genuine "no headroom" reply became two glued JSON docs and skipped the Kimi fallback.
select_acct(){
  local u="$AIGATE_URL/api/select?host=$HOST&exclude=$1" o
  o="$(curl -s -m15 -H "@$AUTHF" "$u")" || { sleep 2; o="$(curl -s -m15 -H "@$AUTHF" "$u")"; }
  printf '%s' "$o"
}
# "(5h 7% · 7d 16%)" from a select response; empty when it carries no usage
usage_tag(){ printf '%s' "$1" | python3 -c 'import sys,json
try:d=json.load(sys.stdin)
except Exception:sys.exit(0)
p=[]
for k,l in (("five_hour_pct","5h"),("seven_day_pct","7d")):
    v=d.get(k)
    if isinstance(v,(int,float)):p.append("%s %d%%"%(l,round(v)))
print(" ("+" · ".join(p)+")" if p else "")' 2>/dev/null; }
report_prompt(){ curl -s -m5 -X POST -H "@$AUTHF" -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"account":sys.argv[1],"host":sys.argv[2],"prompt":sys.argv[3][:400]}))' "$1" "$HOST" "$2")" \
    "$AIGATE_URL/api/events/prompt" >/dev/null 2>&1 || true; }
report_limit(){ curl -s -m5 -X POST -H "@$AUTHF" -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys
d={"account":sys.argv[1],"host":sys.argv[2]}
if len(sys.argv)>3 and sys.argv[3]!="":d["minutes"]=int(sys.argv[3])
print(json.dumps(d))' "$1" "$HOST" "${2:-}")" \
    "$AIGATE_URL/api/events/limit" >/dev/null 2>&1 || true; }
# A select response with NO setup_token is NOT always "capacity": empty body = server
# unreachable, 'unauthorized' = rejected token, only a reasoned 503 is real no-headroom.
no_token_diag(){
  case "$1" in
    "") echo "aigate: cannot reach the server (down / wrong AIGATE_URL / network)" >&2;;
    *unauthorized*) echo "aigate: AIGATE_TOKEN rejected (401) — wrong or rotated token; re-source ~/.claude/aigate/env" >&2;;
    *) printf '%s' "$1" | python3 -c 'import sys,json
raw=sys.stdin.read()
try:d=json.loads(raw)
except Exception:d={}
print("aigate: no account available — {} accts ({} parked, {} re-auth, {} off)".format(d.get("accounts",0),d.get("parked",0),d.get("reauth",0),d.get("disabled",0)) if "accounts" in d else "aigate: "+str(d.get("error") or raw or "unknown error"))' >&2;;
  esac
}

# True only for a genuine "no headroom" response from the server (valid JSON with
# an "accounts" field) — NOT for an unreachable server or a rejected token, so a
# broken config fails loud instead of silently rerouting to Kimi.
is_capacity_exhausted(){
  case "$1" in "") return 1;; *unauthorized*) return 1;; esac
  printf '%s' "$1" | python3 -c 'import sys,json
try: d=json.loads(sys.stdin.read())
except Exception: sys.exit(1)
sys.exit(0 if "accounts" in d else 1)' 2>/dev/null
}
# Every Claude account is out of headroom → hand the SAME args to the official
# binary against Kimi K3 (1M ctx) instead. Still no proxy: aigate-kimi.sh points
# the real `claude` binary at Kimi's own Anthropic-compatible endpoint with your
# own kimi.com key.
# Last rung below Kimi: Meta's `muse --yolo`. Not the claude binary and not
# Anthropic-compatible — a DIFFERENT agent with its own OAuth (auth.meta.com), so
# claude's flags can't ride along. We keep only the prompt: headless becomes
# `muse exec --yolo <prompt>`, interactive becomes a bare `muse --yolo` TUI.
fallback_to_muse(){
  local reason="$1"; shift
  local M; M="$(command -v muse || echo "$HOME/.local/bin/muse")"
  [ -x "$M" ] || { echo "aigate: $reason, and no Kimi key, and no muse — no route left. Vault one: /add-key kimi <sk-kimi-…>" >&2; exit 1; }
  local prompt="" want=0
  for a in "$@"; do
    if [ "$want" = 1 ]; then prompt="$a"; want=0; continue; fi
    case "$a" in
      -p|--print) want=1;;
      -*) ;;                                   # every other claude flag is meaningless to muse
      *) [ -z "$prompt" ] && prompt="$a";;
    esac
  done
  local mdl="${MUSE_MODEL:-muse-spark-1.2-contributor}"   # ~/.config/muse/settings.json is per-box; pin it
  echo "aigate: $reason → falling back to muse --yolo ($mdl)" >&2
  rm -f "$AUTHF"   # exec skips the EXIT trap
  [ -n "$prompt" ] && exec "$M" exec --yolo --model "$mdl" "$prompt"
  exec "$M" --yolo --model "$mdl"
}
fallback_to_kimi(){
  local reason="$1"; shift
  # The gpt rung retired 2026-08-04 with the OpenAI plan (aigate-gpt.sh now just
  # 402s, "workspace is out of credits"), so with no Kimi key we drop to muse.
  if [ ! -s "$HOME/.claude/aigate/kimi-key" ] && ! curl -s -m8 -o /dev/null -w '%{http_code}' \
       -H "@$AUTHF" "${AIGATE_URL:-}/api/keys/kimi" 2>/dev/null | grep -q 200; then
    fallback_to_muse "$reason, and no Kimi key" "$@"
  fi
  echo "aigate: $reason → falling back to Kimi K3 (1M ctx)" >&2
  rm -f "$AUTHF"   # exec skips the EXIT trap
  exec "$HOME/.claude/aigate/aigate-kimi.sh" "$@"
}


# Preflight FIX: a stored Claude login OUTRANKS the token aigate injects, and the
# claude binary REWRITES the Keychain entry ~1s after every launch — so a manual
# clear can never stick (delete → launch → rewritten, forever). aigate needs no
# stored login: delete it before each run so every session starts on exactly the
# account aigate picked. Warn only if the delete itself fails.
clear_shadow_login(){
  if [ "$(uname -s)" = "Darwin" ]; then
    while security delete-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; do :; done
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
      && echo "⚠️  aigate: could NOT clear the Keychain login ('Claude Code-credentials') — session may run the WRONG account" >&2
  else
    rm -f "$HOME/.claude/.credentials.json"
  fi
}

# Preflight alert (warn, don't edit): a stale ANTHROPIC_BASE_URL in settings*.json
# silently hijacks EVERY request ("Unable to connect to API" with no obvious cause).
warn_base_url(){
  local hits; hits="$(grep -l ANTHROPIC_BASE_URL "$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" 2>/dev/null | tr '\n' ' ')"
  [ -z "$hits" ] && return 0
  echo "⚠️  aigate: ANTHROPIC_BASE_URL set in ${hits}— it hijacks every request; remove the \"ANTHROPIC_BASE_URL\" key from those file(s)." >&2
}

# print mode → capture+retry; else single pick + exec (keep interactive streaming)
is_print=0 has_skip=0
for a in "$@"; do case "$a" in
  -p|--print) is_print=1;;
  --dangerously-skip-permissions) has_skip=1;;
esac; done
# headless -p implies non-interactive: skip the trust/permission prompt that
# otherwise HANGS (looks like "needs login"). Interactive keeps normal prompts.
skip=()
[ "$is_print" = 1 ] && [ "$has_skip" = 0 ] && skip=(--dangerously-skip-permissions)

clear_shadow_login   # delete any stored login that would shadow aigate's picked account
warn_base_url       # alert if settings*.json would redirect requests off-Anthropic

if [ "$is_print" != 1 ]; then
  # Interactive: SUPERVISE the official binary (not exec) so we can SWITCH accounts
  # mid-session WITHOUT a proxy. When the account runs dry, park it and relaunch
  # `claude --continue` on the next account — the SAME conversation carries over.
  # Compliant: still the real binary, your own accounts, no relay, no forged headers.
  tried=""; first=1
  while :; do
    resp="$(select_acct "$tried")"
    acct="$(printf '%s' "$resp" | jget account)"; tok="$(printf '%s' "$resp" | jget setup_token)"
    # after the first account, --continue resumes the same conversation on the next
    cont=(); [ "$first" = 0 ] && cont=(--continue)
    if [ -z "$tok" ]; then
      is_capacity_exhausted "$resp" && fallback_to_kimi "no Claude account has headroom" "${cont[@]}" "$@"
      no_token_diag "$resp"; exit 1
    fi
    echo "aigate → using account: $acct$(usage_tag "$resp")" >&2
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
    export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
    clear_shadow_login
    report_prompt "$acct" "interactive session"
    "$CLAUDE_BIN" "${cont[@]}" "$@"; rc=$?; first=0
    # On exit: cheap CACHED usage check first; only pay for a live re-poll when usage
    # is already near the cap, so a normal quit stays instant.
    worst="$(curl -s -m5 -H "@$AUTHF" "$AIGATE_URL/api/accounts" 2>/dev/null \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);a=[x for x in d if x["account"]==sys.argv[1]];print(int(max(a[0].get("five_hour_pct") or 0,a[0].get("seven_day_pct") or 0)) if a else 0)' "$acct" 2>/dev/null)"
    maxed=""
    [ "${worst:-0}" -ge 85 ] 2>/dev/null && \
      maxed="$(curl -s -m15 -X POST -H "@$AUTHF" "$AIGATE_URL/api/accounts/$acct/refresh" 2>/dev/null | jget maxed)"
    [ "$maxed" = "1" ] || exit "$rc"        # headroom left (or unknown) → normal quit, done
    echo "aigate: $acct out of headroom → auto-switching to the next account…" >&2
    report_limit "$acct"; tried="${tried:+$tried,}$acct"
    # AUTO-SWITCH (no confirm): fall straight through to the loop top, which re-selects
    # the next-best account (skipping tried) and relaunches `claude --continue` so the
    # SAME conversation carries over. Still the official binary on YOUR OWN accounts,
    # no relay, no forged headers — the switch only lands at this process boundary
    # (the OAuth token is fixed for a claude process's life; aigate is never in the path).
    # loop → re-select (skips tried) → claude --continue on the next account
  done
fi

prompt="$*"; tried=""
for attempt in 1 2 3; do
  resp="$(select_acct "$tried")"
  acct="$(printf '%s' "$resp" | jget account)"; tok="$(printf '%s' "$resp" | jget setup_token)"
  if [ -z "$tok" ]; then
    is_capacity_exhausted "$resp" && fallback_to_kimi "no Claude account has headroom" "$@"
    no_token_diag "$resp"; exit 1
  fi
  echo "aigate → account: $acct$(usage_tag "$resp") (attempt $attempt)" >&2
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
  report_prompt "$acct" "$prompt"
  # split streams: stdout stays CLEAN for consuming scripts, stderr banners don't
  # pollute it and don't false-trigger the limit classifier on success
  errf="$(mktemp)"; outf="$(mktemp)"
  # <&0 explicitly: a background job's stdin is otherwise /dev/null, breaking piped prompts
  "$CLAUDE_BIN" ${skip[@]+"${skip[@]}"} "$@" <&0 >"$outf" 2>"$errf" & cpid=$!
  wait "$cpid"; rc=$?; cpid=""
  out="$(cat "$outf")"; err="$(cat "$errf" 2>/dev/null)"; rm -f "$errf" "$outf"
  if [ $rc -eq 0 ]; then printf '%s\n' "$out"; exit 0; fi
  # 529 is Anthropic-GLOBAL load shedding, not a per-account limit — don't park
  # or hop (that drains the pool); wait and retry the SAME account
  if printf '%s\n%s' "$out" "$err" | grep -qiE 'overloaded_error|529'; then
    echo "aigate: transient overload (529) → waiting 10s, retrying same account" >&2
    sleep 10; continue
  # over-limit / unavailable → park account (default window), retry next
  elif printf '%s\n%s' "$out" "$err" | grep -qiE 'rate.?limit|usage limit|too many requests|429|quota|reached your (usage|limit)|no available|insufficient'; then
    echo "aigate: account $acct over limit/unavailable → retrying next" >&2
    report_limit "$acct"; tried="${tried:+$tried,}$acct"; continue
  fi
  printf '%s\n' "$out"; printf '%s\n' "$err" >&2; exit $rc   # genuine error, surface both streams
done
fallback_to_kimi "all accounts exhausted (tried: $tried)" "$@"
