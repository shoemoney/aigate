#!/usr/bin/env bash
# aigate-hydrate — fetch named provider keys from the aigate vault and write them
# as `export VAR=...` lines to ~/.claude/aigate/mcp-keys.env (mode 600), which the
# shell sources so ${BRAVE_API_KEY} / ${TAVILY_API_KEY} references in MCP-server
# configs resolve when claude launches. Keeps MCP secrets in the vault, out of the
# config JSON. Rotate a key in aigate -> re-run this -> new shells pick up the value.
# Fails OPEN (never breaks the shell if the vault/network is down).
#
# Add providers by extending PAIRS below (provider_id:ENV_VAR_NAME).
set -uo pipefail

ENVF="$HOME/.claude/aigate/env"
OUT="$HOME/.claude/aigate/mcp-keys.env"
PAIRS="brave:BRAVE_API_KEY tavily:TAVILY_API_KEY"

[ -f "$ENVF" ] && { set -a; . "$ENVF"; set +a; }
BASE="${AIGATE_URL:-https://aigate.shoemoney.ai}"
TOK="${AIGATE_TOKEN:-}"
[ -n "$TOK" ] || { echo "aigate-hydrate: no AIGATE_TOKEN, skipping" >&2; exit 0; }

tmp="$(mktemp)"; got=0
for pair in $PAIRS; do
  prov="${pair%%:*}"; var="${pair##*:}"
  key="$(curl -s -m5 -H "Authorization: Bearer $TOK" "$BASE/api/keys/$prov" \
        | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin); print(d.get("key","") if isinstance(d,dict) else "")
except Exception: print("")')"
  if [ -n "$key" ]; then printf 'export %s=%q\n' "$var" "$key" >> "$tmp"; got=$((got+1)); fi
done

if [ "$got" -gt 0 ]; then
  install -m 600 "$tmp" "$OUT"; echo "aigate-hydrate: wrote $got key(s) -> $OUT"
else
  echo "aigate-hydrate: 0 keys fetched (nothing written)" >&2
fi
rm -f "$tmp"
