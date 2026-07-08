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

if [ "$is_print" != 1 ]; then
  resp="$(select_acct "")"
  acct="$(printf '%s' "$resp" | jget account)"; tok="$(printf '%s' "$resp" | jget setup_token)"
  [ -n "$tok" ] || { echo "aigate: no account available → $resp" >&2; exit 1; }
  echo "aigate → using account: $acct" >&2
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
  export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
  report_prompt "$acct" "interactive session"
  exec "$CLAUDE_BIN" "$@"
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
