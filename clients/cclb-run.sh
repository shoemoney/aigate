#!/usr/bin/env bash
# cclb-run — ask the warden for the account with the most headroom, then run
# the OFFICIAL `claude` binary with that account's token. No proxy, no relay.
#
#   env: CCLB_URL (e.g. https://cclb.example.com), CCLB_TOKEN
#   usage: cclb-run [claude args...]
set -euo pipefail
: "${CCLB_URL:?set CCLB_URL}"; : "${CCLB_TOKEN:?set CCLB_TOKEN}"
HOST="$(hostname -s)"
resp="$(curl -s -m8 -H "Authorization: Bearer $CCLB_TOKEN" "$CCLB_URL/api/select?host=$HOST")" || true
acct="$(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("account",""))' 2>/dev/null || true)"
tok="$(printf '%s' "$resp"  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("setup_token",""))' 2>/dev/null || true)"
[ -n "$tok" ] || { echo "cclb: no account available → $resp" >&2; exit 1; }
echo "cclb → using account: $acct" >&2
export CLAUDE_CODE_OAUTH_TOKEN="$tok"
export CCLB_ACCOUNT="$acct"     # so the prompt hook + statusline can tag events
exec claude "$@"
