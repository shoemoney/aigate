#!/usr/bin/env bash
# T3 Code → aigate: pick the Claude account whose weekly limit resets soonest (under the cutoff), then exec the
# REAL claude binary with that account's setup token. Set as the Claude provider
# "Binary path" in T3 Code (settings.json → providers.claudeAgent.binaryPath).
# FAIL-SAFE: any aigate hiccup → launch claude normally so T3 Code never breaks.
#
# NEVER hardcode one install path. Fleet boxes use ~/.local/bin/claude (native
# installer); the laptop uses /opt/homebrew/bin/claude.
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
      *aigate/t3-claude.sh|*aigate/cmux-claude.sh|*aigate/aigate-run.sh) continue ;;
    esac
    printf '%s' "$c"
    return 0
  done
  return 1
}

REAL="$(resolve_claude)" || {
  echo "t3-claude: no real claude binary found" >&2
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
    printf 'ts=%s host=%s account=%s tok_len=%s ok=%s bin=%s via=t3code\n' \
      "$TS" "$HOST" "${acct:-?}" "${#tok}" "$SELECT_OK" "$REAL"
    if [ "$SELECT_OK" -eq 0 ]; then
      printf 'raw=%s\n' "$(printf '%s' "$resp" | tr '\n' ' ' | cut -c1-300)"
    fi
  } > "$AIGATE_DIR/last-select.log" 2>/dev/null || true
  chmod 600 "$AIGATE_DIR/last-select.log" 2>/dev/null || true
  printf '{"ts":"%s","host":"%s","account":"%s","tok_len":%s,"ok":%s,"bin":"%s","via":"t3code"}\n' \
    "$TS" "$HOST" "${acct:-}" "${#tok}" "$SELECT_OK" "$REAL" \
    >> "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true
  chmod 600 "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true

  if [ -n "${tok:-}" ]; then
    unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
    export CLAUDE_CODE_OAUTH_TOKEN="$tok" AIGATE_ACCOUNT="$acct"
  fi
fi

# Cross-provider resume guard: a thread that previously ran on a compat provider
# (t3-openrouter/kimi/muse) has assistant ids like gen-.../chatcmpl-... in its
# transcript. Claude Code sends the last one as diagnostics.previous_message_id,
# and api.anthropic.com 400s anything not starting with msg_. Scrub before resume.
prev=""
for a in "$@"; do
  if [ "$prev" = "--resume" ] || [ "$prev" = "-r" ]; then
    case "$a" in
      [0-9a-f]*-*-*-*-*)
        f="$(/usr/bin/find "$HOME/.claude/projects" -maxdepth 2 -name "$a.jsonl" 2>/dev/null | head -1)"
        [ -n "$f" ] && /usr/bin/python3 - "$f" <<'PYEOF' >/dev/null 2>&1 || true
import json,sys
p=sys.argv[1]; out=[]; dirty=False
for line in open(p,errors='replace'):
    s=line.rstrip('\n')
    try: o=json.loads(s)
    except Exception: out.append(s); continue
    m=o.get("message")
    if isinstance(m,dict) and m.get("role")=="assistant" and m.get("id") and not m["id"].startswith("msg_"):
        m["id"]="msg_"+"".join(c for c in m["id"] if c.isalnum())[:24]
        dirty=True; s=json.dumps(o,separators=(',',':'))
    out.append(s)
if dirty: open(p,"w").write("\n".join(out)+"\n")
PYEOF
        ;;
    esac
  fi
  prev="$a"
done

# T3 Code owns the flags (output format, permission mode, shadow home) — pass
# everything through untouched.
exec "$REAL" "$@"
