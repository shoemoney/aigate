#!/usr/bin/env bash
# aigate-run — ask the warden for the account with the most headroom, then run
# the OFFICIAL `claude` binary with that account's token. No proxy, no relay.
#
#   env: AIGATE_URL (e.g. https://aigate.example.com), AIGATE_TOKEN
#   usage: aigate-run [claude args...]
set -euo pipefail
: "${AIGATE_URL:?set AIGATE_URL}"; : "${AIGATE_TOKEN:?set AIGATE_TOKEN}"
HOST="$(hostname -s)"
resp="$(curl -s -m8 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/select?host=$HOST")" || true
acct="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("account",""))' 2>/dev/null || true)"
tok="$(printf '%s' "$resp"  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("setup_token",""))' 2>/dev/null || true)"
[ -n "$tok" ] || { echo "aigate: no account available → $resp" >&2; exit 1; }
echo "aigate → using account: $acct" >&2
# don't let a stray key on the box override the account aigate just picked (the whole point)
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
export CLAUDE_CODE_OAUTH_TOKEN="$tok"
export AIGATE_ACCOUNT="$acct"     # so the prompt hook + statusline can tag events
exec claude "$@"
