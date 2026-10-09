#!/usr/bin/env bash
# Terminal commands on the Qwen token plan (the "ultra plan", vault key qwen-tokenplan).
# One script dispatched on its invocation name; install.sh symlinks these into ~/.local/bin:
#
#   qwen-ultra   → the real qwen CLI      (OpenAI auth, qwen3.8-max; `-m glm-5.3` etc. to switch)
#   kimi-ultra   → the real kimi CLI      (own KIMI_CODE_HOME holding a token-plan provider)
#   amber-ultra  → the real opencode      (Amber Sinclair agent, her one model only)
#
# The token plan serves qwen3.x / glm-5.x / deepseek-v4 only — no kimi, gemini or grok
# models — so each CLI runs on token-plan models. Gemini CLI only speaks Google's API, so
# it has no rung here. The key travels as an env var: never argv, never a config file.
set -u
ME="$(basename "$0")"
TP_URL="https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"
AIGATE_DIR="$HOME/.claude/aigate"
[ -f "$AIGATE_DIR/env" ] && { set -a; . "$AIGATE_DIR/env"; set +a; }

find_bin() {
  local c
  for c in "$@"; do [ -n "$c" ] && [ -x "$c" ] && { printf '%s' "$c"; return 0; }; done
  return 1
}

case "$ME" in
  qwen-ultra)  REAL="$(find_bin "${QWEN_BIN:-}" /opt/homebrew/bin/qwen /usr/local/bin/qwen "$HOME/.local/bin/qwen")" ;;
  kimi-ultra)  REAL="$(find_bin "${KIMI_BIN:-}" /opt/homebrew/bin/kimi /usr/local/bin/kimi "$HOME/.local/bin/kimi")" ;;
  # ~/.opencode/bin first: the official installer tracks npm latest, brew's formula lags
  amber-ultra) REAL="$(find_bin "${OPENCODE_BIN:-}" "$HOME/.opencode/bin/opencode" /opt/homebrew/bin/opencode /usr/local/bin/opencode "$HOME/.local/bin/opencode")" ;;
  *) echo "$ME: unknown dispatch name (use qwen-ultra, kimi-ultra or amber-ultra)" >&2; exit 64 ;;
esac
[ -n "${REAL:-}" ] || { echo "$ME: CLI binary not found" >&2; exit 127; }

# ---- key: vault → mode-600 cache ----
CACHE="$AIGATE_DIR/qwen-tokenplan-key"
key=""
if [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  AUTHF="$(/usr/bin/mktemp)" && chmod 600 "$AUTHF" && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"   # header file keeps the bearer out of argv
  key="$(curl -s -m8 -H "@$AUTHF" "$AIGATE_URL/api/keys/qwen-tokenplan" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)" || true
  rm -f "$AUTHF"
fi
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"   # atomic: parallel runs can't tear it
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "$ME: vault unreachable → cached qwen-tokenplan key" >&2
fi
[ -n "$key" ] || { echo "$ME: no qwen-tokenplan key (vault down, no cache). Vault one: /add-key qwen-tokenplan <key>" >&2; exit 1; }
export QWEN_TOKENPLAN_KEY="$key"

case "$ME" in
  qwen-ultra)
    # exported, so a project's .env (qwen reads the first one up from cwd) can't override them
    export OPENAI_API_KEY="$key" OPENAI_BASE_URL="$TP_URL" OPENAI_MODEL="qwen3.8-max" QWEN_CODE_SUPPRESS_YOLO_WARNING=1
    # same approval default as the interactive `qwen` zsh function
    pre=()
    case "${1:-}" in auth|channel|extensions|hooks|mcp|review|serve|sessions|update) ;; *) pre=(--approval-mode yolo) ;; esac
    exec "$REAL" ${pre[@]+"${pre[@]}"} "$@"
    ;;
  kimi-ultra)
    # a separate home, so the token-plan provider never shows up in plain `kimi` or T3's KIMI
    export KIMI_CODE_HOME="${KIMI_ULTRA_HOME:-$HOME/.kimi-code-ultra}"
    mkdir -p "$KIMI_CODE_HOME"
    for f in mcp.json tui.toml; do
      [ -e "$HOME/.kimi-code/$f" ] && [ ! -e "$KIMI_CODE_HOME/$f" ] && ln -s "$HOME/.kimi-code/$f" "$KIMI_CODE_HOME/$f"
    done
    CFG="$KIMI_CODE_HOME/config.toml"
    {
      printf '# written by aigate-ultra.sh on every kimi-ultra launch — edits here are overwritten\n'
      printf 'default_model = "tokenplan/qwen3.8-max"\n\n'
      printf '[providers.tokenplan]\ntype = "openai"\napi_key_env = "QWEN_TOKENPLAN_KEY"\nbase_url = "%s"\n' "$TP_URL"
      # id|name|context. Sizes are deliberately under the vendor max: hitting the context limit
      # makes the CLI compact, while a slightly early compaction costs nothing.
      for m in "qwen3.8-max|Qwen3.8 Max|262144" "qwen3.7-plus|Qwen3.7 Plus|262144" "glm-5.3|GLM-5.3|131072" "deepseek-v4-pro|DeepSeek V4 Pro|131072"; do
        id="${m%%|*}"; rest="${m#*|}"
        printf '\n[models."tokenplan/%s"]\nprovider = "tokenplan"\nmodel = "%s"\nmax_context_size = %s\ncapabilities = [ "tool_use" ]\ndisplay_name = "%s (token plan)"\n' \
          "$id" "$id" "${rest#*|}" "${rest%%|*}"
      done
    } > "$CFG.$$" && mv -f "$CFG.$$" "$CFG"
    exec "$REAL" "$@"
    ;;
  amber-ultra)
    # merged over ~/.config/opencode/opencode.json: only the token-plan provider stays enabled,
    # and every agent rides the single "Amber Sinclair" model. AMBER_MODEL swaps what backs her.
    # 256K context: the global skills + MCP tools already put turn one at ~128K, and any limit
    # under that makes opencode compact (then auto-continue) after every single reply.
    AM="${AMBER_MODEL:-qwen3.8-max}"
    PROMPT="$HOME/.config/opencode/prompts/grok.md"
    export OPENCODE_CONFIG_CONTENT="$(python3 -c '
import json,sys
url,model,prompt=sys.argv[1:4]
amber="tokenplan/AmberSinclair"
print(json.dumps({
  "enabled_providers": ["tokenplan"],
  "provider": {"tokenplan": {
    "npm": "@ai-sdk/openai-compatible", "name": "Qwen token plan",
    "options": {"baseURL": url, "apiKey": "{env:QWEN_TOKENPLAN_KEY}"},
    "models": {"AmberSinclair": {"id": model, "name": "Amber Sinclair", "limit": {"context": 262144, "output": 32768}}}}},
  "model": amber, "small_model": amber, "default_agent": "amber",
  "agent": {"amber": {"model": amber, "prompt": "{file:" + prompt + "}"},
            "build": {"model": amber}, "plan": {"model": amber}, "grok": {"model": amber}},
}))' "$TP_URL" "$AM" "$PROMPT")"
    exec "$REAL" "$@"
    ;;
esac
