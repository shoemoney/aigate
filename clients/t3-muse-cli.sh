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

# T3 polls --version every minute. A real muse start logs ~650 SecTrust lines plus as many from
# trustd (a third of this Mac's unified log), so answer from a cache keyed on the installed build.
if [ "$*" = --version ] && [ -s "$HOME/.local/bin/.muse-version" ]; then
  key="$REAL $(cat "$HOME/.local/bin/.muse-version")" cache="$HOME/.cache/t3-muse-version"
  [ -s "$cache" ] && [ "$(head -1 "$cache")" = "$key" ] && { tail -n +2 "$cache"; exit 0; }
  out="$("$REAL" --version)" || exit
  mkdir -p "${cache%/*}" && printf '%s\n%s\n' "$key" "$out" > "$cache.$$" && mv -f "$cache.$$" "$cache"
  printf '%s\n' "$out"; exit 0
fi
unset META_API_KEY
exec "$REAL" "$@"
