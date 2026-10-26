# Todo cycle: October 26, 2026

Base: `0ffbf1647b54443add39f9f64231d5195a8202cc` (`transproxy`).
Aggregate review branch: `review/2026-10-26-todo-cycle`.

Scope: three reproduced issues. Production, credentials, DNS and deployment are outside this cycle. The original checkout's unrelated changes and uncommitted handoff are preserved.

## Milestone 1: Reproduce and freeze acceptance

- [x] Survey current source and distinguish current defects from historical evidence and documented feature limits.
- [x] Reproduce an invalid timestamp persisted before a pool status exception.
- [x] Reproduce helper success while an upload producer remains open, with an ordinary completed-upload positive control.
- [x] Measure 68 catalog providers against three README claims of 67; distinguish 82 setup descriptors.
- [x] Run every probe on the fixed base and observe exit 1 for the actual defect.

Frozen probes, hashes and base logs are outside the repository in `.git/studio/ops/2026-10-26-todo-cycle/`. Each probe uses the tested worktree's current directory for source paths. They are not editable by implementers or narrowed during review.

## Milestone 2: Independent implementation packages

### claude-pool-reject-out-of-range-timestamps

Owned paths: `src/claude-pool.js`, `src/claude-quota.js`, `test/claude-pool.test.js`; record any necessary existing quota-test changes explicitly.

- [x] Validate normalized epoch milliseconds against the representable Date range before returning them.
- [x] Reject invalid manual expiry with TypeError before any metadata mutation, including combined scope updates.
- [x] Treat out-of-range upstream reset values as unknown; preserve seconds/milliseconds/ISO/null behavior and the existing unit threshold.
- [x] Keep status usable when an old stored invalid value passes through the parser.
- [x] Run its frozen probe and `node --test test/claude-pool.test.js` from the item worktree.

Risk: changing unit interpretation, mutating metadata before validation, or interpreting invalid quota resets as fresh observations.

### unifi-early-success-truncates-upload

Owned paths: `clients/aigate-unifi.mjs`, `test/unifi-client.test.js`.

- [x] Require local outbound request flush before successful completion of a body-bearing request.
- [x] Reject an early successful response while upload remains unfinished, promptly and without exposing credentials.
- [x] Preserve ordinary complete uploads, raw bytes, streaming/backpressure, GET success and early HTTP-error cancellation.
- [x] Run its frozen probe and `node --test test/unifi-client.test.js` from the item worktree.

Risk: races among request finish, response completion and stdin EOF; hangs or lost backpressure.

### correct-provider-catalog-count

Owned path: `README.md` only.

- [x] Correct the three current provider-catalog statements to 68.
- [x] Preserve separate setup counts and historical measurements.
- [x] Run the frozen catalog probe and inspect the scoped documentation diff.

Risk: confusing catalog providers with setup descriptors or rewriting historical evidence.

## Milestone 3: Verify, integrate and review

- [x] Use one isolated item worktree per package; provision dependencies without copying any environment file.
- [x] Commit explicit owned paths after inspecting each implementation report.
- [x] Independently execute unchanged probes and relevant tests on exact item commits; allow rejection with a specific objection, at most three rounds.
- [x] Integrate accepted commits only into the aggregate review branch, serializing integration and shared test resources.
- [x] Run all frozen probes and the configured full `npm test`; record actual pass/fail/skip counts.
- [x] Sync documentation in a fresh worktree using accepted changes and measured results; describe local work accurately.

Final gate requirement: obtain two fresh independent final-tip reviews, record
their exact base/head and evidence, and prepare a PR description. Record final
review and Node 24 CI outcomes in the operator receipts for the reviewed tip.

### Local validation snapshot, October 26, 2026

At aggregate head `d0f8e521b23e876d1484624f679493d449278c3c`, macOS with
Node 26.12.0 ran `npm test`: 734 tests passed, 0 failed, 0 skipped. The full
suite also passed after each earlier integration (730, then 733 tests). Frozen
probes failed on the original base and passed on the corresponding fixes;
independent item checks were accepted in round one. Logs and exact item heads
are in `.git/studio/ops/2026-10-26-todo-cycle/` of the original checkout.
These are local synthetic checks. Production remains at
`0ffbf1647b54443add39f9f64231d5195a8202cc`; no provider or live gateway
acceptance, deployment, account provisioning, or credential rotation was part
of this cycle. The final review and Node 24 CI gate require separate receipts.

All three ownership sets are disjoint, allowing parallel implementation within the four-slot limit. Verification of a completed package can overlap remaining implementations. Root owns commits and integration; writers do not commit or publish.

The old NAS IOPS item is an infrastructure follow-up. Its Aigate impact predates the migration to bee1; any root-only queue note must preserve the unresolved NAS cause and its original evidence. It is not counted as a product fix.
