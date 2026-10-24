# Provider setup scripts

Build on transproxy in its existing isolated worktree. Preserve the original
checkout and its unrelated edits. No real logins, credential reads, production
changes, publication or deployment during implementation.

User requested executable files in setupscripts named exactly
<provider>_aigate_setup_script, repeated account setup and automatic removal of
temporary local credentials. Cover Codex, Claude Code, Muse, Kimi Code, Grok,
AWS with multiple fields, fal, Replicate, OpenRouter and all catalog/known prior
provider IDs. Manual operator action is the only source of credentials.

## Phase 1 - catalog and interface

- [x] Derive provider choices from src/providers.js plus existing client IDs.
- [x] Add exact-name executable launchers with one shared Node24 runner.
- [x] Model API keys, AWS fields, cloud bundles and native logins distinctly.
- [x] Verify native CLI authentication roots against installed/official sources.

## Phase 2 - interactive setup and persistence

- [x] Prompt for server URL, hidden administrator credential and account label.
- [x] Use explicit environment configuration only, never auto-source/discover keys.
- [x] Hide key input, preserve multi-field credentials and POST to correct intake.
- [x] Require explicit review/save and successful nonsecret read-back for saved.
- [x] Protect account creation from accidental duplicate overwrites.
- [x] Loop for multiple accounts and provide --once/help/provider listing.
- [x] Retain optional clipboard handoff for dashboard-supported credential types.

## Phase 3 - native login isolation and cleanup

- [x] Native Codex/Claude flow with per-child auth/config overrides.
- [x] Native Muse/Kimi/Grok only with verified isolated auth roots; preserve
      native OAuth bundles as storage-only credentials, never API-key coercion.
- [x] Give each attempt a private temporary directory, 0700/0600 permissions.
- [x] Keep real HOME and existing logins intact; no logout/revocation or refresh.
- [x] Terminate owned child processes before cleanup; remove local artifacts on
      success, failure, cancel, EOF and caught signals, then verify removal.
- [x] Keep secrets out of argv/output/logs and unrelated child environments.

## Phase 4 - acceptance and review

Implementation acceptance includes fake-CLI/loopback tests for correct payloads,
repeated distinct roots, cleanup, signals, errors, malformed/symlink artifacts,
and secret-output isolation. Every launcher must pass macOS Bash3.2 syntax and
dispatch/help checks; HTTP errors/read-back mismatches cannot report saved.
An independently authored real-PTY harness checks immediate no-echo prompts and
process termination before cleanup, without real provider credentials.

Final gates are configured full `npm test`, affected Node26 checks, and two fresh
independent Studio reviews of the fixed final commit. Final results and the
commit-bound readiness receipt are retained in the shared Git Studio directory,
not inferred from planning checkboxes. See setup-scripts-validation.md.

AWS signing, subscription proxy adapters beyond the accepted Claude path,
automatic credential refresh for newly stored native bundles and installations
are not added by setup scripts. Provider registration success is separate from
provider validity or execution support.
