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
exec "$HOME/.claude/aigate/aigate-run.sh" "$@"
EOF
chmod 0755 "$BIN/cc"

echo "installed: $BIN/cc  →  $DIR/aigate-run.sh  (claude: ${CLAUDE_BIN:-not found in PATH})"
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "NOTE: add to PATH →  export PATH=\"$BIN:\$PATH\"";; esac
echo "NOTE: 'cc' shadows the C compiler in shells where $BIN precedes /usr/bin. Rename if you compile with cc."
