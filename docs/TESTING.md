# 🧪 aigate testing

How aigate is tested, and how to re-run every layer. Nothing here needs a
framework — Node 24's built-in test runner + a couple of shell scripts.

## Layers

| Layer | What it proves | Run it |
|-------|----------------|--------|
| **Unit** (`test/lib.test.js`) | Vault crypto (GCM tamper-detect), CIDR/IP gate, timing-safe token compare, static-path containment, token-liveness classifier | `npm test` |
| **HTTP integration** (`test/http.test.js`) | Every route end-to-end on a throwaway DB: auth gate, accounts/keys round-trips (secrets never leak), **sanitized key intake** (quote-strip, `export`/`NAME=` → 400, `first8…last4` hints, normalized lookups), selector, **exclude retry**, **TTL parking** (+ 404 on unknown accounts), reauth-skip, **boot canary**, **vault backups**, `/health` selectable parity, providers catalog, **WS `bearer.<token>` subprotocol auth** | `npm test` |
| **Client behavior** (`test/switching-client.test.js`) | The `[Y/n]` prompt is gone (interactive **auto-switch**), and `prompt-hook.sh` re-evaluates the account **every turn** — parks it when exhausted, leaves it alone with headroom, no-ops on sessions without `AIGATE_ACCOUNT` — driven against a **mock aigate**; backgrounded work is stdio-detached (**zero turn latency**) | `npm test` |
| **Boot guards + key rotation** (`test/boot.test.js`) | Spawns a fresh `node src/server.js` per case: bad `AIGATE_HEADROOM_CUTOFF` is FATAL, `AIGATE_VERSION` override, a canary written under a different key is FATAL, `rotate-key.js` re-encrypts the vault, and the Codex restore guard / ledger (restored old DB → `refresh_unknown`, zero token calls, one alert; missing, corrupt or unwritable ledger handled) | `npm test` |
| **Codex server** (`test/codex-server.test.js`) | Codex (ChatGPT) accounts beside Claude, against one fake upstream: both `auth.json` import shapes, kind isolation in select, `wham/usage` window mapping, aigate-owned OAuth refresh (`invalid_grant` → reauth, ambiguous failures → `refresh_unknown`, single shared refresh), `/api/codex/sync` and `/api/codex/auth`, edge-triggered alerts, ledger | `npm test` |
| **Codex client** (`test/codex-client.test.js`) | `aigate-codex.sh` / `t3-codex.sh` / `ai` against a mock aigate and a fake `codex`: 0600 `auth.json`, print-mode flag translation and retry on usage limits, pre/post token sync, `--write-only` / `--adopt` / `--keep` keeper, sticky live-session accounts, signal exits, fail-open, `install.sh` launchd/systemd/cron wiring, binary resolver | `npm test` |
| **Anthropic proxy** (`test/proxy.test.js`) | `POST /v1/messages` + `GET /v1/models` for API-key providers: Anthropic-shaped 401/400 envelopes, tier-alias and `provider:model` routing, the setup-token guard, key failover, 429 passthrough, SSE streaming and client-abort teardown, 529 when no key is vaulted, muse and qwen routing | `npm test` |
| **OpenAI proxy** (`test/oai-proxy.test.js`) | `POST /v1/chat/completions` and `/v1/responses`, the OpenAI-shape mirror of the proxy suite: OpenAI error envelopes, bare-model routing (openai, qwencloud, deepseek, grok, sonar, openrouter fallback), upstream URL shape, body passthrough, failover, 429, SSE, 529, superset `/v1/models` rows | `npm test` |
| **`ai` router + installer** (`test/ai-router.test.js`) | The `ai` entry-point route table and fail-open guards, `ai usage` (grouping, ★ picks, `--json`, 80-col fit, unreachable server), `install.sh` into a scratch root, plus static hygiene on `clients/` (`bash -n`, shellcheck, bash 3.2 compatibility, no CLIProxyAPI references) | `npm test` |
| **Spend pricing** (`test/spend-pricing.test.js`) | Pure price arithmetic: micro-dollar conversion, Anthropic vs OpenAI cache conventions, 1h cache-write clamp, no-rate meters bill as fresh input, long-context tier at 272001 input tokens, half-up rounding and BigInt precision, `pickRate` (dated, exact beats prefix, unknown stays null, Kimi coding plan unpriced), billing class, seed integrity, space-bunny at exactly 1/5 of `claude-opus-5-5` | `npm test` |
| **Spend server** (`test/spend-server.test.js`) | Every `/api/spend*` route behind the auth gate, price seed once, ingest dedupe (replay and in-batch), whole-batch validation, pricing at ingest and `unpriced_models`, session attribution in both arrival orders plus the time rule and Codex leases, billing classes, `GET /api/spend` totals equal sum of groups with no `tokens` key, 400s for bad parameters, price PUT/reprice, retention prune, audit rows carry counts only | `npm test` |
| **Spend collector** (`test/spend-collector.test.js`) | `clients/aigate-spend.js` against fixtures: exact parity with expected events for Claude and both Codex rollout shapes, `message.id` dedupe, half-written lines, byte-offset cursor and truncation, 7-day first run vs `--backfill` and `--since`, exit codes (503, 401, unreachable), `--dry-run`, batching, sidecar replay, no prompt or tool text on the wire, no 2^31 clamp on long Codex sessions | `npm test` |
| **Spend clients** (`test/spend-clients.test.js`) | `prompt-hook.sh` session mapping and sidecar, `aigate-codex.sh` `CODEX_HOME` leases, and `install.sh` scheduling the collector: launchd agent, systemd timer every 15 min, idempotent crontab fallback, no scheduling when node is older than 24, bash 3.2 parse | `npm test` |
| **Spend dashboard** (`test/spend-dashboard.test.js`) | Spend section markup and nav wiring, no bare "tokens" label, honesty strip (collectors, unpriced, unattributed), inline scripts compile, `loadSpend` query and 404 empty state, collector freshness thresholds, 5-minute refresh, boot-time load, unknown-plan value visible in chart and table | `npm test` |
| **Otari import** (`test/spend-import-otari.test.js`) | `scripts/spend-import-otari.js`: `--help`, `--dry-run`, `--before` / `--source` filters, ids and tokens round-trip, imported totals show in `GET /api/spend`, a re-run is all duplicates, failed post exits 2 | `npm test` |
| **Dashboard smoke** (manual) | The key-add UI adds → persists → deletes with the secret masked — every route it touches is already covered by the HTTP tests | see below |
| **Fleet integration** (`clients/test-switching.sh`) | A real Pi runs `ai -p` through aigate, and account selection **switches** correctly as accounts are disabled/enabled — logged in the DB | see below |

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

