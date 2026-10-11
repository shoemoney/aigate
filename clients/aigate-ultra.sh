#!/usr/bin/env bash
# Terminal commands on each provider's own top plan. One script dispatched on its invocation
# name; install.sh symlinks these into ~/.local/bin:
#
#   qwen-ultra   → the real qwen CLI      (Qwen token plan, vault key qwen-tokenplan, qwen3.8-max)
#   kimi-ultra   → the real kimi CLI      (the Kimi Code plan from `kimi login`, K3, never-ask)
#   amber-ultra  → the real opencode      (Amber Sinclair agent, her one model: grok-4.6 on OpenRouter)
#
# Gemini CLI only speaks Google's API, so it has no rung here. Vault keys travel as env
# vars: never argv, never a config file.
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

if [ "$ME" = kimi-ultra ]; then
  # plain ~/.kimi-code: the plan and models `kimi login` set up, same as T3's KIMI
  pre=()
  case "${1:-}" in
    export|fork|provider|session|acp|web|server|rc|remote|login|doctor|vis|install-desktop|migrate|upgrade|update) ;;
    *)
      has_model=0; is_prompt=0
      for a in "$@"; do
        case "$a" in -m|--model|--model=*) has_model=1;; -p|--prompt|--prompt=*) is_prompt=1;; esac
      done
      [ "$has_model" = 1 ] || pre+=(-m kimi-code/k3)
      # --auto (never ask) is refused alongside --prompt; prompt mode never asks anyway
      [ "$is_prompt" = 1 ] || pre+=(--auto)
      ;;
  esac
  exec "$REAL" ${pre[@]+"${pre[@]}"} "$@"
fi

# ---- key: vault → mode-600 cache ----
vault_key() { # $1 = vault provider name; prints the key, exits 1 if neither vault nor cache has one
  local name="$1" cache="$AIGATE_DIR/$1-key" k="" authf
  if [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
    authf="$(/usr/bin/mktemp)" && chmod 600 "$authf" && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$authf"   # header file keeps the bearer out of argv
    k="$(curl -s -m8 -H "@$authf" "$AIGATE_URL/api/keys/$name" \
      | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)" || true
    rm -f "$authf"
  fi
  if [ -n "$k" ]; then
    (umask 077; printf '%s' "$k" > "$cache.$$" && mv -f "$cache.$$" "$cache")   # atomic: parallel runs can't tear it
  elif [ -f "$cache" ]; then
    k="$(cat "$cache")"; echo "$ME: vault unreachable → cached $name key" >&2
  fi
  [ -n "$k" ] || { echo "$ME: no $name key (vault down, no cache). Vault one: /add-key $name <key>" >&2; return 1; }
  printf '%s' "$k"
}

case "$ME" in
  qwen-ultra)
    key="$(vault_key qwen-tokenplan)" || exit 1
    export QWEN_TOKENPLAN_KEY="$key"
    # exported, so a project's .env (qwen reads the first one up from cwd) can't override them
    export OPENAI_API_KEY="$key" OPENAI_BASE_URL="$TP_URL" OPENAI_MODEL="qwen3.8-max" QWEN_CODE_SUPPRESS_YOLO_WARNING=1
    # same approval default as the interactive `qwen` zsh function
    pre=()
    case "${1:-}" in auth|channel|extensions|hooks|mcp|review|serve|sessions|update) ;; *) pre=(--approval-mode yolo) ;; esac
    exec "$REAL" ${pre[@]+"${pre[@]}"} "$@"
    ;;
  amber-ultra)
    # Amber only works on an uncensored model: her own "AmberSinclair v1.3" from opencode.json,
    # which is x-ai/grok-4.6 on OpenRouter. Merged over ~/.config/opencode/opencode.json: only
    # the "amber" provider stays enabled and every agent rides her one model. AMBER_MODEL swaps
    # the OpenRouter id. The global skills + MCP tools put turn one at ~128K, and any context
    # limit under that makes opencode compact (then auto-continue) after every single reply.
    key="$(vault_key openrouter)" || exit 1
    export AMBER_OPENROUTER_KEY="$key"
    AM="${AMBER_MODEL:-x-ai/grok-4.6}"
    PROMPT="$HOME/.config/opencode/prompts/grok.md"
    export OPENCODE_CONFIG_CONTENT="$(python3 -c '
import json,sys
model,prompt=sys.argv[1:3]
amber="amber/AmberSinclair"
print(json.dumps({
  "enabled_providers": ["amber"],
  "provider": {"amber": {
    "npm": "@ai-sdk/openai-compatible", "name": "OpenRouter (Amber)",
    "options": {"baseURL": "https://openrouter.ai/api/v1", "apiKey": "{env:AMBER_OPENROUTER_KEY}",
                "headers": {"HTTP-Referer": "http://shoemoney.com", "X-Title": "shoemoney"}},
    "models": {"AmberSinclair": {"id": model, "name": "Amber Sinclair", "limit": {"context": 500000, "output": 32768}}}}},
  "model": amber, "small_model": amber, "default_agent": "amber",
  "agent": {"amber": {"model": amber, "prompt": "{file:" + prompt + "}"},
            "build": {"model": amber}, "plan": {"model": amber}, "grok": {"model": amber}},
}))' "$AM" "$PROMPT")"
    exec "$REAL" "$@"
    ;;
esac
