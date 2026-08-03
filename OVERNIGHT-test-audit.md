# Overnight test audit — board tests (`test/http.test.js`)

Scope: the kanban-board test block only (`// ---- kanban board ----`, ~line 989 to EOF,
17 tests as of this run — 3 of which — activity/hosts/reorder — landed in the working
tree from a concurrent session while this audit was running).

Method: for every board test, asked "if the feature it names were silently broken, would
this test still go red?" Where the answer looked like "no," broke the real code on purpose,
re-ran, confirmed the test stayed green (proving the gap), then strengthened the assertion,
broke the code again to prove the *new* assertion goes red for the right reason, then
restored the code and confirmed the full suite is green.

## Finding: `board: create → list shows a todo card with cwd/model/effort` didn't check what its own name promises

**File:** `test/http.test.js`, test starting at (pre-fix) line 997.

The test POSTs a card with `cwd`, `model`, `effort`, then only asserted:
- `card.model` / `card.effort` from the **POST response** (fine — that's `RETURNING *` off a
  real insert, not self-built)
- `list.some(c => c.id === card.id && c.prompt === '...')` — id + prompt only

`cwd` was **never asserted anywhere in the test**, and `model`/`effort` were never checked
on the value that comes back from `GET /api/board` (the `listCards` query), only on the
POST echo. No other board test covers that gap either — the atomic-claim test checks
`cwd`/`model` but reads them off the `/claim` response, which is a separate hand-picked
column list, not `listCards`.

**Proved it live:** stripped `cwd,model,effort` out of the `listCards` SELECT in
`src/server.js` (a real regression — the list endpoint would silently stop returning those
fields) and reran just the board tests. All 17 passed, including the one named after the
exact fields that had just been deleted from the query.

**Fix applied:** the test now asserts `card.cwd` from the POST response, and pulls the
listed row by id and asserts `cwd`/`model`/`effort`/`prompt` all round-trip through
`GET /api/board` itself, not just through the POST echo. Reran the same SELECT-stripping
break: the strengthened test now fails with `actual: undefined, expected: '/tmp/x'` at the
new assertion — proven red for the stated reason. Restored the code; suite is green again.

## Everything else in the board block

Read every other board test against "does the arrange block build what the assert block
checks" and "would deleting the feature turn it red":

- **atomic claim** (`hands a card out exactly once`) — real: fires two concurrent claims,
  asserts the status codes are `[200, 204]` (not both 200), and that the winner is the
  card that was actually created. Would fail if the `UPDATE ... RETURNING` claim query
  stopped being atomic.
- **result / followup / retry** — assert on values pulled back through `RETURNING *`
  (real DB round-trip), not values the test manufactured. `followup` specifically checks
  `session_id` survives the requeue, which only holds if `followupCard`'s SQL is scoped
  to the columns it claims to touch.
- **WS pushes a board event on mutation** — waits for a real `type:'board'` broadcast and
  asserts the pushed payload contains the created card; a missing `broadcast()` call would
  hang the test out to timeout, not pass it.
- **host targeting** — asserts a card pinned to `host:'reek'` is refused by a claim for
  `host:'wick'` and only served to a claim for `'reek'`, then confirms `/api/board/hosts`
  reflects both boxes from real `workers` map state, not injected data.
- **activity heartbeat / hosts-after-claim / reorder** (added concurrently during this
  audit) — all assert through the real endpoints they exercise (`/api/board/workers` for
  the heartbeat, `/api/board/hosts` for the no-card claim, `GET /api/board` ordering for
  reorder). No self-built tautologies spotted in these.

No mocks appear anywhere in the board block — every board test hits the live HTTP+SQLite
path end to end, so there's no "asserts on its own mock" pattern to find there (that
pattern does show up elsewhere in the file, in the Anthropic-refresh tests, which are out
of this audit's scope).

## Not fixed, flagged for awareness only (out of scope)

`node --test` is occasionally flaky on `signSession/verifySession: round-trips, rejects
tamper/expiry/wrong-secret` in `test/lib.test.js` (~1 run in 10, unrelated file, looks
timing/expiry-boundary related). Confirmed it's pre-existing and unrelated to this change
— it reproduces on repeated runs of the untouched suite. Left alone: out of the board-test
scope for this pass, and not something to touch unattended without narrowing down the
actual boundary condition first.

## Bottom line

One real "cannot fail" gap found and fixed in the board block, verified red→green with the
underlying code broken and restored. The rest of the board tests hold up under the same
scrutiny — they build fixtures and assert on values fetched back through the real
endpoints, not on values they invented themselves.
