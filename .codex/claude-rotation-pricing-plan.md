# Claude Code rotation, verbose attempts, and Otari pricing

Base: `2266c754f11eaf969aff726cc5ed6178100b7674`.
Branch/worktree: `transproxy`, `/Users/shoemoney/Projects/aigate-transparent-proxy`.
Actual CI: Node 24, `npm ci`, `npm test`.

## Confirmed goal and scope

Implement rotation for manually entered, long-lived **Claude Code coding-plan
tokens**. Both five-hour and weekly **remaining** allowance must be above zero.
Zero percent used means full remaining allowance. Spend the eligible subscription
whose weekly allowance resets soonest, preserving the previous selection policy.
Refresh observed usage every five minutes, and ingest real response headers between
polls. Fail over within the proxy with the client's gateway token unchanged.

Also complete verbose encrypted attempt logging, show model pricing on the
dashboard, and import historical model pricing and usage from Otari read-only.
No credential import, automatic token creation, deployment or publication.

The existing API-key vault and strict aliases retain their behavior. Claude Code
gets an explicit `/proxy/claude-code` account-pool adapter; OAuth credentials never
enter provider API-key slots. No model/body rewriting or forged client fingerprint.
Required OAuth capability headers come from explicit client configuration.

## Phase 1: account quota state and five-minute refresh

Milestone: the API reports a truthful ranked pool and explains exclusions.

- [ ] Add `src/claude-pool.js` and focused tests using existing encrypted accounts.
- [ ] Keep usage/reset observation provenance, freshness, credential expiry,
  manually assigned shared-subscription scope and model-family cooldowns separate.
- [ ] Reuse the existing minimal Messages probe; inference-only setup tokens cannot
  be assumed to access profile/usage-management endpoints. Probe traffic consumes
  allowance and must be explicitly identified in verbose logs.
- [ ] Single-flight polling every 300000ms; bounded concurrency/timeouts, no overlap.
- [ ] Reject stale observations from a replaced/deleted credential or an older
  poll begun before newer request-observed exhaustion.
- [ ] Require fresh, known positive remaining allowance in both windows; never
  convert unknown values into zero usage/full capacity. Preserve fractional values.
- [ ] Rank soonest future weekly reset first; unknown/past reset sorts after active
  windows; tie-break with headroom, concurrency/last use and deterministic identity.
- [ ] Treat tokens belonging to one subscription as shared allowance; support
  explicit manual scope metadata and deduplicate identical credential fingerprints.
- [ ] Expose admin-only `/api/proxy/claude-code/status` and `/refresh` APIs and
  metadata editing without returning any token.
- [ ] Make the legacy poll/manual-refresh paths use the same underlying observation
  service, avoiding duplicate probes and preserving Codex behavior.

## Phase 2: transparent account-pool attempts

Milestone: an exhausted account fails over to an eligible account with one client
response and unchanged client configuration, model, application headers and body.

- [ ] Add private authenticated encrypted replay/spool support with bounded memory.
- [ ] Preserve the live first upload; only retry after body and trailers are fully
  replayable. Do not replace every upload with mandatory upfront buffering.
- [ ] Refactor one outer request into bounded per-account attempts with leases,
  attempted-account tracking, deadline and cancellation propagation.
- [ ] Classify only authoritative Claude session/weekly/model-family exhaustion;
  bare 429 without quota evidence is temporary throttling, 529 is global overload.
- [ ] Distinguish revoked credentials, entitlement/validation errors, permissions,
  and ambiguous transport/5xx failures; do not silently replay billable requests.
- [ ] Never retry after upstream application headers or output have been sent to
  the client. Local 100 Continue is a separate transport handshake. No hidden
  restart after partial SSE or response splicing.
- [ ] Keep explicit request scopes/resource references compatible across candidates.
- [ ] Preserve existing pinned API-key aliases and API-key OAuth intake rejection.
- [ ] Log each selection, quota snapshot, effective upstream headers, response
  headers/body, decision, cooldown and attempt outcome separately from the final
  downstream response, with one outer terminal record.
- [ ] Logging/spool failure stops forwarding; interrupted spools never auto-replay
  after restart. Extend offline key-rotation guards for the new encrypted storage.

## Phase 3: Otari model rates and historical usage

Milestone: imported rates/history reconcile without credentials or duplicate events.

- [ ] Extend the existing spend ledger, effective-dated micro-dollar arithmetic,
  cache/tier prices and source-ID dedupe; do not create another spend ledger.
