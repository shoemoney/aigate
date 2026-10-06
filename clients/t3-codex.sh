#!/usr/bin/env bash
# T3 Code → aigate for its NATIVE codex driver: pick the Codex account with the
# most headroom, write its auth.json (aigate-codex.sh --write-only), then exec the
# REAL codex with T3's args untouched. Set as the codex "Binary path" in T3 Code.
# STICKY: aigate-codex.sh runs the keeper first and will NOT switch the on-disk
# account while another codex for this CODEX_HOME is alive (T3 spawns one per
# thread; switching under a live one makes it spend a rotated-away token).
# FAIL-SAFE: any aigate problem → exec the real codex anyway so T3 never breaks.
set -u
AIGATE_DIR="${AIGATE_DIR:-$HOME/.claude/aigate}"

resolve_codex() {
  local c d
  if [ -n "${AIGATE_CODEX_BIN:-}" ] && [ -x "$AIGATE_CODEX_BIN" ]; then printf '%s' "$AIGATE_CODEX_BIN"; return 0; fi
  for c in "$HOME/.local/bin/codex" /opt/homebrew/bin/codex /usr/local/bin/codex; do
    [ -x "$c" ] || continue
    case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
    printf '%s' "$c"; return 0
  done
  local IFS=:
  for d in $PATH; do
    c="$d/codex"; [ -x "$c" ] || continue
    case "$c" in *cmux-cli-shims*|*aigate/*) continue;; esac
    printf '%s' "$c"; return 0
  done
  return 1
}

REAL="$(resolve_codex)" || { echo "t3-codex: no real codex binary found" >&2; exit 127; }
export AIGATE_CODEX_BIN="$REAL"
if [ -x "$AIGATE_DIR/aigate-codex.sh" ]; then
  # quiet by design: T3 owns stdout/stderr of the driver
  "$AIGATE_DIR/aigate-codex.sh" --write-only >/dev/null 2>&1 || true
fi
exec "$REAL" "$@"
