#!/usr/bin/env bash
# aigate client installer — sets up the `cc` command that routes the official
# claude binary through aigate's account selector.
#
#   AIGATE_URL=https://aigate… AIGATE_TOKEN=… bash install.sh
#
# Installs:  ~/.claude/aigate/{aigate-run.sh,env}  and  ~/.local/bin/cc
set -euo pipefail
: "${AIGATE_URL:?set AIGATE_URL}"; : "${AIGATE_TOKEN:?set AIGATE_TOKEN}"
SRC="$(cd "$(dirname "$0")" && pwd)"
DIR="$HOME/.claude/aigate"; BIN="$HOME/.local/bin"
mkdir -p "$DIR" "$BIN"

install -m 0755 "$SRC/aigate-run.sh" "$DIR/aigate-run.sh"
[ -f "$SRC/prompt-hook.sh" ]     && install -m 0755 "$SRC/prompt-hook.sh"     "$DIR/prompt-hook.sh"     || true
[ -f "$SRC/statusline-feed.sh" ] && install -m 0755 "$SRC/statusline-feed.sh" "$DIR/statusline-feed.sh" || true
[ -f "$SRC/hydrate.sh" ]         && install -m 0755 "$SRC/hydrate.sh"         "$DIR/hydrate.sh"         || true

CLAUDE_BIN=""
for p in "$HOME/.local/bin/claude" /usr/bin/claude /usr/local/bin/claude /opt/homebrew/bin/claude; do
  [ -x "$p" ] && CLAUDE_BIN="$p" && break
done

umask 077
cat > "$DIR/env" <<EOF
AIGATE_URL=$AIGATE_URL
AIGATE_TOKEN=$AIGATE_TOKEN
${CLAUDE_BIN:+AIGATE_CLAUDE_BIN=$CLAUDE_BIN}
EOF

cat > "$BIN/cc" <<'EOF'
#!/usr/bin/env bash
# cc — run claude through aigate (account picked by the warden).
set -a; . "$HOME/.claude/aigate/env"; set +a
# freshen MCP keys in-foreground when missing/stale so THIS launch resolves ${VAR}s
MK="$HOME/.claude/aigate/mcp-keys.env"
if [ ! -f "$MK" ] || [ -n "$(find "$MK" -mmin +720 2>/dev/null)" ]; then
  "$HOME/.claude/aigate/hydrate.sh" >/dev/null 2>&1 || true
fi
[ -f "$MK" ] && . "$MK"
exec "$HOME/.claude/aigate/aigate-run.sh" "$@"
EOF
chmod 0755 "$BIN/cc"

# MCP-key hydration: a sourced shell hook that pulls vault keys into the shell env
# so ${BRAVE_API_KEY}/${TAVILY_API_KEY} in MCP-server configs resolve at claude launch.
if [ -f "$DIR/hydrate.sh" ]; then
  cat > "$DIR/mcp.zsh" <<'EOF'
# aigate: hydrate MCP-server keys from the vault into this shell's env so
# ${BRAVE_API_KEY}/${TAVILY_API_KEY} in MCP configs resolve when claude launches.
[ -f "$HOME/.claude/aigate/mcp-keys.env" ] && source "$HOME/.claude/aigate/mcp-keys.env"
if [ ! -f "$HOME/.claude/aigate/mcp-keys.env" ] || [ -n "$(find "$HOME/.claude/aigate/mcp-keys.env" -mmin +720 2>/dev/null)" ]; then
  ( "$HOME/.claude/aigate/hydrate.sh" >/dev/null 2>&1 & ) 2>/dev/null
fi
EOF
  "$DIR/hydrate.sh" >/dev/null 2>&1 || true
  ZRC="$HOME/.zshrc"; [ -f "$HOME/.config/zsh/.zshrc" ] && ZRC="$HOME/.config/zsh/.zshrc"
  if ! grep -q 'aigate/mcp.zsh' "$ZRC" 2>/dev/null; then
    printf '\n[ -f "$HOME/.claude/aigate/mcp.zsh" ] && source "$HOME/.claude/aigate/mcp.zsh"  # aigate mcp keys\n' >> "$ZRC"
    echo "wired MCP-key hydration into $ZRC"
  fi
  echo "MCP hydration ready. Register servers with vault-backed keys, e.g.:"
  echo "  claude mcp add -s user brave-search --env BRAVE_API_KEY='\${BRAVE_API_KEY}' -- npx -y @brave/brave-search-mcp-server"
  echo "  claude mcp add -s user tavily        --env TAVILY_API_KEY='\${TAVILY_API_KEY}' -- npx -y tavily-mcp"
fi

echo "installed: $BIN/cc  →  $DIR/aigate-run.sh  (claude: ${CLAUDE_BIN:-not found in PATH})"
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "NOTE: add to PATH →  export PATH=\"$BIN:\$PATH\"";; esac
echo "NOTE: 'cc' shadows the C compiler in shells where $BIN precedes /usr/bin. Rename if you compile with cc."
