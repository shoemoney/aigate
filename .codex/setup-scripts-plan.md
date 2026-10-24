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

- [ ] Derive provider choices from src/providers.js plus existing client IDs.
- [ ] Add exact-name executable launchers with one shared Node24 runner.
- [ ] Model API keys, AWS fields, cloud bundles and native logins distinctly.
- [ ] Verify native CLI authentication roots against installed/official sources.

## Phase 2 - interactive setup and persistence

- [ ] Prompt for server URL, hidden administrator credential and account label.
- [ ] Use explicit environment configuration only, never auto-source/discover keys.
- [ ] Hide key input, preserve multi-field credentials and POST to correct intake.
- [ ] Require explicit review/save and successful nonsecret read-back for saved.
- [ ] Protect account creation from accidental duplicate overwrites.
- [ ] Loop for multiple accounts and provide --once/help/provider listing.
- [ ] Retain optional clipboard handoff for dashboard-supported credential types.

## Phase 3 - native login isolation and cleanup

- [ ] Native Codex/Claude flow with per-child auth/config overrides.
- [ ] Native Muse/Kimi/Grok only with verified isolated auth roots; preserve
      native OAuth bundles as storage-only credentials, never API-key coercion.
- [ ] Give each attempt a private temporary directory, 0700/0600 permissions.
- [ ] Keep real HOME and existing logins intact; no logout/revocation or refresh.
- [ ] Terminate owned child processes before cleanup; remove local artifacts on
      success, failure, cancel, EOF and caught signals, then verify removal.
- [ ] Keep secrets out of argv/output/logs and unrelated child environments.

## Phase 4 - acceptance and review

- [ ] Fake-CLI/loopback tests: correct payloads, repeated distinct roots, cleanup,
      signals, errors, malformed/symlink artifacts, secret-output redaction.
- [ ] Check every catalog launcher and macOS Bash3.2 syntax.
- [ ] Verify HTTP errors/read-back mismatch never report saved.
- [ ] Run configured full npm test and affected Node26 checks.
- [ ] Two fresh independent final-commit Studio reviews and ready receipt.
- [ ] Document commands, manual-only behavior, storage/execution boundaries and
      unavoidable hard-kill/power-loss cleanup limits.

AWS signing, subscription proxy adapters beyond the accepted Claude path,
automatic credential refresh for newly stored native bundles and installations
are not added by setup scripts. Provider registration success is separate from
provider authentication validity.
