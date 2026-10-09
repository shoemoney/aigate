#!/usr/bin/env bash
# T3 Code → the REAL Qwen Code CLI over ACP (T3 "acpRegistry" driver, agent
# "qwen-code", this script as the "Executable override"; T3 appends --acp ...).
# Exports ~/.qwen/.env first, same as the interactive `qwen` zsh function: qwen
# only reads the FIRST .env it finds walking up from cwd, so inside a project with
# its own .env (every Laravel repo) it would never see the DashScope key.
set -u
for c in "${QWEN_BIN:-}" /opt/homebrew/bin/qwen /usr/local/bin/qwen "$HOME/.local/bin/qwen"; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-qwen-code: no qwen binary found" >&2; exit 127; }

[ -r "$HOME/.qwen/.env" ] && { set -a; . "$HOME/.qwen/.env"; set +a; }
exec "$REAL" "$@"
