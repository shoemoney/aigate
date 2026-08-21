# Branch Cleanup Manifest — todo/2026-08-14-*

**Date Verified:** 2026-08-20  
**Repository:** aigate  
**Analysis Tool:** git rev-list --count main..BRANCH

## Summary

- **Total branches:** 22 todo/2026-08-14-* branches across origin and forgejo remotes
- **Fully merged (0 commits ahead of main):** 21 branches
- **Requires review (>0 commits ahead):** 1 branch

## Detailed Branch Status

All branches listed below are **safe to delete** (0 commits ahead of main):

| Branch | Ahead | Notes |
|--------|-------|-------|
| origin/todo/2026-08-14-aria-live-off-feed-never-announced | 0 | Fully merged |
| origin/todo/2026-08-14-body-aborted-deprecated | 0 | Fully merged |
| origin/todo/2026-08-14-broadcast-send-throws-500 | 0 | Fully merged |
| origin/todo/2026-08-14-catalog-60-docs-still-59 | 0 | Fully merged |
| origin/todo/2026-08-14-dead-export-isknownprovider | 0 | Fully merged |
| origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes | 0* | See note below |
| origin/todo/2026-08-14-env-defaults-nan | 0 | Fully merged |
| origin/todo/2026-08-14-flaky-signsession-verify-test | 0 | Fully merged |
| origin/todo/2026-08-14-harness-403-gate-untested | 0 | Fully merged |
| origin/todo/2026-08-14-hydrate-pairs-catalog-mismatch | 0 | Fully merged |
| origin/todo/2026-08-14-inconsistent-oversized-connection-close | 0 | Fully merged |
| origin/todo/2026-08-14-ipallowed-empty-bits-becomes-allow-all | 0 | Fully merged |
| origin/todo/2026-08-14-key-hint-collision | 0 | Fully merged |
| origin/todo/2026-08-14-limit-clamp-tautology | 0 | Fully merged |
| origin/todo/2026-08-14-oversized-guards-incomplete-remaining-routes | 0 | Fully merged |
| origin/todo/2026-08-14-poll-phantom-zero | 0 | Fully merged |
| origin/todo/2026-08-14-provider-id-allows-slash | 0 | Fully merged |
| origin/todo/2026-08-14-secrets-json-missing-no-store-headers | 0 | Fully merged |
| origin/todo/2026-08-14-stats-ts-full-scan-no-index | 0 | Fully merged |
| origin/todo/2026-08-14-workers-map-never-swept-unbounded | 0 | Fully merged |
| origin/todo/2026-08-14-ws-reconnect-fixed-delay-no-backoff | 0 | Fully merged |
| forgejo/todo/2026-08-14-dead-export-isknownprovider | 0 | Fully merged (duplicate) |

## Special Case: docs-api-missing-board-and-auth-routes

Initially reported as 1 commit ahead of main. Upon inspection:

**Commit:** `4cfb00b docs: list /api/board and /api/login in API table (mark board internal/unstable)`

**Analysis:** The commit adds documentation for `/api/board` and `/api/login` endpoints. These lines were verified to be **already present on main**:

```
README.md:391  | `POST` | `/api/login` · `/api/logout` | ...
README.md:394  | `POST` | `/api/board/activity` · `/api/board/claim` ...
README.md:416-421  AIGATE_DASHBOARD_PASSWORD and AIGATE_SESSION_TTL_MS definitions
```

**Conclusion:** The content has been cherry-picked or the branch was based on an older main. **This branch is safe to delete.**

## How to Review

1. Run the script in dry-run mode:
   ```bash
   bash scripts/prune-dead-todo-branches.sh
   ```

2. Review the output to confirm which branches would be deleted

3. If confident, execute:
   ```bash
   bash scripts/prune-dead-todo-branches.sh --execute
   ```

## Safety Notes

- The script re-checks ahead-count for each branch at runtime
- Any branch found to be >0 commits ahead of main will be skipped
- The script uses `git push origin --delete` (safe, non-destructive at the local level)
- No local branches are affected by this cleanup
