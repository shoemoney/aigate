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
: "${AIGATE_URL:?set AIGATE_URL}"; : "${AIGATE_TOKEN:?set AIGATE_TOKEN}"
HOST="$(hostname -s)"
CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-claude}"

jget(){ python3 -c 'import sys,json;print(json.load(sys.stdin).get("'"$1"'",""))' 2>/dev/null; }
select_acct(){ curl -s -m8 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/select?host=$HOST&exclude=$1"; }
report_prompt(){ curl -s -m5 -X POST -H "Authorization: Bearer $AIGATE_TOKEN" -H 'content-type: application/json' \
    -d "$(python3 -c 'import json,sys;print(json.dumps({"account":sys.argv[1],"host":sys.argv[2],"prompt":sys.argv[3][:400]}))' "$1" "$HOST" "$2")" \
    "$AIGATE_URL/api/events/prompt" >/dev/null 2>&1 || true; }
report_limit(){ curl -s -m5 -X POST -H "Authorization: Bearer $AIGATE_TOKEN" -H 'content-type: application/json' \
    -d "{\"account\":\"$1\",\"host\":\"$HOST\"}" "$AIGATE_URL/api/events/limit" >/dev/null 2>&1 || true; }

# Preflight alert (NOT auto-fix): a stored Claude login OUTRANKS the token aigate
# injects, so the session silently serves the WRONG account — the "why is it stuck
# on one account / random re-login loop" trap. aigate injects a fresh token per
# run and needs no stored login, so if one exists we just warn how to clear it.
warn_shadow_login(){
  local hit="" mac=0
  if [ "$(uname -s)" = "Darwin" ]; then
    mac=1
    security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1 \
      && hit="a macOS Keychain login ('Claude Code-credentials')"
  elif [ -f "$HOME/.claude/.credentials.json" ]; then
    hit="$HOME/.claude/.credentials.json"
  fi
  [ -z "$hit" ] && return 0
  {
    echo "⚠️  aigate: $hit will OVERRIDE the account aigate picks —"
    echo "    sessions may silently run the WRONG account. Clear it once (aigate needs no stored login):"
    if [ "$mac" = 1 ]; then
      echo '      while security delete-generic-password -s "Claude Code-credentials" 2>/dev/null; do :; done'
    else
      echo '      rm -f ~/.claude/.credentials.json'
    fi
  } >&2
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

warn_shadow_login   # alert if a stored login would shadow aigate's picked account

if [ "$is_print" != 1 ]; then
  # Interactive: SUPERVISE the official binary (not exec) so we can SWITCH accounts
  # mid-session WITHOUT a proxy. When the account runs dry, park it and relaunch
  # `claude --continue` on the next account — the SAME conversation carries over.
  # Compliant: still the real binary, your own accounts, no relay, no forged headers.
  tried=""; first=1
  while :; do
    resp="$(select_acct "$tried")"
    acct="$(printf '%s' "$resp" | jget account)"; tok="$(printf '%s' "$resp" | jget setup_token)"
    [ -n "$tok" ] || { echo "aigate: no account available (tried: ${tried:-none}) → $resp" >&2; exit 1; }
    echo "aigate → using account: $acct" >&2
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
    warn_shadow_login
    report_prompt "$acct" "interactive session"
    # after the first account, --continue resumes the conversation on the new one
    cont=(); [ "$first" = 0 ] && cont=(--continue)
    "$CLAUDE_BIN" "${cont[@]}" "$@"; rc=$?; first=0
    # On exit: cheap CACHED usage check first; only pay for a live re-poll when usage
    # is already near the cap, so a normal quit stays instant.
    worst="$(curl -s -m5 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/accounts" 2>/dev/null \
      | python3 -c 'import sys,json;d=json.load(sys.stdin);a=[x for x in d if x["account"]==sys.argv[1]];print(int(max(a[0].get("five_hour_pct") or 0,a[0].get("seven_day_pct") or 0)) if a else 0)' "$acct" 2>/dev/null)"
    maxed=""
    [ "${worst:-0}" -ge 85 ] 2>/dev/null && \
      maxed="$(curl -s -m15 -X POST -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/accounts/$acct/refresh" 2>/dev/null | jget maxed)"
    [ "$maxed" = "1" ] || exit "$rc"        # headroom left (or unknown) → normal quit, done
    echo "aigate: $acct is out of headroom." >&2
    report_limit "$acct"; tried="${tried:+$tried,}$acct"
    next="$(printf '%s' "$(select_acct "$tried")" | jget account)"
    [ -n "$next" ] || { echo "aigate: no other account with headroom — stopping." >&2; exit "$rc"; }
    if [ -t 0 ]; then
      printf 'aigate: resume this conversation on "%s"? [Y/n] ' "$next" >&2
      read -r ans; case "$ans" in [Nn]*) exit "$rc";; esac
    fi
    # loop → re-select (skips tried) → claude --continue on the next account
  done
fi

prompt="$*"; tried=""
for attempt in 1 2 3; do
  resp="$(select_acct "$tried")"
  acct="$(printf '%s' "$resp" | jget account)"; tok="$(printf '%s' "$resp" | jget setup_token)"
  [ -n "$tok" ] || { echo "aigate: no account available (tried: ${tried:-none}) → $resp" >&2; exit 1; }
  echo "aigate → account: $acct (attempt $attempt)" >&2
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
  report_prompt "$acct" "$prompt"
  out="$("$CLAUDE_BIN" "${skip[@]}" "$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then printf '%s\n' "$out"; exit 0; fi
  # over-limit / unavailable → park account, retry next
  if printf '%s' "$out" | grep -qiE 'rate.?limit|usage limit|too many requests|429|overloaded_error|quota|reached your (usage|limit)|no available|insufficient'; then
    echo "aigate: account $acct over limit/unavailable → retrying next" >&2
    report_limit "$acct"; tried="${tried:+$tried,}$acct"; continue
  fi
  printf '%s\n' "$out" >&2; exit $rc      # genuine error, surface it
done
echo "aigate: all accounts exhausted (tried: $tried)" >&2; exit 1
