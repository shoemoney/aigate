#!/usr/bin/env bash
# T3 Code → aigate for its NATIVE codex driver: pick the Codex account whose weekly
# limit resets soonest (under the cutoff), write its auth.json (aigate-codex.sh --write-only), then exec the
# REAL codex with T3's args untouched. Set as the codex "Binary path" in T3 Code.
# STICKY: aigate-codex.sh runs the keeper first and will NOT switch the on-disk
# account while another codex for this CODEX_HOME is alive (T3 spawns one per
# thread; switching under a live one makes it spend a rotated-away token).
# FAIL-SAFE: any aigate problem → exec the real codex anyway so T3 never breaks.
set -u
AIGATE_DIR="${AIGATE_DIR:-$HOME/.claude/aigate}"

# >>> aigate-codex-bin (byte-identical in aigate-codex.sh, t3-codex-cli.sh, ai; test/codex-client.test.js enforces it)
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

REAL="$(aigate_codex_bin)" || { echo "t3-codex-cli: no real codex binary found" >&2; exit 127; }
export AIGATE_CODEX_BIN="$REAL"
if [ -x "$AIGATE_DIR/aigate-codex.sh" ]; then
  # quiet by design: T3 owns stdout/stderr of the driver
  "$AIGATE_DIR/aigate-codex.sh" --write-only >/dev/null 2>&1 || true
fi
exec "$REAL" "$@"
