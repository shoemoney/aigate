# Bee1 deployment and Linux client portability

The operator authorized moving Aigate to a lightweight bee box, registering the
manually supplied UniFi gateway credential, and documenting the six LAN servers
in Notion. Preserve all concurrent work and keep credentials out of source,
review briefs, logs and documentation.

## Phase 1: preserve and inspect

- Use bee1 (`192.168.1.21`), verified idle before deployment.
- Preserve the source `.env` encryption key, database and sidecars, complete
  capture/replay directories, audited backups, and separate Codex ledger.
- Old backups must contain no purged credentials. Preserve the newly authorized
  UniFi credential; do not repeat the old credential purge.
- Keep the NAS instance stopped to maintain one credential refresh owner.
- Preserve the separate UniFi implementation worktree. This review branch starts
  from its pinned commit `6863accdd846591206d44efa0f8e7c05df83204b`.

## Phase 2: Linux compatibility and source review

- Fix the identical binary resolver blocks in `clients/ai`,
  `clients/aigate-codex.sh`, and `clients/t3-codex-cli.sh` so failed BSD `stat`
  output cannot contaminate the GNU fallback's cache key.
- Keep Bash 3.2 compatibility and retain the existing cache and launcher tests.
- Run ShellCheck and the full unchanged test suite on the target Linux runtime,
  using an executable temporary filesystem and the CLI test dependencies.
- Obtain two fresh independent final-commit reviews covering the full increment
  from `74be18140b64e73b9efc5462407526c1e05ed451`, including the UniFi changes.
- Do not cut over with unresolved failures, blockers or majors.

## Phase 3: operational acceptance

- Compare source/destination file manifests before opening the copied database.
- Verify the vault canary and UniFi credential internally without printing them.
- Configure private, distinct administrator and proxy keys as required; retain
  existing encryption and dashboard configuration.
- Preserve automatic restart and unhealthy-container recovery on bee1.
- Change only Aigate's reverse-proxy upstream after backend acceptance. Verify
  public HTTPS, streaming/authentication behavior, and neighboring proxy hosts.
- Verify restart persistence. Update the handoff, skills and private Notion
  inventory; distinguish verified hosts from unreachable Ramsey.

Source remains local unless separately published. Existing authorization covers
this deployment; it does not authorize unrelated application or network changes.
