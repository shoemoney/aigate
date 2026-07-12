#!/usr/bin/env bash
# fleet-push.sh — push aigate CLIENT updates to the Mac fleet and re-run install.sh.
#
#   bash clients/fleet-push.sh                       # default boxes
#   AIGATE_BOXES="192.168.1.3 192.168.1.7" bash clients/fleet-push.sh
#
# Per box: if ~/Projects/aigate exists there, `git pull` + run its install.sh;
# otherwise tar THIS clients/ dir over ssh into a tmpdir and run install.sh from it.
# .10 (prod docker) is NOT a client box — see the note at the end.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
BOXES="${AIGATE_BOXES:-192.168.1.3 192.168.1.4 192.168.1.5}"
# local short-sha of THIS checkout — passed to the tar-path remote install (git-less
# tmpdir there can't rev-parse); empty if this side isn't a git checkout either.
SHA="$(git -C "$SRC/.." rev-parse --short HEAD 2>/dev/null || true)"

for host in $BOXES; do
  echo "=== $host ==="
  # always pipe the local clients/ tarball; the git-pull branch drains+ignores it.
  if tar -czf - -C "$SRC" . | ssh -o ConnectTimeout=6 "$host" '
    set -e
    if [ -d "$HOME/Projects/aigate/.git" ]; then
      cat >/dev/null                         # drain the piped tarball, use the checkout
      git -C "$HOME/Projects/aigate" pull -q origin main
      bash "$HOME/Projects/aigate/clients/install.sh"
    else
      d="$(mktemp -d)"; trap "rm -rf \"$d\"" EXIT
      tar -xzf - -C "$d"
      AIGATE_VERSION='"$SHA"' bash "$d/install.sh"
    fi
  '; then
    v="$(ssh -o ConnectTimeout=6 "$host" 'cat "$HOME/.claude/aigate/version" 2>/dev/null' || true)"
    echo "$host: version=${v:-unknown}"
  else
    echo "$host: FAILED"
  fi
done

echo
echo "NOTE: .10 (TrueNAS prod docker) is NOT a client box — update it separately with:"
echo "  ssh 192.168.1.10 'cd /mnt/tank/apps/aigate && sudo git pull origin main && sudo docker compose up -d --build'"
