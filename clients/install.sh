#!/usr/bin/env bash
# aigate client installer: sets up `ai` / `ai-desktop`, which route the official
# claude and codex binaries through aigate's account selector.
#
#   AIGATE_URL=https://aigate… AIGATE_TOKEN=… bash install.sh
#   bash install.sh                       # re-install: reads secrets from the saved env
#
# Installs:  ~/.claude/aigate/{aigate-*.sh,t3-*.sh,cmux-claude.sh,env,version}  and  ~/.local/bin/{ai,ai-desktop}
# (AIGATE_INSTALL_ROOT=/some/dir installs under that dir instead of $HOME)
set -euo pipefail
# re-install needs no secrets on the CLI: source the persisted env first so the
# required-var checks pass. first install (no env file yet) still demands the token.
[ -f "${AIGATE_INSTALL_ROOT:-$HOME}/.claude/aigate/env" ] && { set -a; . "${AIGATE_INSTALL_ROOT:-$HOME}/.claude/aigate/env"; set +a; }
: "${AIGATE_URL:?set AIGATE_URL}"; : "${AIGATE_TOKEN:?set AIGATE_TOKEN}"
SRC="$(cd "$(dirname "$0")" && pwd)"
# AIGATE_INSTALL_ROOT lets tests (and sandboxes) install into a scratch dir
ROOT="${AIGATE_INSTALL_ROOT:-$HOME}"
DIR="$ROOT/.claude/aigate"; BIN="$ROOT/.local/bin"
mkdir -p "$DIR" "$BIN"

# version stamp — repo short-sha of the source checkout (best-effort); a git-less
# tar-path install falls back to AIGATE_VERSION passed through by fleet-push.
VER="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || true)"
[ -n "$VER" ] || VER="${AIGATE_VERSION:-}"
printf '%s\n' "$VER" > "$DIR/version"

# the rc file zsh ACTUALLY sources is ZDOTDIR-based (the .10 trap: $HOME/.zshrc is
# never read there). pick by ZDOTDIR, not by which file happens to exist.
ZRC="${ZDOTDIR:-$ROOT}/.zshrc"
mkdir -p "$(dirname "$ZRC")"
[ -f "$ZRC" ] || : > "$ZRC"

install -m 0755 "$SRC/aigate-run.sh" "$DIR/aigate-run.sh"
for f in aigate-kimi.sh aigate-muse.sh aigate-codex.sh prompt-hook.sh statusline-feed.sh hydrate.sh \
         t3-claude.sh t3-codex.sh t3-opencode.sh t3-anthropic-compat.sh cmux-claude.sh; do
  [ -f "$SRC/$f" ] && install -m 0755 "$SRC/$f" "$DIR/$f" || true
done
# every non-Anthropic T3 rung is the same script dispatched on its invocation name
for n in kimi muse facebook qwen openrouter aigate; do
  ln -sfn t3-anthropic-compat.sh "$DIR/t3-$n.sh"
done
# aigate-gpt.sh (the CPA-era codex shim) is retired: aigate-codex.sh replaces it.
# Move it aside instead of deleting.
if [ -e "$DIR/aigate-gpt.sh" ]; then
  mv "$DIR/aigate-gpt.sh" "$DIR/aigate-gpt.sh.bak-removed-$(date +%Y%m%d-%H%M%S)"
  echo "retired aigate-gpt.sh (moved to .bak-removed-*)"
fi

# Codex keeper (macOS): hourly `aigate-codex.sh --keep` keeps ~/.codex/auth.json in step
# with the vault so a long-lived codex (ChatGPT.app, T3) reloads the vault's rotated
# token instead of spending a dead one. The plist always lands under $ROOT; launchctl is
# only touched for a real install (not AIGATE_NO_LAUNCHD=1, not a scratch AIGATE_INSTALL_ROOT).
if [ "$(uname -s)" = "Darwin" ]; then
  KLABEL="ai.shoemoney.aigate-codex-keeper"
  KPLIST="$ROOT/Library/LaunchAgents/$KLABEL.plist"
  mkdir -p "$ROOT/Library/LaunchAgents"
  cat > "$KPLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$KLABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$DIR/aigate-codex.sh</string>
    <string>--keep</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$DIR/codex-keeper.log</string>
  <key>StandardErrorPath</key><string>$DIR/codex-keeper.log</string>
</dict>
</plist>
EOF
  chmod 644 "$KPLIST"
  if [ "${AIGATE_NO_LAUNCHD:-0}" != 1 ] && [ -z "${AIGATE_INSTALL_ROOT:-}" ]; then
    UIDN="$(id -u)"
    launchctl bootout "gui/$UIDN/$KLABEL" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$UIDN" "$KPLIST" >/dev/null 2>&1 \
      && echo "loaded launchd agent $KLABEL (hourly codex keeper)" \
      || echo "NOTE: could not load $KLABEL — run: launchctl bootstrap gui/$UIDN $KPLIST" >&2
  fi
