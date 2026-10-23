# Transproxy validation evidence

Implementation branch: `transproxy`.
Base: `967ff056ee632c986673711c619f573709bf8620`.

## Automated acceptance

- Final complete suite after review and fixture corrections: `npm test`,
  Node 24.16.0, 487 passed with zero failures/skips/cancellations (exit 0).
  The log records the executable path and runtime version before the command.
- Untouched baseline: `npm test`, Node 26.12.0, 446 passed, no failures/skips.
- Initial implementation suite at `0aad353`: `npm test` with Node 24.16.0 first on PATH,
  481 passed, no failures/skips/cancellations.
- Main builder's focused Node 24 relay/capture checks: 21 passed.
- Independently authored Node 24 preset-boundary checks: 8 passed.
- Independently implemented rotation checks, re-run by parent on Node 24: 6 passed.
- Fresh validator's Node 26.12.0 run of all four new test files: 35 passed,
  no failures/skips/cancellations or asynchronous/file-descriptor warnings.
- Independent real-server HTTPS acceptance on Node 24.16.0 passed: a trusted
  localhost TLS upstream preserved binary bodies, query, duplicate/custom headers,
  status and encrypted capture. An untrusted certificate returned 502; its HTTP
  handler received no requests, and the encrypted record reported the error.
  Certificate validation stayed enabled; fixture keys/processes were removed.
- `git diff --check`, package JSON parsing and relative documentation links pass.

## Final-review corrections

The first review findings were fixed with explicit gateway-owned cookie
isolation, single-flight fault admission before asynchronous capture, and
cancellation tracking before capture setup. Generated errors suppress automatic
uncaptured Date headers. New deterministic tests exercise both setup-time
cancellation phases and overlapping real timeout/connection failures while
capture fsync is held; separate tests use a real signed dashboard session.

- Corrected Node 24 focused suite: 41 passed, no failures/skips/cancellations.
- Fresh corrected Node 26 focused validation: 41 passed with no asynchronous or
  file-descriptor warnings.
- Corrected independent HTTPS acceptance passed on Node 24, including request
  cookie isolation, response cookie protection, and exactly one captured error
  response for an untrusted certificate. Fixture keys/processes were removed.

The first corrected full run reported 486 passes and one failure in the unchanged
OAuth-refresh race fixture. The exact case passed in isolation. An independent
temporary archive of the untouched base ran all 43 OAuth server tests successfully
under Node 24, so that comparison did not reproduce a baseline failure.

Inspection found an uncontrolled 15ms/40ms timer assumption in that race fixture;
it now holds refresh explicitly and observes selection admission before release.
A separate ranking fixture could give sequentially polled accounts different
second-based reset times while expecting a usage tie-break; it now shares one
reset timestamp. Only these two test cases changed, with their assertions intact.
The complete OAuth server file passed 43/43 after correction, and the gated race
passed three targeted repeats. No production OAuth code changed.

CI uses Node 24, `npm ci`, and `npm test`. No separate build or lint command exists.
Dependencies were installed with `npm ci` in the isolated worktree.

Final focused command:

```sh
rtk proxy node --test --test-timeout=20000 test/proxy-traffic.test.js test/transparent-proxy-http.test.js test/transproxy-presets.test.js test/proxy-rotation.test.js test/transproxy-failure-boundaries.test.js test/transproxy-session-cookie.test.js
```

All automated fixtures use temporary databases, dummy credentials and local
upstreams. They do not contact real provider APIs or populate the actual vault.
Coverage includes exact application bytes/headers, duplicate fields, raw queries,
gzip/binary/multipart, errors and redirects without retry, SSE/cancellation,
chunked GET uploads, request/response trailers, HEAD, early upstream responses,
100 Continue, raw 103 headers and pipelined ordering, explicit CONNECT/upgrade
rejection, manual-only provisioning, preset revocation and administrative
isolation, encrypted capture retrieval/recovery/tamper ordering/finalization,
logging failure, and encryption-key rotation safety.

## Authorized credential reset

The operator explicitly requested removal of all existing vault credentials,
including backup databases. With the application stopped, a maintenance process
used SQLite secure-delete transactions to delete account/provider credential
rows and checkpoint WAL files. It sanitized 45 active/backup databases, removing
127 account rows across those copies; no provider-key rows were present.

A second read-only process independently reopened every sanitized database and
confirmed zero account/provider-key rows. The local checkout's data database was
empty. The administrative authentication/encryption configuration and historical
noncredential records were preserved. The production container remains stopped.
The implementation contains no credential-deleting startup migration and no
automatic credential discovery/import path.

## Evidence and review records

Full test logs are retained privately in the shared Git directory under
`studio/validation/2026-10-23-transproxy/`. Temporary console copies are
`/tmp/aigate-transparent-proxy-baseline.log`,
`/tmp/aigate-transproxy-node24-full.log`, and
`/tmp/aigate-transproxy-node26-focused.log`. The standalone HTTPS acceptance
report is `/tmp/aigate-transproxy-https-acceptance.log` with a companion JSON file.
Corrected evidence uses the corresponding `*-fixed.log`/JSON files, together
with `aigate-transproxy-fixes-all-focused.log` and
`aigate-transproxy-session-cookie.log`. The final full-suite log explicitly
records its selected Node executable and version before running `npm test`.
Baseline comparison and fixture evidence are retained as
`aigate-transproxy-baseline-codex.log`, `aigate-transproxy-codex-race-fixed.log`,
`aigate-transproxy-codex-race-targeted.log`, and
`aigate-transproxy-codex-race-first-attempt.log`. Failed checks are retained,
including `aigate-transproxy-node24-full-fixed.log`.
The final passing complete log is `aigate-transproxy-node24-full-final.log`.

Final review reports and readiness receipts are stored outside the working tree
under the shared Git directory's `studio/` path and identify the exact final
BASE/HEAD. The plan's final review todos are tracked there after this document is
committed, avoiding a documentation commit that would invalidate those reviews.

The first final review attempt at `0aad353` failed with three major findings:
gateway session-cookie leakage, concurrent fault handling, and missed cancellation
during asynchronous capture setup. Its failed reports are retained under
`studio/reviews/`. The fixes and deterministic regression results are recorded
above. Two new final-tip reviews must pass before local readiness; the initial
green tests alone do not establish acceptance.

## Scope and limitations

This is local implementation/acceptance evidence. No feature code was pushed,
merged or deployed; no real provider credentials were added. Actual preset key
values must be entered manually in the deployment environment. AWS and generic
multi-field credentials can be stored, but executable signing adapters remain
deferred. CONNECT and WebSocket/realtime relay are explicitly unsupported.

Generic informational responses use Node's queued internal `_writeRaw`
primitive, also used by its public informational writers. Raw custom-header and
pipelining tests pass on Node 24 and 26; this internal dependency should be
rechecked when changing the supported Node major versions. Application payload
and header fidelity excludes authentication substitution, provider-routing prefix
removal, upstream Host and connection-specific HTTP framing.