- [ ] Add a catalog/provenance module and read-only Otari pricing import script.
- [ ] Import accepted Otari catalog snapshots and explicit effective-dated model
  prices before usage; normalize provider-instance/model names deliberately.
- [ ] Keep source snapshot/hash/original key/unit/effective date. Unsupported units
  and missing rates stay visible and unpriced, never silently zero.
- [ ] Preserve manual prices and report conflicts rather than overwrite settled data.
- [ ] Make usage imports WAL-aware through a normal read-only transaction; never
  import credential, prompt or request-content tables/fields.
- [ ] Preserve any source cost/provenance separately from recomputed API-equivalent
  value; never silently convert subscription value into actual cash spend.
- [ ] Reconcile date/source/model/token counts, duplicates/rejects and unpriced rows.
  Repeat imports must be idempotent and failed HTTP batches must exit nonzero.
- [ ] Build a private local preview DB with the authorized historical data, retaining
  production's encryption settings/data and its stopped state.

## Phase 4: dashboard and rendered evidence

Milestone: real quota state and dated model prices are readable and interactive.

- [ ] Extend the existing dashboard with Claude rotation status, next pick,
  remaining/reset/freshness information and manual refresh controls.
- [ ] Add ECharts model-price history/current-rate views, searchable models,
  provenance/as-of details, unpriced visibility and historical usage drilldowns.
- [ ] Preserve actual API spend, subscription API-equivalent value and unattributed
  value as distinct quantities. Charts precede optional detailed tables.
- [ ] Keep contextual Font Awesome assets, at least 18px all readable text/chart
  labels, normally 20px body/controls. Correct undersized touched chart styles.
- [ ] Render desktop/mobile with imported historical data; inspect computed font
  sizes, wrapping, interactions, empty/error states and secret-free UI responses.

## Phase 5: integration and final reviews

- [ ] Controlled-clock quota tests: cadence, overlap, expiry, stale/missing windows,
  zero remaining, fractional headroom, shared scopes and model limits.
- [ ] Real local HTTP/SSE tests: A-exhausted to B-success, exact replay/headers,
  withheld failures, incomplete uploads, cancellation, overload/no retry,
  partial-stream/no retry and complete separate attempt capture.
- [ ] Preserve cookie, raw reset, 101, trailer, encryption and legacy regressions.
- [ ] Pricing/history tests: decimal units, tiers/caches, effective boundaries,
  future-rate exclusion, unsupported prices, WAL rows, conflicts and import twice.
- [ ] Native Claude Code protocol smoke against a local mock without real credentials
  or external telemetry; document real-token acceptance as unverified until manual input.
- [ ] Full Node 24 suite, affected Node 26 transport compatibility, rendered evidence,
  then two fresh independent final-commit Studio reviews and readiness receipt.
- [ ] Leave a validated local branch and ready PR description. Publication/deployment
  requires separate authorization; keep production stopped.

## Ownership and parallelism

1. Quota builder: new Claude pool module/tests, no server/relay integration edits.
2. Pricing builder: spend/catalog modules and Otari import scripts/tests, no UI or
   server routing edits outside `handleSpend`.
3. Dashboard builder: `public/index.html`, dashboard tests and rendered fixtures,
   consuming stable pool/spend APIs, no backend edits.
4. Relay/replay integration builder: transparent proxy, replay module, server
   integration and transport tests after the quota interface is fixed.
5. Parent: contracts, plan/evidence, serialized integration/commits, private actual
   history import, runtime acceptance and final independent review contexts.

Use all available useful agent slots. Builders preserve concurrent edits, do not
commit or publish, and test only isolated temporary DBs/local upstreams. Source
Otari is read-only. Provider usage is not verified with a real token automatically.

## Verified reference constraints

- Long-lived setup tokens are subscription OAuth and inference-only:
  https://code.claude.com/docs/en/authentication#generate-a-long-lived-token
- Native gateway configuration and protocol:
  https://code.claude.com/docs/en/llm-gateway-connect
  https://code.claude.com/docs/en/llm-gateway-protocol
- Session/family limits versus temporary throttling:
  https://code.claude.com/docs/en/errors#youve-hit-your-session-limit
  https://code.claude.com/docs/en/errors#server-is-temporarily-limiting-requests
- Otari source: pricing service/refresh/history models and local SQLite source;
  existing aigate spend ledger and importer are the implementation starting point.