## Continuous re-eval + auto-switch (client behavior) 🔄

`test/switching-client.test.js` proves the two client-side behaviors that make
selection **continuous + automatic** — no live accounts or real `claude` needed.
It drives `clients/prompt-hook.sh` against a **mock aigate** (an in-process HTTP
server) and static-checks `clients/aigate-run.sh`:

- **No `[Y/n]`** — the interactive supervise loop's confirm prompt is gone; on
  exhaustion it auto-continues (`claude --continue`) on the next account.
- **Per-turn parking** — when the current account is **≥85 % + live-refresh-confirmed
  maxed**, the hook `POST`s `/api/events/limit` to park it immediately (fleet-wide
  reroute); with headroom it does **nothing** (and skips the costly refresh).
- **Fail-open** — a session that did not come through an aigate launcher (`ai`, T3, cmux — no `AIGATE_ACCOUNT`) triggers **zero**
  selection side effects.
- **Zero turn latency** — both backgrounded blocks detach stdio, so the hook
  returns instantly regardless of the HTTP calls (the test polls the mock rather
  than relying on the child holding the pipe open).

- **Supervise contract** — a `supervise` test in the same file runs
  `clients/aigate-run-supervise.test.sh` (fake aigate + hanging fake `claude`) and
  asserts `all ok`: TERM to the print-mode wrapper must kill the `claude` it launched.
  It scrubs `AIGATE_URL`/`AIGATE_TOKEN` and skips when `python3`/`bash` is missing.

## Dashboard smoke (manual)

There's no browser E2E to maintain — the HTTP suite already exercises every
route the dashboard uses (accounts, keys, providers, stats, WS auth). To eyeball
the UI itself: open the dashboard → add a key via the form → it appears in the
list (secret masked) and persists via `/api/keys` → delete it → browser console
stays clean.

## Fleet switching test — the real proof 🔁

Installs the client on a box, then flips accounts and watches `ai` follow.

```bash
# on the target box (e.g. a Pi):
AIGATE_URL=https://aigate.example  AIGATE_TOKEN=…  bash clients/install.sh
bash clients/test-switching.sh <defaultPick> <otherAccount>   # defaultPick = the ⭐ in `ai usage`
```

It toggles `disabled` on each account and asserts the selected account flips,
with a real `ai -p 'PONG'` succeeding every time. Then confirm the audit trail:

```bash
sqlite3 data/aigate.db \
  "SELECT ts,account,action,result FROM access_log WHERE host='<box>' ORDER BY id DESC LIMIT 8;"
sqlite3 data/aigate.db \
  "SELECT ts,account,substr(prompt,1,40) FROM request_log WHERE host='<box>' ORDER BY id DESC LIMIT 8;"
```

### Verified run (2026-07-08, Pi `twojeffs` → `aigate.shoemoney.ai`)

| State | Expected | Picked | `ai -p` result |
|-------|----------|--------|----------------|
| both enabled | shoemoney (1% vs 19%) | shoemoney | `PONG` |
| shoemoney disabled | personal | personal | `PONG` |
| personal disabled | shoemoney | shoemoney | `PONG` |
| both enabled | shoemoney | shoemoney | `PONG` |

Every switch landed in `access_log` (`select`/`ok`) and `request_log`.

## Over-limit detect + retry

`ai -p` captures claude's output with **clean stdout** (banners + claude's
stderr never pollute the piped result) and classifies the failure:

- **transient 529/overload** → **waits 10s and retries the SAME account** (no park — 529 is
  Anthropic-global load-shedding; parking/hopping just drains the pool)
- **real per-account usage limit / quota** → POSTs `/api/events/limit` for the default **15m** TTL park
  (`minutes` accepts 1–360; unknown account → 404)

Parking sets `parked_until` — the next select skips the account until the TTL
passes, **without touching its real usage** (the poller keeps the % honest, and
the account auto-recovers when the park expires). Then the wrapper retries the
next-best account via `/api/select?exclude=…` (up to 3). Verified with a fake
`claude` that rate-limits account A: the wrapper reported the limit and switched
to B, with `access_log` showing `select → limit → select`.
