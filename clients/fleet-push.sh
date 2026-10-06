#!/usr/bin/env bash
# fleet-push.sh — push aigate CLIENT updates to the Mac fleet and re-run install.sh.
#
#   bash clients/fleet-push.sh                       # default boxes
#   AIGATE_BOXES="192.168.1.3 192.168.1.7" bash clients/fleet-push.sh
#
# Per box: a CLEAN ~/Projects/aigate checkout is fast-forwarded (forgejo remote first —
# prod's source of truth — else origin) and its install.sh runs; a dirty checkout, a
# failed pull, or no checkout installs from THIS clients/ dir, tarred over ssh. A dirty
# tree is never touched: .4/.5 carried ~80 uncommitted files and only a forgejo remote
# (2026-10-06), so the old unconditional `pull origin main` failed there every time.
# .10 (prod docker) is NOT a client box — see the note at the end.
set -u
SRC="$(cd "$(dirname "$0")" && pwd)"
BOXES="${AIGATE_BOXES:-192.168.1.3 192.168.1.4 192.168.1.5 192.168.1.7}"
# local short-sha of THIS checkout — passed to the tar-path remote install (git-less
# tmpdir there can't rev-parse); empty if this side isn't a git checkout either.
SHA="$(git -C "$SRC/.." rev-parse --short HEAD 2>/dev/null || true)"

for host in $BOXES; do
  echo "=== $host ==="
  # always pipe the local clients/ tarball and unpack it first — it is the fallback
  # whenever the box's checkout can't be fast-forwarded cleanly.
  if tar -czf - -C "$SRC" . | ssh -o ConnectTimeout=6 "$host" '
    set -e
    d="$(mktemp -d)"; trap "rm -rf \"$d\"" EXIT
    tar -xzf - -C "$d"
    R="$HOME/Projects/aigate"
    if [ -d "$R/.git" ] && [ -z "$(git -C "$R" status --porcelain 2>/dev/null)" ]; then
      rem=origin; git -C "$R" remote | grep -qx forgejo && rem=forgejo
      if git -C "$R" pull -q --ff-only "$rem" main; then
        bash "$R/clients/install.sh"; exit 0
      fi
      echo "checkout pull from $rem failed — installing from the pushed clients/ instead" >&2
    elif [ -d "$R/.git" ]; then
      echo "checkout at $R has uncommitted changes — left untouched, installing from the pushed clients/" >&2
    fi
    AIGATE_VERSION='"$SHA"' bash "$d/install.sh"
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
