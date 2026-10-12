#!/usr/bin/env bash
# T3 Code "muse" instance → the REAL Muse Code CLI on your `muse login` (driver "muse", this
# script as the "Binary path"; T3 runs `serve ...`). A stray META_API_KEY would outrank that
# login, so it is dropped here; the FB-key instance runs t3-facebook-cli.sh instead.
# T3's one-click Muse update only appears when the Binary path IS the official launcher;
# behind this script, muse updates itself the next time it runs from a terminal.
set -u
for c in "${MUSE_BIN:-}" "$HOME/.local/bin/muse" /opt/homebrew/bin/muse /usr/local/bin/muse; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-muse-cli: no muse binary found" >&2; exit 127; }
unset META_API_KEY
exec "$REAL" "$@"
