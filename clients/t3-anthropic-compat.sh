#!/usr/bin/env bash
# T3 Code → non-Anthropic providers over the REAL claude binary, keys from
# aigate's vault. One script, dispatched on invocation name (symlinks):
#
#   t3-kimi.sh      → Kimi K3           @ api.kimi.com/coding      (vault: kimi)
#   t3-muse.sh      → Meta Muse         @ api.meta.ai              (muse auth.json → vault: muse)
#   t3-facebook.sh  → Meta Muse (alt)   @ api.meta.ai              (vault: meta)
#   t3-qwen.sh      → Qwen3 Coder Plus  @ dashscope-intl (claude-code-proxy) (vault: qwencloud)
#
# Set as a Claude-driver instance "Binary path" in T3 Code settings.json
# (providers instances all use driver "claudeAgent"). T3's model dropdown only
# offers claude-* names, which these endpoints don't all serve — so we STRIP
# --model/--fallback-model/--effort from T3's args and pin the provider's real
# model via ANTHROPIC_* env instead.
set -uo pipefail

ME="$(basename "$0")"
AIGATE_DIR="$HOME/.claude/aigate"
[ -f "$AIGATE_DIR/env" ] && { set -a; . "$AIGATE_DIR/env"; set +a; }

CLAUDE_BIN="${AIGATE_CLAUDE_BIN:-}"
if [ -z "$CLAUDE_BIN" ] || [ ! -x "$CLAUDE_BIN" ]; then
  for p in "$HOME/.local/bin/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
    [ -x "$p" ] && CLAUDE_BIN="$p" && break
  done
fi
[ -x "${CLAUDE_BIN:-}" ] || { echo "$ME: no real claude binary found" >&2; exit 127; }

case "$ME" in
  t3-kimi.sh)     PROVIDER=kimi;      BASE="https://api.kimi.com/coding"
                  MODEL="${CC_KIMI_MODEL:-k3}"; FAST="${CC_KIMI_FAST_MODEL:-kimi-for-coding-highspeed}"
                  EXTRA_EFFORT="max"      # k3 supports only "max"
                  MAXCTX="${CC_KIMI_MAX_CONTEXT:-1000000}";;
  t3-muse.sh)     PROVIDER=muse;      BASE="https://api.meta.ai"
                  MODEL="${CC_MUSE_MODEL:-muse-spark-1.2-contributor}"; FAST=""; EXTRA_EFFORT=""
                  MAXCTX="${CC_MUSE_MAX_CONTEXT:-1007997}";;
  t3-facebook.sh) PROVIDER=meta;      BASE="https://api.meta.ai"
                  MODEL="${CC_META_MODEL:-muse-spark-1.2}"; FAST=""; EXTRA_EFFORT=""
                  MAXCTX="${CC_META_MAX_CONTEXT:-1007997}";;
  # NOT dashscope claude-code-proxy: its pydantic gate 500s on the role:"system"
  # message claude 2.1.x puts in messages[] (verified 2026-08-27, attempts 1-11 all
  # 500). OpenRouter's /api/v1/messages accepts it and serves the same model.
  t3-qwen.sh)     PROVIDER=openrouter; BASE="https://openrouter.ai/api"
                  MODEL="${CC_QWEN_MODEL:-qwen/qwen3-coder-plus}"; FAST=""; EXTRA_EFFORT="";;
  # Generic OpenRouter rung: ANY openrouter model id via CC_OR_MODEL. T3 instances
  # set it per-instance via their `environment` array — one symlink, many models.
  t3-openrouter.sh) PROVIDER=openrouter; BASE="https://openrouter.ai/api"
                  MODEL="${CC_OR_MODEL:-qwen/qwen3-coder-plus}"; FAST="${CC_OR_FAST_MODEL:-}"; EXTRA_EFFORT="";;
  # aigate's own /v1/messages proxy: aigate resolves "provider:model" routes and
  # holds every provider key server-side — auth is the aigate BEARER, not a vaulted
  # provider key, so the key-fetch section below is skipped for this rung.
  # claude-* bare names 529 on prod until AIGATE_PROXY_MAIN/SMALL are set there;
  # always pin an explicit route here.
  t3-aigate.sh)   PROVIDER=aigate; BASE="${CC_AIGATE_URL:-${AIGATE_URL:-https://aigate.shoemoney.ai}}"
                  MODEL="${CC_AIGATE_MODEL:-openrouter:qwen/qwen3-coder-plus}"
                  FAST="${CC_AIGATE_FAST_MODEL:-}"; EXTRA_EFFORT=""
                  MAXCTX="${CC_AIGATE_MAX_CONTEXT:-200000}";;
  *) echo "$ME: unknown dispatch name (use a t3-<provider>.sh symlink)" >&2; exit 64;;
