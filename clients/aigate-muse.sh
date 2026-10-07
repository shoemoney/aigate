#!/usr/bin/env bash
# aigate-muse — run the OFFICIAL `claude` binary against Meta's Muse models,
# pointed at api.meta.ai's Anthropic-compatible endpoint. Same posture as
# aigate-kimi.sh: real binary, your own Model API key, no proxy, no relay.
#
# Meta's gateway is dual-protocol — /v1/messages (Anthropic) AND /v1/responses
# (OpenAI), Bearer-only auth verified 2026-08-11 — so Claude Code talks to it
# natively.
#
# Key sources, in order: the Muse CLI's ~/.config/muse/auth.json (minted and
# refreshed by `muse login`, so it's the freshest) → aigate's vault (provider
# `muse`, for fleet boxes without the CLI) → local cache (survives a vault blip).
#
#   env:   AIGATE_URL, AIGATE_TOKEN (optional — only the vault fallback needs them)
#   opt:   CC_MUSE_MODEL (default muse-spark-1.2-contributor),
#          CC_MUSE_BASE_URL (default https://api.meta.ai)
#   usage: ai muse [claude args...]        e.g.  ai muse -p "explain this repo"
#          ai --model muse [claude args...] (same thing, --model-style selection)
set -uo pipefail

CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ]; then
  # non-interactive/ssh shells have a minimal PATH — detect the binary explicitly
  for p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [ -x "$p" ] && CLAUDE_BIN="$p" && break
  done
  CLAUDE_BIN="${CLAUDE_BIN:-claude}"
fi
MODEL="${CC_MUSE_MODEL:-muse-spark-1.2-contributor}"
BASE="${CC_MUSE_BASE_URL:-https://api.meta.ai}"   # Claude Code appends /v1/messages
AUTH_JSON="${CC_MUSE_AUTH_JSON:-$HOME/.config/muse/auth.json}"
CACHE="$HOME/.claude/aigate/muse-key"             # mode 600, plaintext (same as mcp-keys.env)

# the vault fallback needs creds and nothing sources them this early in `ai` —
# pull them in when the warden env file exists (fleet boxes without the Muse CLI)
if [ -z "${AIGATE_URL:-}" ] || [ -z "${AIGATE_TOKEN:-}" ]; then
  [ -f "$HOME/.claude/aigate/env" ] && { set -a; . "$HOME/.claude/aigate/env"; set +a; }
fi

key=""
if [ -f "$AUTH_JSON" ]; then
  key="$(python3 -c 'import sys,json;print(json.load(open(sys.argv[1]))["providers"]["meta"]["api_key"])' "$AUTH_JSON" 2>/dev/null)"
fi
if [ -z "$key" ] && [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  # auth header goes in a mode-600 file, not argv (visible via `ps`); removed before the final exec, which skips EXIT traps
  AUTHF="$(mktemp)"; chmod 600 "$AUTHF"; printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"
  key="$(curl -s -m8 -H "@$AUTHF" "$AIGATE_URL/api/keys/muse" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)"
  rm -f "$AUTHF"
fi
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"   # atomic: a swarm can't tear it
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "aigate-muse: auth.json + vault unavailable → using cached key" >&2
fi
[ -n "$key" ] || { echo "aigate-muse: no muse key (run \`muse login\`, or vault one: /add-key muse <LLM|…>)" >&2; exit 1; }

# headless -p implies non-interactive: skip the trust prompt that otherwise HANGS
# (looks like "needs login"). Interactive keeps the normal prompts.
is_print=0 has_skip=0 has_settings=0
for a in "$@"; do case "$a" in
  -p|--print) is_print=1;;
  --dangerously-skip-permissions) has_skip=1;;
  --settings|--settings=*) has_settings=1;;
esac; done
skip=(); [ "$is_print" = 1 ] && [ "$has_skip" = 0 ] && skip=(--dangerously-skip-permissions)
# Meta's gateway enforces the 64-char tool-name limit strictly (Anthropic's own
# limit) — the aws-serverless plugin's 73-char tool names 400 every request, so
# that ONE plugin is disabled for muse sessions. Caller-passed --settings wins.
st=(); [ "$has_settings" = 0 ] && st=(--settings "$HOME/.claude/aigate/muse-settings.json")

# A stored Claude OAuth login does NOT override an explicit base+token, but clear
# the OAuth env so nothing races it, and map every model tier onto Muse (no fast
# tier is served — a background haiku call would 404 otherwise).
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_AUTH_TOKEN="$key"
export ANTHROPIC_MODEL="$MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="$MODEL" ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"
# real window is 1,007,997 (muse-code/models catalog) — without this Claude Code
# assumes 200k for unknown models and auto-compacts 5x too early.
export CLAUDE_CODE_MAX_CONTEXT_TOKENS="${CC_MUSE_MAX_CONTEXT:-1007997}"
echo "aigate-muse → $MODEL @ $BASE" >&2
exec "$CLAUDE_BIN" ${skip[@]+"${skip[@]}"} ${st[@]+"${st[@]}"} "$@"
