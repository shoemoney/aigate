# Transproxy validation evidence

Implementation branch: `transproxy`.
Base: `967ff056ee632c986673711c619f573709bf8620`.

## Automated acceptance

- Untouched baseline: `npm test`, Node 26.12.0, 446 passed, no failures/skips.
- Final complete suite: `npm test` with Node 24.16.0 first on PATH,
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

CI uses Node 24, `npm ci`, and `npm test`. No separate build or lint command exists.
Dependencies were installed with `npm ci` in the isolated worktree.

Focused command:

```sh
rtk proxy node --test --test-timeout=20000 test/proxy-traffic.test.js test/transparent-proxy-http.test.js test/transproxy-presets.test.js test/proxy-rotation.test.js
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

Final review reports and readiness receipts are stored outside the working tree
under the shared Git directory's `studio/` path and identify the exact final
BASE/HEAD. The plan's final review todos are tracked there after this document is
committed, avoiding a documentation commit that would invalidate those reviews.

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
