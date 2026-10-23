# Transproxy implementation plan

Branch: `transproxy`.
Base: `967ff056ee632c986673711c619f573709bf8620`.
Worktree: `/Users/shoemoney/Projects/aigate-transparent-proxy`.

## Contract

An operator manually stores a provider credential. Two optional proxy-only keys
(`AIGATE_PROXY_TOKEN` and `AIGATE_PROXY_TOKEN_2`) authorize provider-prefixed URLs
such as `/proxy/openai/v1`; only that routing prefix is removed. The provider's
newest manually provisioned API key serves the request. For stricter isolation,
an operator may instead manually bind a client token to one specific credential.
The transparent proxy substitutes authentication and necessary
HTTP transport addressing; it preserves application headers, raw method/path/query,
body bytes, status, errors and streaming. It does not parse/rewrite model names,
retry credentials, follow redirects or decompress content. Client tokens never
authorize administration, and requests never provision credentials.

Capture both sides of every proxy exchange, including complete headers, body
chunks, trailers, errors and termination state. Encrypt sensitive capture data at
rest; restrict decrypted retrieval to administrators. Keep all captures by default
without hidden truncation. Captures describe application HTTP, not original TLS/TCP
frames or identical transfer-encoding chunk boundaries.

Multi-field credential sets are manually entered encrypted JSON. This delivery
executes API-key adapters. AWS/bundle storage must not imply working AWS forwarding:
SigV4 requires an explicit signing adapter, deferred from this delivery.

## Phase 0: reset and isolation

Milestone: existing credentials are removed and cannot return through an old backup.

- [x] Inspect project instructions, saved context, actual CI, existing proxy and intake.
- [x] Create an isolated worktree; rename the implementation branch to `transproxy`.
- [x] Initialize Studio with actual CI command `npm test`.
- [x] Run untouched baseline: 446 tests passed.
- [x] Sanitize active NAS vault and backup databases with explicit user authorization.
- [x] Remove account/provider credential rows from 45 databases; use secure-delete and checkpoint WAL.
- [x] Independently reopen the active NAS DB: account and provider-key counts are zero.
- [x] Confirm the local data DB is empty and production remains stopped.
- [x] Preserve administrative configuration/encryption key and noncredential history.
- [x] Record final verification evidence; do not add destructive startup migrations.

## Phase 1: manual provisioning and routing

Milestone: only explicit administrative actions provision credentials and bindings.

- [x] Add encrypted structured credential storage and metadata-only listings.
- [x] Support API-key, generic bundle and AWS credential-set storage.
- [x] Permit relay only for supported API-key adapters; reject unsupported signers.
- [x] Add hashed client-token bindings to a specific provider credential.
- [x] Support two independently revocable environment preset tokens, separate from admin auth.
- [x] Route preset tokens by provider URL without model sniffing or automatic credential intake.
- [x] Support manual create/list/revoke operations, rejecting administrative-token reuse.
- [x] Keep existing provider-key storage compatible and existing OAuth sync update-only.
- [x] Prove unknown keys, proxy traffic, files and environment do not create credentials.
- [x] Prove client tokens cannot call administrative endpoints.

## Phase 2: transparent relay

Milestone: a local upstream observes the original application request, with only
documented authentication/Host/hop/framing exceptions.

- [x] Implement HTTP/HTTPS streams with raw header pairs and bounded backpressure.
- [x] Preserve raw path/query, arbitrary methods, duplicate application headers and bytes.
- [x] Preserve upstream status/message, headers, errors, cookies, trailers and compressed bytes.
- [x] Support JSON, multipart, binary and SSE without parsing/transformation.
- [x] Perform no retries, redirect following or credential discovery.
- [x] Restrict destinations to operator-controlled configuration.
- [x] Tear down upstream on client cancellation and handle upload/response failures.
- [x] Explicitly reject unsupported CONNECT/WebSocket upgrades.
- [x] Remove only gateway-owned administrative cookies from upstream requests and downstream Set-Cookie.
- [x] Make concurrent fault handling single-flight before asynchronous capture writes.
- [x] Record cancellation before capture setup and prevent provider contact after setup-time aborts.

## Phase 3: complete encrypted captures

Milestone: successful, rejected, failed and partial exchanges leave inspectable records.

- [x] Record incoming and forwarded headers, raw bodies, trailers, timestamps and outcomes.
- [x] Capture before forwarding and stop explicitly if logging fails.
- [x] Keep all sensitive values encrypted in private event files; avoid console/WS disclosure.
- [x] Keep memory bounded and authenticate event identity/order.
- [x] Mark interrupted exchanges after restart; retain partial captures.
- [x] Provide administrative pagination, detail and streaming downloads.
- [x] Preserve all captures by default; document capture boundaries.
- [x] Protect encryption-key rotation against orphaning newly encrypted data.

## Phase 4: acceptance and independent review

Milestone: the final local commit passes CI and two fresh independent reviews.

- [x] Document manual setup, SDK/base-URL use, bundle fields, capture retrieval and limits.
- [x] Validate fidelity, gzip/binary/multipart, SSE latency, duplicates, aborts and errors locally.
- [x] Validate manual-only provisioning, admin isolation, failure captures and restart recovery.
- [x] Run new focused tests and legacy proxy/auth regressions.
- [x] Run the full `npm test` suite; use Node 24 to match CI when available.
- [x] Replace existing concurrency-fixture timer assumptions and unequal-reset tie fixtures with explicit conditions.
- [x] Commit only explicit intended paths and inspect scope.
- [ ] Obtain two fresh reviews pinned to exact final BASE/HEAD; fix significant findings.
- [ ] Re-run both final reviews after any subsequent commit.
- [ ] Save review receipts, validation evidence and a ready PR description.
- [ ] Leave the validated local branch; do not publish or deploy without authorization.

## Ownership and parallel execution

- Proxy builder: `src/server.js`, new proxy/capture modules and proxy tests.
- Documentation builder: README, proxy guide, testing guide, environment example,
  compliance wording and narrow package description changes.
- Rotation builder: `scripts/rotate-key.js` and its new isolated regression tests.
- Preset-test builder: independent preset-key and manual-provisioning boundary tests.
- Parent: planning, coordination, operational purge, serial integration/validation,
  commits and review evidence.

Use all available independent agent slots. Serialize shared validation and Git
integration. Builders preserve concurrent changes and do not commit or publish.
Named Studio roles are unavailable in this runtime; fresh native agents receive
the same role-specific briefs. Final reviews use distinct fresh contexts.

The first final review attempt at `0aad353` found three major issues: gateway
session-cookie forwarding, concurrent fault responses, and cancellation during
asynchronous capture setup. Fixes and deterministic regressions are a separate
milestone; both final passes must be repeated on the corrected commit.

## Deferred AWS milestone

- [ ] Define supported AWS services, endpoint construction, regions and session behavior.
- [ ] Implement SigV4 signing/re-signing with explicit authentication-header exceptions.
- [ ] Validate canonical requests and signed streaming bodies against official test vectors.
- [ ] Add service-specific integration proof before claiming executable AWS support.
