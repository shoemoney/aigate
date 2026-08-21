#!/bin/bash
#
# prune-dead-todo-branches.sh — safely delete fully-merged todo/2026-08-14-* branches
#
# BRANCH MANIFEST (verified 2026-08-20, re-verified after fetch --all --prune):
# 21 of the 22 todo/2026-08-14-* remote branches are 0 commits ahead of main.
# The 22nd — origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes — is
# 1 commit ahead and is DELIBERATELY EXCLUDED from BRANCHES below. See the
# "EXCLUDED — REQUIRES HUMAN REVIEW" section further down and PRUNE_MANIFEST.md
# for the full analysis.
#
# Usage:
#   bash prune-dead-todo-branches.sh              # dry-run (default, prints what would delete)
#   bash prune-dead-todo-branches.sh --execute    # actually delete the branches
#
# Safety:
#   - Re-checks ahead-count for every branch at RUN time via `git rev-list --count
#     main..<branch>`. Any branch found to be >0 commits ahead of main is skipped,
#     even though the list below was pre-filtered to 0-ahead branches only.
#   - `git push <remote> --delete` takes the REMOTE-SIDE ref name (e.g.
#     "todo/2026-08-14-foo"), NOT the remote-tracking ref name (e.g.
#     "origin/todo/2026-08-14-foo"). The remote-tracking name is used for the
#     rev-list/rev-parse checks; the remote prefix is stripped before push, and
#     the remote to push to is derived from that same prefix (so a
#     "forgejo/..." entry pushes to forgejo, never assumed to be origin).
#   - Delete result is checked via exit code. DELETED_COUNT is only incremented
#     on a verified successful delete; failures print git's real stderr.
#
# EXCLUDED — REQUIRES HUMAN REVIEW (do NOT add to BRANCHES):
#   origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes
#     +1 commit ahead of main (git rev-list --count main..<branch> => 1).
#     Its single commit (4cfb00b) adds 24 lines of README documentation for
#     /api/login, /api/board*, AIGATE_DASHBOARD_PASSWORD, AIGATE_SESSION_TTL_MS.
#     Diffed independently against current main: all 24 lines are present on
#     main VERBATIM (README.md:391,392,393,394,395,420,421) — but via a
#     different commit, so git still counts this branch as 1 ahead. Because the
#     content appears to already be captured, but the ahead-count itself is
#     real and unexplained (different commit hash = not a straight merge), this
#     branch is left out of the automated sweep entirely. A human should decide
#     whether to delete it directly or investigate the discrepancy first.
#

set -uo pipefail

DRY_RUN=true
if [[ "${1:-}" == "--execute" ]]; then
  DRY_RUN=false
fi

# BRANCHES TO DELETE (pre-filtered to 0 commits ahead of main; re-checked at
# runtime below regardless). Remote-tracking form: <remote>/<branch-name>.
BRANCHES=(
  "origin/todo/2026-08-14-aria-live-off-feed-never-announced"
  "origin/todo/2026-08-14-body-aborted-deprecated"
  "origin/todo/2026-08-14-broadcast-send-throws-500"
  "origin/todo/2026-08-14-catalog-60-docs-still-59"
  "origin/todo/2026-08-14-dead-export-isknownprovider"
  "origin/todo/2026-08-14-env-defaults-nan"
  "origin/todo/2026-08-14-flaky-signsession-verify-test"
  "origin/todo/2026-08-14-harness-403-gate-untested"
  "origin/todo/2026-08-14-hydrate-pairs-catalog-mismatch"
  "origin/todo/2026-08-14-inconsistent-oversized-connection-close"
  "origin/todo/2026-08-14-ipallowed-empty-bits-becomes-allow-all"
  "origin/todo/2026-08-14-key-hint-collision"
  "origin/todo/2026-08-14-limit-clamp-tautology"
  "origin/todo/2026-08-14-oversized-guards-incomplete-remaining-routes"
  "origin/todo/2026-08-14-poll-phantom-zero"
  "origin/todo/2026-08-14-provider-id-allows-slash"
  "origin/todo/2026-08-14-secrets-json-missing-no-store-headers"
  "origin/todo/2026-08-14-stats-ts-full-scan-no-index"
  "origin/todo/2026-08-14-workers-map-never-swept-unbounded"
  "origin/todo/2026-08-14-ws-reconnect-fixed-delay-no-backoff"
  "forgejo/todo/2026-08-14-dead-export-isknownprovider"
)

if [[ "$DRY_RUN" == true ]]; then
  echo "DRY RUN: Would delete the following branches (re-checking ahead-count first):"
  echo ""
fi

DELETED_COUNT=0
SKIPPED_COUNT=0
WOULD_DELETE_COUNT=0

for branch in "${BRANCHES[@]}"; do
  # Skip if remote-tracking ref doesn't exist locally (already deleted, or
  # this checkout hasn't fetched it).
  if ! git rev-parse --verify "$branch" >/dev/null 2>&1; then
    echo "⊘ $branch (remote-tracking ref not found — already deleted, or run 'git fetch --all --prune' first)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Re-check ahead-count at runtime — never trust the hardcoded list alone.
  ahead=$(git rev-list --count main.."$branch" 2>/dev/null) || ahead="ERR"

  if [[ "$ahead" != "0" ]]; then
    echo "⊘ SKIPPED (not 0 commits ahead): $branch (+$ahead commits)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Split "<remote>/<branch-name>" into remote + the remote-side ref name.
  # `git push <remote> --delete` needs the SHORT name (no remote prefix) —
  # pushing the remote-tracking name fails with "remote ref does not exist".
  remote="${branch%%/*}"
  short_name="${branch#*/}"

  if [[ "$DRY_RUN" == true ]]; then
    echo "  ✓ $branch  (would run: git push $remote --delete \"$short_name\")"
    WOULD_DELETE_COUNT=$((WOULD_DELETE_COUNT + 1))
  else
    push_err=$(git push "$remote" --delete "$short_name" 2>&1)
    push_status=$?
    if [[ $push_status -eq 0 ]]; then
      echo "✓ Deleted: $branch"
      DELETED_COUNT=$((DELETED_COUNT + 1))
    else
      echo "✗ FAILED to delete: $branch (exit $push_status)"
      echo "$push_err" | sed 's/^/    /'
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    fi
  fi
done

echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "DRY RUN SUMMARY: Would delete $WOULD_DELETE_COUNT branches"
  if [[ "$SKIPPED_COUNT" -gt 0 ]]; then
    echo "Would skip $SKIPPED_COUNT branches (not fully merged / not found)"
  fi
  echo ""
  echo "Excluded from this list entirely (requires separate human review):"
  echo "  origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes (+1 ahead)"
  echo ""
  echo "To execute, run: bash prune-dead-todo-branches.sh --execute"
else
  echo "EXECUTION SUMMARY: Deleted $DELETED_COUNT branches"
  if [[ "$SKIPPED_COUNT" -gt 0 ]]; then
    echo "Skipped $SKIPPED_COUNT branches (not fully merged / not found / delete failed)"
  fi
fi
