# 🧪 aigate testing

How aigate is tested, and how to re-run every layer. Nothing here needs a
framework — Node 24's built-in test runner + a couple of shell scripts.

## Layers

| Layer | What it proves | Run it |
|-------|----------------|--------|
| **Unit** (`test/lib.test.js`) | Vault crypto (GCM tamper-detect), CIDR/IP gate, timing-safe token compare, static-path containment, token-liveness classifier | `npm test` |
| **HTTP integration** (`test/http.test.js`) | Every route end-to-end on a throwaway DB: auth gate, accounts/keys round-trips (secrets never leak), selector, **exclude retry**, **over-limit parking**, reauth-skip, `/health`, providers catalog | `npm test` |
| **Dashboard E2E** (headless Chromium) | The key-add UI actually adds → persists → deletes, secret stays hidden, provider dropdown populated, no JS errors | see below |
| **Fleet integration** (`clients/test-switching.sh`) | A real Pi runs `cc -p` through aigate, and account selection **switches** correctly as accounts are disabled/enabled — logged in the DB | see below |

## Unit + HTTP (44 tests, zero deps)

```bash
npm test          # node --test → test/*.test.js
```

Covers, among others, the four bugs fixed during hardening (static-file sibling
leak, XFF spoof, auth-compare crash, `ip2int` garbage) — each has a
failed-before/passes-after regression test.

## Dashboard key-add UI (headless browser)

Drives the live server with Playwright: login → add a key via the form →
assert it appears in the list AND persisted via `/api/keys` → secret is masked →
delete → no console errors. (Python venv + `playwright install chromium`; point
it at a throwaway server started with `AIGATE_POLL_MS=0`.)

## Fleet switching test — the real proof 🔁

Installs the client on a box, then flips accounts and watches `cc` follow.

```bash
# on the target box (e.g. a Pi):
AIGATE_URL=https://aigate.example  AIGATE_TOKEN=…  bash clients/install.sh
bash clients/test-switching.sh <accountWithMoreHeadroom> <otherAccount>
```

It toggles `disabled` on each account and asserts the selected account flips,
with a real `cc -p 'PONG'` succeeding every time. Then confirm the audit trail:

```bash
sqlite3 data/aigate.db \
  "SELECT ts,account,action,result FROM access_log WHERE host='<box>' ORDER BY id DESC LIMIT 8;"
sqlite3 data/aigate.db \
  "SELECT ts,account,substr(prompt,1,40) FROM request_log WHERE host='<box>' ORDER BY id DESC LIMIT 8;"
```

### Verified run (2026-07-08, Pi `twojeffs` → `aigate.shoemoney.ai`)

| State | Expected | Picked | `cc -p` result |
|-------|----------|--------|----------------|
| both enabled | shoemoney (1% vs 19%) | shoemoney | `PONG` |
| shoemoney disabled | personal | personal | `PONG` |
| personal disabled | shoemoney | shoemoney | `PONG` |
| both enabled | shoemoney | shoemoney | `PONG` |

Every switch landed in `access_log` (`select`/`ok`) and `request_log`.

## Over-limit detect + retry

`cc -p` captures claude's output; on a rate-limit / unavailable signal it POSTs
`/api/events/limit` (parks that account at 100% → next select skips it; the
usage poller restores real headroom later) and retries the next-best account
via `/api/select?exclude=…` (up to 3). Verified with a fake `claude` that
rate-limits account A: the wrapper reported the limit and switched to B, with
`access_log` showing `select → limit → select`.
