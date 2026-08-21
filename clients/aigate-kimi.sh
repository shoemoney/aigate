#!/usr/bin/env bash
# aigate-kimi — run the OFFICIAL `claude` binary against Kimi K3 (kimi.com "Kimi
# for Coding" subscription), using the sk-kimi key from aigate's vault.
#
# This is NOT the Claude-account warden: Kimi has no Claude OAuth account, so we
# bypass aigate-run.sh entirely and point Claude Code at Kimi's Anthropic-compatible
# endpoint via ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN. Still the real binary, your
# own provider key, no proxy, no relay, no forged headers.
#
#   env:   AIGATE_URL, AIGATE_TOKEN (sourced by cc from ~/.claude/aigate/env)
#   opt:   CC_KIMI_MODEL (default k3), CC_KIMI_FAST_MODEL (default kimi-for-coding-highspeed),
#          CC_KIMI_BASE_URL (default https://api.kimi.com/coding)
#   usage: cc kimi [claude args...]        e.g.  cc kimi -p "explain this repo"
set -uo pipefail
: "${AIGATE_URL:?not set — run: set -a; . ~/.claude/aigate/env; set +a}"
: "${AIGATE_TOKEN:?not set — run: set -a; . ~/.claude/aigate/env; set +a}"

CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-claude}"
MODEL="${CC_KIMI_MODEL:-k3}"
FAST="${CC_KIMI_FAST_MODEL:-kimi-for-coding-highspeed}"
BASE="${CC_KIMI_BASE_URL:-https://api.kimi.com/coding}"   # Claude Code appends /v1/messages
CACHE="$HOME/.claude/aigate/kimi-key"                     # mode 600, plaintext (same as mcp-keys.env)

# Pull the sk-kimi key from the vault (audited: host+IP). Fetch-first so a rotated
# key wins immediately; fall back to the cache only when the vault is unreachable,
# so a swarm of parallel launches survives a vault blip mid-run.
key="$(curl -s -m8 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/keys/kimi" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)"
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"   # atomic: a swarm can't tear it
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "aigate-kimi: vault unreachable → using cached key" >&2
fi
[ -n "$key" ] || { echo "aigate-kimi: no kimi key (vault down and no cache). Vault one: /add-key kimi <sk-kimi-…>" >&2; exit 1; }

# headless -p implies non-interactive: skip the trust prompt that otherwise HANGS
# (looks like "needs login"). Interactive keeps the normal prompts.
is_print=0 has_skip=0
for a in "$@"; do case "$a" in
  -p|--print) is_print=1;;
  --dangerously-skip-permissions) has_skip=1;;
esac; done
skip=(); [ "$is_print" = 1 ] && [ "$has_skip" = 0 ] && skip=(--dangerously-skip-permissions)

# A stored Claude OAuth login does NOT override an explicit base+token, but clear
# the OAuth env so nothing races it, and map every model tier onto Kimi (else a
# background haiku/opus call 404s against a model Kimi doesn't serve).
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_AUTH_TOKEN="$key"
export ANTHROPIC_MODEL="$MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$FAST" ANTHROPIC_DEFAULT_HAIKU_MODEL="$FAST"
echo "aigate-kimi → $MODEL @ $BASE" >&2
exec "$CLAUDE_BIN" "${skip[@]}" "$@"
