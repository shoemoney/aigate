# Claude Code rotation and pricing acceptance

Implementation extends the reviewed transparent API-key proxy checkpoint
`2266c754f11eaf969aff726cc5ed6178100b7674`. Final independent reviews cover the
complete branch from `967ff056ee632c986673711c619f573709bf8620`.

The authoritative final verdict is the shared Git directory's
`studio/reviews/<HEAD>.json`. Runtime logs, private history reconciliation and
browser evidence live in `studio/validation/2026-10-23-claude-rotation/`.
No receipt is implied by this document alone.

## Automated gates

- CI uses Node 24.16.0, `npm ci`, then `npm test`; no build or lint task exists.
- The affected pool, relay, replay, capture, transport and catalog tests also run
  under Node 26.12.0. Exact commands, runtime versions and source SHAs are logged.
- Controlled-clock pool tests cover both positive remaining windows, fractional
  utilization, utilization above one, freshness, ranking, credential replacement,
  shared-scope merge/split invalidation and causal exhaustion ordering.
- Real local HTTP/SSE tests cover exact replay, early rejection and upload EOF,
  trailers, cancellation during fsync, deadline/fault ownership, partial output,
  model-family limits and explicit resource scope restrictions.
- Existing API-key, cookie, raw reset, unsolicited upgrade and Codex checks remain
  part of CI. AWS signing and upgraded tunnels remain unsupported.
- Pricing checks cover effective dates, staggered tiers, cache rates, unsupported
  units, live WAL rows, aliases, source-cost provenance, duplicate message IDs and
  conflicts between equivalent date-only and ISO manual-price timestamps.

## Native client and private data acceptance

The installed Claude Code 2.1.306 was exercised against local mock upstreams with
an isolated configuration, dummy credentials and nonessential traffic disabled.
One client generation request received A's quota refusal internally, then B's
successful stream. Its gateway token, model, complete body, additive beta headers
and system attribution remained unchanged. The failed response was captured
separately; only the successful response reached the client, with one terminal
record and one trusted subscription usage row.

Otari pricing and usage were imported read-only into an ignored private preview
database. Bootstrap seed prices were removed only from that preview, preserving
unpriced historical gaps. Source/model/date/token aggregates reconcile, and
repeating both imports creates no extra rows. Source cost remains distinct from
recomputed value. No account or provider credential was imported.

Real imported-data desktop and mobile rendering checked effective-date history,
provider/model filters, unpriced units, Spend charts and hover amounts. Computed
body text is 20px, readable text and chart labels are at least 18px, and mobile
tooltips wrap and scroll within the viewport. The empty pool and manual refresh
were exercised against the integrated server, without fixture overrides.

These checks establish local implementation behavior. No real subscription token
was tested, and no production deployment, push or merge was performed. Production
vault keys and data were not replaced by preview settings or historical imports.
