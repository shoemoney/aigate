#!/usr/bin/env bash
# T3 Code → opencode with the dashscope key hydrated from aigate's vault, so qwen
# runs on the Alibaba account (Model Studio intl) instead of OpenRouter credits.
# Claude Code itself CANNOT ride dashscope (its role:"system" message 500s on their
# claude-code-proxy — verified 2026-08-27, even with a clean config dir), so the
# qwen-on-own-plan route goes through opencode's OpenAI-compatible driver instead.
set -u
# ~/.opencode/bin first: the official installer tracks npm latest, brew's formula lags
for c in "$HOME/.opencode/bin/opencode" /opt/homebrew/bin/opencode /usr/local/bin/opencode "$HOME/.local/bin/opencode"; do
  [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-opencode: no opencode binary found" >&2; exit 127; }

AIGATE_DIR="$HOME/.claude/aigate"
[ -f "$AIGATE_DIR/env" ] && { set -a; . "$AIGATE_DIR/env"; set +a; }
CACHE="$AIGATE_DIR/qwencloud-key"
key=""
if [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  AUTHF="$(/usr/bin/mktemp)" && chmod 600 "$AUTHF" && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"   # header file keeps the bearer out of argv
  key="$(curl -s -m8 -H "@$AUTHF" "$AIGATE_URL/api/keys/qwencloud" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)" || true
  rm -f "$AUTHF"
fi
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "t3-opencode: vault unreachable → cached qwencloud key" >&2
fi
[ -n "$key" ] && export DASHSCOPE_API_KEY="$key"
printf '{"ts":"%s","host":"%s","account":"qwencloud-opencode","tok_len":%s,"ok":1,"bin":"%s","via":"t3code"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -s)" "${#key}" "$REAL" \
  >> "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true
exec "$REAL" "$@"
