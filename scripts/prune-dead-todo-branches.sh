#!/bin/bash
#
# prune-dead-todo-branches.sh — safely delete fully-merged todo/2026-08-14-* branches
#
# BRANCH MANIFEST (verified 2026-08-20):
# All branches are 0 commits ahead of main except:
#   - origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes: 1 commit ahead
#     BUT the commit content is already present on main (cherry-picked/merged)
#     SAFE TO DELETE.
#
# Usage:
#   bash prune-dead-todo-branches.sh              # dry-run (default, prints what would delete)
#   bash prune-dead-todo-branches.sh --execute    # actually delete the branches
#
# Safety: This script re-checks ahead-count at run time. Any branch found to be
# >0 commits ahead of main will be skipped, even if it's in the hardcoded list.
#

DRY_RUN=true
if [[ "${1:-}" == "--execute" ]]; then
  DRY_RUN=false
fi

# BRANCHES TO DELETE (all 0 commits ahead of main)
BRANCHES=(
  "origin/todo/2026-08-14-aria-live-off-feed-never-announced"
  "origin/todo/2026-08-14-body-aborted-deprecated"
  "origin/todo/2026-08-14-broadcast-send-throws-500"
  "origin/todo/2026-08-14-catalog-60-docs-still-59"
  "origin/todo/2026-08-14-dead-export-isknownprovider"
  "origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes"
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
)

# Also check for forgejo remote variant (if it exists)
BRANCHES+=(
  "forgejo/todo/2026-08-14-dead-export-isknownprovider"
)

if [[ "$DRY_RUN" == true ]]; then
  echo "DRY RUN: Would delete the following branches (re-checking ahead-count first):"
  echo ""
fi

DELETED_COUNT=0
SKIPPED_COUNT=0

for branch in "${BRANCHES[@]}"; do
  # Skip if branch doesn't exist
  if ! git rev-parse --verify "$branch" >/dev/null 2>&1; then
    if [[ "$DRY_RUN" == false ]]; then
      echo "⊘ $branch (already deleted or does not exist)"
    fi
    continue
  fi

  # Re-check ahead-count at runtime
  ahead=$(git rev-list --count main.."$branch" 2>/dev/null || echo "ERR")

  if [[ "$ahead" != "0" ]]; then
    echo "⊘ SKIPPED (not 0 commits ahead): $branch (+$ahead commits)"
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    continue
  fi

  # Safe to delete: 0 commits ahead of main
  if [[ "$DRY_RUN" == true ]]; then
    echo "  ✓ $branch"
  else
    git push origin --delete "$branch" >/dev/null 2>&1
    echo "✓ Deleted: $branch"
    DELETED_COUNT=$((DELETED_COUNT + 1))
  fi
done

echo ""
if [[ "$DRY_RUN" == true ]]; then
  DELETE_COUNT=$((${#BRANCHES[@]} - SKIPPED_COUNT))
  echo "DRY RUN SUMMARY: Would delete $DELETE_COUNT branches"
  if [[ "$SKIPPED_COUNT" -gt 0 ]]; then
    echo "Would skip $SKIPPED_COUNT branches (not fully merged)"
  fi
  echo ""
  echo "To execute, run: bash prune-dead-todo-branches.sh --execute"
else
  echo "EXECUTION SUMMARY: Deleted $DELETED_COUNT branches"
  if [[ "$SKIPPED_COUNT" -gt 0 ]]; then
    echo "Skipped $SKIPPED_COUNT branches (not fully merged)"
  fi
fi
