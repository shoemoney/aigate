#!/usr/bin/env bash
# T3 Code "kimi" instance → the REAL Kimi Code CLI over ACP (driver "acpRegistry", agent
# "kimi", this script as the "Executable override"; T3 appends `acp`). Kimi Code keeps its
# own login in ~/.kimi-code (`kimi login`), so all this does is find the binary: npm/brew
# installs land in /opt/homebrew/bin, the native installer in ~/.local/bin.
set -u
for c in "${KIMI_BIN:-}" /opt/homebrew/bin/kimi /usr/local/bin/kimi "$HOME/.local/bin/kimi"; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-kimi-cli: no kimi binary found" >&2; exit 127; }
exec "$REAL" "$@"
