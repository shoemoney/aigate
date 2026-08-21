# Branch Cleanup Manifest — todo/2026-08-14-*

**Date verified:** 2026-08-20 (after `git fetch --all --prune`)
**Repository:** aigate
**Analysis tool:** `git rev-list --count main..<branch>`

## Summary

- **Total todo/2026-08-14-* branches found:** 22 (across `origin` and `forgejo` remotes)
- **Fully merged (0 commits ahead of main), in the automated sweep:** 21 branches
- **Excluded from the sweep, requires human review:** 1 branch (+1 ahead)

## Branches in the automated sweep (0 commits ahead of main)

These are the branches the script (`scripts/prune-dead-todo-branches.sh`) actually
targets. Every count below was re-run fresh on 2026-08-20 after `git fetch --all --prune`;
the script re-checks each one again at run time before deleting anything.

| Branch | Ahead | Notes |
|--------|-------|-------|
| origin/todo/2026-08-14-aria-live-off-feed-never-announced | 0 | Fully merged |
| origin/todo/2026-08-14-body-aborted-deprecated | 0 | Fully merged |
| origin/todo/2026-08-14-broadcast-send-throws-500 | 0 | Fully merged |
| origin/todo/2026-08-14-catalog-60-docs-still-59 | 0 | Fully merged |
| origin/todo/2026-08-14-dead-export-isknownprovider | 0 | Fully merged |
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
| forgejo/todo/2026-08-14-dead-export-isknownprovider | 0 | Fully merged (duplicate of the origin branch of the same name) |

## Excluded — requires human review (NOT in the script's BRANCHES array)

### origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes — **Ahead: 1**

This branch carries **1 commit ahead of main** (`git rev-list --count
main..origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes` => `1`,
re-verified 2026-08-20). Because it is not 0-ahead, it is **excluded from the
BRANCHES array entirely** — it is never handed to the delete loop, so there is
no dependence on the runtime skip-guard to keep it safe.

**Commit:** `4cfb00b docs: list /api/board and /api/login in API table (mark board internal/unstable)`

**Content check (independent):** `git diff main...origin/todo/2026-08-14-docs-api-missing-board-and-auth-routes -- README.md`
shows the commit adds 24 lines of API-reference documentation for `/api/login`,
`/api/logout`, `/api/board` and its sub-routes, and the `AIGATE_DASHBOARD_PASSWORD` /
`AIGATE_SESSION_TTL_MS` env vars. Every one of those 24 added lines was found
**present on main verbatim** by direct `grep`, at:

```
README.md:391  | `POST` | `/api/login` · `/api/logout` | ...
README.md:392  | `GET` / `POST` | `/api/board` | ...
README.md:393  | `GET` | `/api/board/hosts` · `/api/board/workers` | ...
README.md:394  | `POST` | `/api/board/activity` · `/api/board/claim` · `/api/board/reorder` | ...
README.md:395  | `POST` / `PATCH` / `DELETE` | `/api/board/:id/*` | ...
README.md:420  AIGATE_DASHBOARD_PASSWORD definition
README.md:421  AIGATE_SESSION_TTL_MS definition
```

**Conclusion:** the content is genuinely already on main — but by a *different*
commit, not a fast-forward or a straight cherry-pick with the same hash, which
is why git still counts this branch as 1 ahead rather than 0. That discrepancy
(content present, count non-zero) is unexplained and is exactly the kind of
"looks fine, isn't quite" case this cleanup should not paper over. **This
branch is left out of the automated sweep.** A human should confirm the
content match themselves and either delete it directly
(`git push origin --delete todo/2026-08-14-docs-api-missing-board-and-auth-routes`)
or investigate further before it goes.

## How to review

1. Run the script in dry-run mode (default — no flag needed):
   ```bash
   bash scripts/prune-dead-todo-branches.sh
   ```

2. Review the output. It re-checks every branch's ahead-count live and prints
   exactly the `git push <remote> --delete <name>` command it would run for
   each one — nothing is inferred from this manifest at run time.

3. If confident, execute:
   ```bash
   bash scripts/prune-dead-todo-branches.sh --execute
   ```

## Safety notes

- The script re-checks ahead-count for every branch at run time via
  `git rev-list --count main..<branch>`; anything not exactly `0` is skipped,
  regardless of what this manifest says.
- `git push <remote> --delete` requires the **remote-side ref name** (e.g.
  `todo/2026-08-14-foo`), not the remote-tracking name (e.g.
  `origin/todo/2026-08-14-foo`). The script strips the remote prefix before
  pushing, and derives which remote to push to from that same prefix — so the
  `forgejo/...` entry is pushed to `forgejo`, not assumed to be `origin`.
- Delete results are checked by exit code; a failed delete prints git's real
  stderr and is counted as skipped, never silently counted as deleted.
- Only remote branches are touched. No local branches are affected.