fi

CLAUDE_BIN=""
for p in "$ROOT/.local/bin/claude" /usr/bin/claude /usr/local/bin/claude /opt/homebrew/bin/claude; do
  [ -x "$p" ] && CLAUDE_BIN="$p" && break
done

umask 077
cat > "$DIR/env" <<EOF
AIGATE_URL=$AIGATE_URL
AIGATE_TOKEN=$AIGATE_TOKEN
${CLAUDE_BIN:+AIGATE_CLAUDE_BIN=$CLAUDE_BIN}
EOF

# `ai` (routes claude / codex / kimi / muse through aigate) and `ai-desktop` live in BIN.
install -m 0755 "$SRC/ai" "$BIN/ai"
[ -f "$SRC/ai-desktop" ] && install -m 0755 "$SRC/ai-desktop" "$BIN/ai-desktop" || true
# the old `cc` this installer used to write: remove ONLY if it is still our own text
# (a user's own `cc` -- or the C compiler -- is never touched).
if [ -f "$BIN/cc" ] && grep -q '^# cc — run claude through aigate' "$BIN/cc" 2>/dev/null; then
  rm -f "$BIN/cc"; echo "removed the old installer-written $BIN/cc (use ai)"
fi

# reap the legacy cc.zsh shadow: older installs defined `cc` as a zsh FUNCTION
# (sourced from an rc line) that shadowed the installed binary. it isn't written
# by this installer, so its presence means a stale shell-function override.
if [ -f "$DIR/cc.zsh" ]; then
  rm -f "$DIR/cc.zsh"
  for rc in "$ROOT/.zshrc" "$ROOT/.config/zsh/.zshrc" "$ZRC"; do
    [ -f "$rc" ] && { sed -i.bak '/aigate\/cc.zsh/d' "$rc"; rm -f "$rc.bak"; }
  done
  echo "removed legacy cc.zsh shell-function shadow"
fi

# wire the hooks into settings.json — they're installed above but nothing
# references them on a fresh box (dead on every clean install). idempotent
# python3 merge: dedupe on the command string so re-runs never double-add.
SETTINGS="$ROOT/.claude/settings.json"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak" || true
python3 - "$SETTINGS" <<'PY'
import json, sys
p = sys.argv[1]
try:
    with open(p) as f: s = json.load(f)
except Exception:
    s = {}
if not isinstance(s, dict): s = {}
PROMPT = "bash ~/.claude/aigate/prompt-hook.sh"
STATUS = "bash ~/.claude/aigate/statusline-feed.sh"
hooks = s.setdefault("hooks", {})
ups = hooks.setdefault("UserPromptSubmit", [])
if not isinstance(ups, list): ups = s["hooks"]["UserPromptSubmit"] = []
have = any(
    isinstance(h, dict) and h.get("command") == PROMPT
    for grp in ups if isinstance(grp, dict)
    for h in (grp.get("hooks") or []))
if not have:
    ups.append({"hooks": [{"type": "command", "command": PROMPT}]})
sl = s.get("statusLine")
if sl is None:
    s["statusLine"] = {"type": "command", "command": STATUS}
elif not (isinstance(sl, dict) and sl.get("command") == STATUS):
    print("note: keeping your existing custom statusLine (not clobbering)", file=sys.stderr)
with open(p, "w") as f:
    json.dump(s, f, indent=2)
PY
echo "wired hooks into $SETTINGS"

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
  # hydrate.sh writes under the real $HOME — skip it for a scratch install root
  [ "$ROOT" = "$HOME" ] && { "$DIR/hydrate.sh" >/dev/null 2>&1 || true; }
  if ! grep -q 'aigate/mcp.zsh' "$ZRC" 2>/dev/null; then
    printf '\n[ -f "$HOME/.claude/aigate/mcp.zsh" ] && source "$HOME/.claude/aigate/mcp.zsh"  # aigate mcp keys\n' >> "$ZRC"
    echo "wired MCP-key hydration into $ZRC"
  fi
  echo "MCP hydration ready. Register servers with vault-backed keys, e.g.:"
  echo "  claude mcp add -s user brave-search --env BRAVE_API_KEY='\${BRAVE_API_KEY}' -- npx -y @brave/brave-search-mcp-server"
  echo "  claude mcp add -s user tavily        --env TAVILY_API_KEY='\${TAVILY_API_KEY}' -- npx -y tavily-mcp"
fi

echo "installed: $BIN/ai (+ ai-desktop)  ->  $DIR/aigate-{run,codex,kimi,muse}.sh  (claude: ${CLAUDE_BIN:-not found in PATH})  [aigate ${VER:-unknown}]"
case ":$PATH:" in *":$BIN:"*) : ;; *) echo "NOTE: add to PATH ->  export PATH=\"$BIN:\$PATH\"";; esac
