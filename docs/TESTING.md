# 🧪 aigate testing

How aigate is tested, and how to re-run every layer. Nothing here needs a
framework — Node 24's built-in test runner + a couple of shell scripts.

## Layers

| Layer | What it proves | Run it |
|-------|----------------|--------|
| **Unit** (`test/lib.test.js`) | Vault crypto (GCM tamper-detect), CIDR/IP gate, timing-safe token compare, static-path containment, token-liveness classifier | `npm test` |
| **HTTP integration** (`test/http.test.js`) | Every route end-to-end on a throwaway DB: auth gate, accounts/keys round-trips (secrets never leak), **sanitized key intake** (quote-strip, `export`/`NAME=` → 400, `first8…last4` hints, normalized lookups), selector, **exclude retry**, **TTL parking** (+ 404 on unknown accounts), reauth-skip, **boot canary**, **vault backups**, `/health` selectable parity, providers catalog, **WS `bearer.<token>` subprotocol auth** | `npm test` |
| **Dashboard smoke** (manual) | The key-add UI adds → persists → deletes with the secret masked — every route it touches is already covered by the HTTP tests | see below |
| **Fleet integration** (`clients/test-switching.sh`) | A real Pi runs `cc -p` through aigate, and account selection **switches** correctly as accounts are disabled/enabled — logged in the DB | see below |

## Unit + HTTP (`node --test`, zero deps)

```bash
npm test          # node --test → test/*.test.js
```

`test/http.test.js` boots the **real server** on a throwaway temp DB (env is set
before the import, so it never touches real data) and drives every route over
actual HTTP — including the WebSocket upgrade.

Covers, among others, the four bugs fixed during hardening (static-file sibling
leak, XFF spoof, auth-compare crash, `ip2int` garbage) — each has a
failed-before/passes-after regression test.

## Dashboard smoke (manual)

There's no browser E2E to maintain — the HTTP suite already exercises every
route the dashboard uses (accounts, keys, providers, stats, WS auth). To eyeball
the UI itself: open the dashboard → add a key via the form → it appears in the
list (secret masked) and persists via `/api/keys` → delete it → browser console
stays clean.

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

`cc -p` captures claude's output with **clean stdout** (banners + claude's
stderr never pollute the piped result) and classifies the failure:

- **transient 529/overload** → POSTs `/api/events/limit` with `minutes: 2` (short park)
- **real rate-limit / quota** → POSTs `/api/events/limit` for the default **15m**
  (`minutes` accepts 1–360; unknown account → 404)

Parking sets `parked_until` — the next select skips the account until the TTL
passes, **without touching its real usage** (the poller keeps the % honest, and
the account auto-recovers when the park expires). Then the wrapper retries the
next-best account via `/api/select?exclude=…` (up to 3). Verified with a fake
`claude` that rate-limits account A: the wrapper reported the limit and switched
to B, with `access_log` showing `select → limit → select`.
