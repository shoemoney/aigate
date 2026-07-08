#!/usr/bin/env bash
# test-switching — prove aigate hands out the right Claude account and switches
# when you disable/enable them, with a REAL `cc -p` call each time.
#
# Run on a host that has `cc` installed (see install.sh) and can reach aigate.
#   usage: test-switching.sh <accountA> <accountB>
#   env:   read from ~/.claude/aigate/env (AIGATE_URL, AIGATE_TOKEN)
#
# accountA should normally have MORE headroom than accountB (so it's the default
# pick). The script toggles `disabled` and asserts the selected account flips.
set -uo pipefail
A="${1:?account A}"; B="${2:?account B}"
set -a; . "$HOME/.claude/aigate/env"; set +a
CC="$HOME/.local/bin/cc"; WORK="$(mktemp -d)"; fails=0

setdis(){ curl -s -X POST -H "Authorization: Bearer $AIGATE_TOKEN" -H 'content-type: application/json' \
  -d "{\"disabled\":$2}" "$AIGATE_URL/api/accounts/$1/disabled" >/dev/null; }
runcc(){ # $1 = expected account
  local err out picked
  err="$(mktemp)"
  out="$(cd "$WORK" && timeout 150 "$CC" -p 'reply with exactly the word PONG and nothing else' --model haiku </dev/null 2>"$err")"
  picked="$(grep -oE 'account: [A-Za-z0-9_-]+' "$err" | head -1 | awk '{print $2}')"
  local pong="no"; printf '%s' "$out" | grep -qi PONG && pong="yes"
  if [ "$picked" = "$1" ] && [ "$pong" = yes ]; then echo "  ✓ picked=$picked claude=PONG"
  else echo "  ✗ expected=$1 picked=$picked pong=$pong"; fails=$((fails+1)); fi
  rm -f "$err"
}

echo "[1] both enabled → expect $A (more headroom)"; setdis "$A" false; setdis "$B" false; sleep 1; runcc "$A"
echo "[2] $A disabled → expect $B";                  setdis "$A" true;  sleep 1;                 runcc "$B"
echo "[3] $B disabled → expect $A";                  setdis "$A" false; setdis "$B" true; sleep 1; runcc "$A"
echo "[4] both enabled → expect $A";                 setdis "$B" false; sleep 1;                 runcc "$A"
rm -rf "$WORK"
[ "$fails" = 0 ] && echo "SWITCHING OK ✔ (verify DB: access_log/request_log for host $(hostname -s))" \
  || { echo "SWITCHING FAILED: $fails"; exit 1; }
