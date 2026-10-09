#!/usr/bin/env bash
# T3 Code "gemini" instance → the REAL Gemini CLI over ACP (driver "acpRegistry", agent
# "gemini", this script as the "Executable override"; T3 appends --acp). Rides the CLI's
# own Google login (`gemini` → /auth), so all this does is find the binary.
set -u
for c in "${GEMINI_BIN:-}" /opt/homebrew/bin/gemini /usr/local/bin/gemini "$HOME/.local/bin/gemini"; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-gemini-cli: no gemini binary found" >&2; exit 127; }
exec "$REAL" "$@"
