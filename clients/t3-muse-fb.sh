#!/usr/bin/env bash
# T3 Code → the REAL Muse Code CLI (T3 native "muse" driver) on the FB/meta key from
# aigate's vault instead of the `muse login` OAuth session. Muse honors META_API_KEY
# over its stored login, but T3 strips that var from the env it hands muse, so it
# has to be set here. Set as the muse instance "Binary path" in T3 Code.
set -u
for c in "${MUSE_BIN:-}" "$HOME/.local/bin/muse" /opt/homebrew/bin/muse /usr/local/bin/muse; do
  [ -n "$c" ] && [ -x "$c" ] && REAL="$c" && break
done
[ -n "${REAL:-}" ] || { echo "t3-muse-fb: no muse binary found" >&2; exit 127; }

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
  key="$(cat "$CACHE")"; echo "t3-muse-fb: vault unreachable → cached meta key" >&2
fi
[ -n "$key" ] || { echo "t3-muse-fb: no meta key (vault down, no cache). Vault one: /add-key meta <key>" >&2; exit 1; }
export META_API_KEY="$key"
exec "$REAL" "$@"
