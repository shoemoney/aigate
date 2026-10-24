# Setup script acceptance

The implementation adds exact-name provider launchers, a shared interactive
runner, typed credential collection, isolated native login adapters and opt-in
create-only account registration. Real provider logins and deployments are
separate acceptance steps.

## Automated checks

- Full repository command: `npm test` on Node24.
- Affected Node26 checks: setup-catalog, setup-native, setup-scripts,
  setup-create-only, http, codex-server, claude-delayed-model and claude-pool tests.
- macOS Bash3.2 launcher syntax and dispatch/help coverage for every catalog ID.
- Independent real-PTY acceptance: immediate no-echo secret prompts, repeated
  roots, exact native/API/AWS payloads, authenticated save/read-back gates,
  rejected saves, metadata mismatches, signals, private artifacts and helper
  termination before cleanup.
- Installed native executable resolution is inspected without executing logins.

All fixtures use synthetic credentials, owned temporary directories and loopback
servers. Existing user authentication files and Keychain entries are not read.

## Final evidence

The shared Git directory retains `studio/validation/2026-10-24-setup-scripts/`
with command/version/source manifests, final logs, independent terminal evidence
and any earlier failures. The independent harness records source-file hashes
before and after its run. Final commit files must match those hashes.

Two fresh independent review reports and `studio.py ready` produce a receipt
at `studio/reviews/<final-head>.json`. A source change invalidates final approval
until the checks and reviews are refreshed. The earlier Claude-rotation receipt
covers its earlier checkpoint only.

## Intentional boundaries

Native Muse/Kimi/Grok bundles and AWS/cloud multi-field credentials are stored
with explicit execution limits; setup does not add forwarding, signing, native
renewal or new account kinds. Codex/Claude account creation uses the existing
account intake with create_only, which atomically rejects existing names.

API mode reports a save only after matching nonsecret metadata read-back.
Clipboard mode is operator confirmation and requires the matching dashboard
form; it does not claim a verified API save. Provider credential validity is not
inferred from successful storage.

Temporary artifacts are removed after success, failure, EOF and caught signals;
owned login processes are stopped first. SIGKILL/power loss cannot run cleanup,
and clipboard history retained by another application cannot be purged reliably.
The normal OS home and existing logins remain in use outside child-scoped
provider authentication-root overrides.
