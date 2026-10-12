#!/usr/bin/env bash
# T3 Code "facebook" instance → the REAL Muse Code CLI (driver "muse", this script as the
# "Binary path") on the FB/meta key from aigate's vault instead of the `muse login` OAuth
# session. Muse honors META_API_KEY over its stored login, but T3 strips that var from the
# env it hands muse, so it has to be set here.
set -u
for c in "${MUSE_BIN:-}" "$HOME/.local/bin/muse" /opt/homebrew/bin/muse /usr/local/bin/muse; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-facebook-cli: no muse binary found" >&2; exit 127; }

# T3 polls --version every minute. A real muse start logs ~650 SecTrust lines plus as many from
# trustd (a third of this Mac's unified log), so answer from a cache keyed on the installed build.
if [ "$*" = --version ] && [ -s "$HOME/.local/bin/.muse-version" ]; then
  key="$REAL $(cat "$HOME/.local/bin/.muse-version")" cache="$HOME/.cache/t3-muse-version"
  [ -s "$cache" ] && [ "$(head -1 "$cache")" = "$key" ] && { tail -n +2 "$cache"; exit 0; }
  out="$("$REAL" --version)" || exit
  mkdir -p "${cache%/*}" && printf '%s\n%s\n' "$key" "$out" > "$cache.$$" && mv -f "$cache.$$" "$cache"
  printf '%s\n' "$out"; exit 0
fi

# T3's version probe must not wait on the vault
case "${1:-}" in --version|-V|--help|-h) exec "$REAL" "$@";; esac

AIGATE_DIR="$HOME/.claude/aigate"
[ -f "$AIGATE_DIR/env" ] && { set -a; . "$AIGATE_DIR/env"; set +a; }
CACHE="$AIGATE_DIR/meta-key"
key=""
if [ -n "${AIGATE_URL:-}" ] && [ -n "${AIGATE_TOKEN:-}" ]; then
  AUTHF="$(/usr/bin/mktemp)" && chmod 600 "$AUTHF" && printf 'Authorization: Bearer %s\n' "$AIGATE_TOKEN" > "$AUTHF"   # header file keeps the bearer out of argv
  key="$(curl -s -m8 -H "@$AUTHF" "$AIGATE_URL/api/keys/meta" \
    | python3 -c 'import sys,json;print(json.load(sys.stdin).get("key",""))' 2>/dev/null)" || true
  rm -f "$AUTHF"
fi
if [ -n "$key" ]; then
  umask 077; printf '%s' "$key" > "$CACHE.$$" && mv -f "$CACHE.$$" "$CACHE"   # atomic: parallel threads can't tear it
elif [ -f "$CACHE" ]; then
  key="$(cat "$CACHE")"; echo "t3-facebook-cli: vault unreachable → cached meta key" >&2
fi
# keyless muse would quietly run on the `muse login` account instead
[ -n "$key" ] || { echo "t3-facebook-cli: no meta key (vault down, no cache). Vault one: /add-key meta <key>" >&2; exit 1; }
export META_API_KEY="$key"
exec "$REAL" "$@"
