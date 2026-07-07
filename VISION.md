# aigate — vision

**AisPLB — an AI Secure Proxy & Load Balancer.** One self-hosted place that holds
*every* AI/service key you own, hands them out securely, load-balances where it
helps, and shows you **live what's using what** so nothing runs away.

Born from two real pains:
1. **"Where did I even put that key?"** — accounts scattered across OpenRouter,
   Perplexity, Fireworks, Replicate, AWS, a dozen dashboards signed up for at 1am.
2. **The $500 surprise** — a default install quietly used Opus 4.8 all night
   instead of the cheap model, and the *billing email* was the first alert. A
   live spend view would've caught it at 2am.

## The shape (grows one ring at a time — don't build ahead of need)

```
        ┌─ Claude subscriptions ──→ SELECTOR mode (no proxy: official binary + hooks)
 aigate ┤
        └─ API-key providers ─────→ SECURE PROXY mode (inject key, forward, meter)
           (OpenRouter, Perplexity, Fireworks, OpenAI, Replicate, …)
```

- **Vault** — every key encrypted at rest; clients hold only an aigate token, never raw keys.
- **Secure proxy** (API providers) — clients call aigate; it injects the real key,
  forwards, and logs the request + spend. This is standard & safe for API keys.
- **Selector** (Claude subs) — never proxies Anthropic; picks the account with the
  most headroom and runs the **official** `claude` binary with its token (accepted
  architecture, won't flag accounts).
- **Live usage/spend** — WebSocket dashboard: per-key usage bars, streaming feed,
  per-host/device stats, 🚨 runaway.
- **Audit** — who/what/when/which-IP fetched or used each key.

## Roadmap (ship in rings)

### v1 — NOW (shipped)
- SQLite vault (AES-256-GCM) · usage-aware Claude account selector · IP-audited
  handouts · prompt+usage event ingest · WebSocket dashboard · per-host stats.

### Round 2 — hot layer + spend guard
- **Redis hot layer** (Redis already runs fleet-wide incl. .10):
  - **TTL spend/usage counters** — `INCR` + auto-expiring keys per window
    (5-hour key expires in 5h, daily key at midnight). Atomic, self-resetting,
    sub-ms — *this is the budget guard done right.*
  - **Cached "best key"** so the proxy hot path never re-queries SQL.
  - **Pub/sub event bus** — the one `broadcast()` seam becomes a Redis `PUBLISH`;
    dashboard, alerters, phone push, and multi-instance gateways all `SUBSCRIBE`.
- **Budget guards** — per-key daily/hourly spend caps → alert / auto-disable on
  runaway. (Would have stopped the $500 night.)
- SQL (SQLite→Postgres) stays the durable source of truth; Redis is the hot cache.

### Round 3 — the universal registry
- Generalize `accounts` → `keys(provider, ...)`; providers as first-class config.
- Per-provider usage pollers (OpenRouter/Anthropic/etc. spend APIs) so idle keys
  stay fresh in the dashboard.
- One place that knows every key you have, what it costs, and what's using it.

## Non-goals / guardrails
- **Never** relay/impersonate Claude Code for subscription accounts — selector only.
- No pooling/reselling access for others. Personal, honest, visible.
- Don't build a ring before the previous one has earned it.