esac

# ---- key: muse auth.json (freshest) → vault → local cache ----
CACHE="$AIGATE_DIR/$PROVIDER-key"
key=""
if [ "$PROVIDER" = aigate ]; then
  key="${AIGATE_TOKEN:-}"
  [ -n "$key" ] || { echo "$ME: AIGATE_TOKEN missing from $AIGATE_DIR/env" >&2; exit 1; }
fi
if [ "$PROVIDER" = muse ] && [ -f "$HOME/.config/muse/auth.json" ]; then
  key="$(python3 -c 'import sys,json;print(json.load(open(sys.argv[1]))["providers"]["meta"]["api_key"])' \
    "$HOME/.config/muse/auth.json" 2>/dev/null)" || true
fi
if [ -z "$key" ] && [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  key="$(curl -s -m8 -H "Authorization: Bearer $AIGATE_TOKEN" "$AIGATE_URL/api/keys/$PROVIDER" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)" || true
fi
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"   # atomic: a swarm can't tear it
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "$ME: vault unreachable → using cached $PROVIDER key" >&2
fi
[ -n "$key" ] || { echo "$ME: no $PROVIDER key (vault down, no cache). Vault one: /add-key $PROVIDER <key>" >&2; exit 1; }

# ---- strip T3's claude-model/effort selection; keep everything else ----
filtered=(); skip_next=0
for a in "$@"; do
  if [ "$skip_next" -eq 1 ]; then skip_next=0; continue; fi
  case "$a" in
    --model|--fallback-model|--effort) skip_next=1; continue;;
    --model=*|--fallback-model=*|--effort=*) continue;;
    *) filtered+=("$a");;
  esac
done
extra=(); [ -n "$EXTRA_EFFORT" ] && extra=(--effort "$EXTRA_EFFORT")

# select observability — same jsonl the other aigate wrappers feed
printf '{"ts":"%s","host":"%s","account":"%s","tok_len":%s,"ok":1,"bin":"%s","via":"t3code"}\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(hostname -s)" "$PROVIDER" "${#key}" "$CLAUDE_BIN" \
  >> "$AIGATE_DIR/last-selects.jsonl" 2>/dev/null || true

# explicit base+token outranks any stored OAuth login; clear what could race it,
# and map every model tier so background haiku/opus calls can't 404
unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
export ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_AUTH_TOKEN="$key"
export ANTHROPIC_MODEL="$MODEL" ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL" ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_SMALL_FAST_MODEL="${FAST:-$MODEL}" ANTHROPIC_DEFAULT_HAIKU_MODEL="${FAST:-$MODEL}"
[ -n "${MAXCTX:-}" ] && export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$MAXCTX"

# ~/.claude/settings.json env pins ANTHROPIC_DEFAULT_* to real Anthropic ids
# (2026-08-30 k3-alias-leak fix), and settings env OVERRIDES process env at
# claude startup — re-pin this provider's models via --settings, which outranks
# user settings in the tier order.
FASTM="${FAST:-$MODEL}"
OVR="$AIGATE_DIR/$PROVIDER-model-settings.json"
umask 077
# Meta enforces Anthropic's 64-char tool-name limit; aws-serverless plugin tools are 73 chars and 400 every request.
PLUG=""; case "$PROVIDER" in muse|meta) PLUG=',"enabledPlugins":{"aws-serverless@claude-plugins-official":false}';; esac
printf '{"env":{"ANTHROPIC_MODEL":"%s","ANTHROPIC_DEFAULT_OPUS_MODEL":"%s","ANTHROPIC_DEFAULT_SONNET_MODEL":"%s","ANTHROPIC_DEFAULT_HAIKU_MODEL":"%s","ANTHROPIC_SMALL_FAST_MODEL":"%s"}%s}\n' \
  "$MODEL" "$MODEL" "$MODEL" "$FASTM" "$FASTM" "$PLUG" > "$OVR.$$" && mv -f "$OVR.$$" "$OVR"

echo "$ME → $MODEL @ $BASE" >&2
# ${arr[@]+...} guards: macOS bash 3.2 treats an empty array as unbound under set -u
exec "$CLAUDE_BIN" --settings "$OVR" ${extra[@]+"${extra[@]}"} ${filtered[@]+"${filtered[@]}"}
