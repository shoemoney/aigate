#!/usr/bin/env bash
# cmux → aigate: pick the account whose weekly limit resets soonest (under the cutoff), then exec the REAL claude.
# FAIL-SAFE: any aigate hiccup → launch claude normally so cmux never breaks.
#
# NEVER hardcode one install path. Fleet boxes use ~/.local/bin/claude (native
# installer); the laptop uses /opt/homebrew/bin/claude. Cmux also dumps
# ephemeral shims first on PATH — never trust `command -v claude`.
set -u

resolve_claude() {
  local c
  for c in \
    "${CLAUDE_BIN:-}" \
    /opt/homebrew/bin/claude \
    /usr/local/bin/claude \
    "$HOME/.local/bin/claude"
  do
    [ -n "${c:-}" ] && [ -x "$c" ] || continue
    case "$c" in
      *cmux-cli-shims*|*aigate/cmux-claude.sh|*aigate/aigate-run.sh) continue ;;
    esac
    printf '%s' "$c"
    return 0
  done
  return 1
}

REAL="$(resolve_claude)" || {
  echo "cmux-claude: no real claude binary found" >&2
  exit 127
}

ENVF="$HOME/.claude/aigate/env"
AIGATE_DIR="$HOME/.claude/aigate"
[ -r "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
if [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  HOST="$(hostname -s)"
  # -m6 lost to aigate's own 5s sqlite busy_timeout under NAS IO stalls; a miss falls
  # back to keychain auth, which is locked under launchd ("Not logged in"). Retry once.
  for _try in 1 2; do
    resp="$(/usr/bin/curl -s -m15 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/select?host=$HOST" 2>/dev/null)" || true
    case "$resp" in *setup_token*) break ;; esac
  done
  tok="$(printf '%s' "$resp" | /usr/bin/python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("setup_token",""))
except Exception: pass' 2>/dev/null)" || true
  acct="$(printf '%s' "$resp" | /usr/bin/python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("account",""))
except Exception: pass' 2>/dev/null)" || true

  # select observability — always write last-select.log (+ append jsonl)
  TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  SELECT_OK=0; [ -n "${tok:-}" ] && SELECT_OK=1
  {
    printf 'ts=%s host=%s account=%s tok_len=%s ok=%s bin=%s via=cmux\n' \
      "$TS" "$HOST" "${acct:-?}" "${#tok}" "$SELECT_OK" "$REAL"
    if [ "$SELECT_OK" -eq 0 ]; then
      printf 'raw=%s\n' "$(printf '%s' "$resp" | tr '\n' ' ' | cut -c1-300)"
    fi
  } > "$AIGATE_DIR/last-select.log" 2>/dev/null || true
  chmod 600 "$AIGATE_DIR/last-select.log" 2>/dev/null || true
  printf '{"ts":"%s","host":"%s","account":"%s","tok_len":%s,"ok":%s,"bin":"%s","via":"cmux"}\n' \
    "$TS" "$HOST" "${acct:-}" "${#tok}" "$SELECT_OK" "$REAL" \
    >> "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true
  chmod 600 "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true

  if [ -n "${tok:-}" ]; then
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
    export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
  fi
fi

# Optional full CC debug capture (AIGATE_DEBUG=1)
if [ "${AIGATE_DEBUG:-0}" = "1" ]; then
  DEBUG_DIR="$HOME/.claude/debug"
  /bin/mkdir -p "$DEBUG_DIR"
  DEBUG_FILE="$DEBUG_DIR/aigate-$(date -u +%Y%m%dT%H%M%SZ)-$$.txt"
  : > "$DEBUG_FILE"
  /bin/ln -sfn "$DEBUG_FILE" "$DEBUG_DIR/latest"
  echo "cmux-claude: debug → $DEBUG_FILE" >&2
  set -- --debug-file "$DEBUG_FILE" "$@"
fi

# strip dead cmux shims from PATH for anything the real binary spawns
PATH="$(printf '%s' "${PATH:-}" | tr ':' '\n' | grep -v 'cmux-cli-shims' | paste -sd: -)"
export PATH

# Strip user skip flags then inject exactly once (same as aigate-run.sh)
filtered=()
skip_next=0
for a in "$@"; do
  if [ "$skip_next" -eq 1 ]; then skip_next=0; continue; fi
  case "$a" in
    --dangerously-skip-permissions|--allow-dangerously-skip-permissions) continue ;;
    --permission-mode) skip_next=1; continue ;;
    --permission-mode=*) continue ;;
    *) filtered+=("$a") ;;
  esac
done
if [ "${#filtered[@]}" -gt 0 ]; then
  set -- --dangerously-skip-permissions --permission-mode=bypassPermissions "${filtered[@]}"
else
  set -- --dangerously-skip-permissions --permission-mode=bypassPermissions
fi

exec "$REAL" "$@"
