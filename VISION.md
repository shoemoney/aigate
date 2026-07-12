# aigate — vision

**AisPLB — an AI Secure Proxy & Load Balancer.** One self-hosted place that holds
*every* AI/service key you own, hands them out securely, load-balances where it
helps, and shows you **live what's using what** so nothing runs away.

Born from three real pains:
1. **"Where did I even put that key?"** — accounts scattered across OpenRouter,
   Perplexity, Fireworks, Replicate, AWS, a dozen dashboards signed up for at 1am.
2. **The $500 surprise** — a default install quietly used Opus 4.8 all night
   instead of the cheap model, and the *billing email* was the first alert. A
   live spend view would've caught it at 2am.
3. **Latent capacity you don't use** — so many accounts accumulated that just
   *managing* the keys is a barrier, so you under-use services you already pay for.
   A frictionless vault turns "ugh, where's that key" into "just use it" — the
   convenience is what actually unlocks the capacity you're sitting on.

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
- …and everything that landed after the first cut: 59-provider key registry +
  add-key UI · over-limit TTL-park retry · self-heal (`/health` + watchdog +
  autoheal) · boot canary + daily `VACUUM INTO` backups + corruption
  auto-restore · full-mutation audit trail (`/api/access`) · live re-poll
  (`/refresh`) · secret-scrubbed prompt log · read-only capability map
  (`/api/capabilities`).

### Round 2 — hot layer + spend guard
- **Redis hot layer** (Redis already runs fleet-wide incl. .10):
  - **Topology:** master on **.10**, read-replicas on each box reading `localhost`
    → key/usage reads are local + sub-ms, no network hop; writes centralize on the
    master and replicate out. Reads tolerate async-replica lag; **atomic budget
    `INCR` must target the master** so two boxes can't both slip under a cap.
  - **TTL spend/usage counters** — `INCR` + auto-expiring keys per window
    (5-hour key expires in 5h, daily key at midnight). Atomic, self-resetting,
    sub-ms — *this is the budget guard done right.*
  - **Cached "best key"** so the proxy hot path never re-queries SQL.
  - **Pub/sub event bus** — the one `broadcast()` seam becomes a Redis `PUBLISH`;
    dashboard, alerters, phone push, and multi-instance gateways all `SUBSCRIBE`.
- **Budget guards — latching circuit breaker.** Caps keyed by **`provider × model`**
  (not just per-key) — because one key runs many models at wildly different cost
  (grok = pennies, nano-banana image loop = $$$). So you can *"let grok run free,
  hold nano-banana at $5/day"* — surgical, not blunt. (OpenRouter's own limit is
  key-wide only; per-model is aigate's job since every call flows through it.)
  Per-key daily/hourly spend caps too. On breach the key/model is set to a
  **`held` / needs-review** state and **hard-stops**
  — it does NOT auto-resume when the window rolls over. A human must review *why*
  it ran away and **explicitly clear the flag** to re-enable. Dashboard surfaces
  held keys 🚨 with the breach reason + spend. (Would have stopped the $500 night
  *and* forced me to see which Pi did it before it could spend again.)
  - schema: `held INTEGER, held_at, held_reason, cleared_by, cleared_at`.
- **DB backend: SQLite now → MariaDB/Postgres at the multi-instance trigger.** One
  daemon + SQLite is already "centralized" (clients hit the API, never the DB).
  Switch to MariaDB/PG (both already run on .10) the moment you want a **2nd aigate
  instance / HA** or **external tools reading the data directly** — not before. The
  data layer is a thin prepared-statement object over standard SQL, so it's a
  contained swap. Redis (above) covers the hot-read need; SQL's job is durable
  storage + analytics, where the big DB earns it.

### Round 3 — the universal registry
- Generalize `accounts` → `keys(provider, ...)`; providers as first-class config.
- **Quota-aware, cost-first routing.** When a capability is reachable via multiple
  sources (e.g. nano-banana via a Gemini Ultra *plan quota* AND paid OpenRouter),
  route to the **cheapest eligible source first**: included-in-plan quota → prepaid
  balance → paid per-use — only falling through when the cheaper tier is exhausted,
  with the budget breaker guarding the paid tier. The LB dimension is **cost**, not
  just rate-limit headroom. (Real origin: a nano-banana loop fell straight past an
  unused paid Gemini Ultra quota into $$$ paid OpenRouter. Never again.)
- Per-provider usage pollers (OpenRouter/Anthropic/etc. spend APIs) so idle keys
  stay fresh in the dashboard.
- One place that knows every key you have, what it costs, and what's using it.

### Round 4 — discovery + the agent capability layer (far horizon)
- **Inbox discovery sweep** — scan email for billing receipts / signup confirmations
  → auto-surface every paid service you actually have (the forgotten half). One-time
  "here's your real account footprint," then pull keys into the vault.
- **Agent capability registry** — the unlock. `GET /api/capabilities` returns a
  machine-readable map of what's available (`OpenRouter{grok,nano-banana,…}`,
  `Replicate`, `Perplexity`, `AWS`, …). Agents ask *"what do I have access to?"*,
  request a **metered + audited** key on demand, and dormant subscriptions become
  **tools the fleet automatically knows it can reach** — with the budget breaker
  watching. Turns "so many accounts I'd love to use" into "my agents just use them."

## Caps cascade + per-agent routing (the "sleep well" layer)
- **Cascade of caps** — a hard ceiling at every level, each a latching breaker:
  **global $/period → per-provider → per-`provider×model`**. Even if a per-model
  config is wrong, the **global cap is the backstop that saves you** (esp. with
  auto-topup providers that silently refill — see below).
- **⚠️ Auto-topup = no natural floor.** Postpaid/auto-reload providers (OpenRouter
  reloading $50 increments) *never go dark* — a runaway just refills 10× overnight
  = the $500 morning. The budget breaker is then the *only* safety net → the global
  cascade cap is mandatory, not optional.
- **Per-agent routing & policy** — each agent (identified by its aigate token /
  agent-id) gets its own lane: which providers/models it may touch, its own budget
  slice, its own priority tier + preferred/cheap-first models. A background agent
  routes to cheap models on a small budget; a critical agent gets premium + more.
  Combined with per-model caps, **an agent literally cannot exceed its lane.**
- **Network gate** — `AIGATE_ALLOW_CIDR` (shipped in v1): allow-list of CIDRs +
  single IPs; only your fleet (± a chosen external box) can even reach the daemon.

## Integrations — meet agents where they live
aigate is *just an HTTP API + a token vault*, so any agent framework integrates with a thin
plugin (~a few calls): "give me the best key for `<capability>`" → metered + audited key back.
Ship first-class plugins for the major frameworks so the whole fleet shares **one vault, one
budget breaker, one capability registry**:
- **Hermes** (already the fleet's agent runtime — natural first plugin)
- **OpenClaw / claw**, LangChain, LlamaIndex, n8n, and raw `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` drop-in.

The plugin *is* the delivery vehicle for the Round-4 capability registry: instead of each
framework re-implementing key handling, they all ask aigate. Distribution + safety in one move.

## Non-goals / guardrails
- **Never** relay/impersonate Claude Code for subscription accounts — selector only.
- No pooling/reselling access for others. Personal, honest, visible.
- Don't build a ring before the previous one has earned it.
- **`/api/capabilities` stays READ-ONLY** — the Round-4 registry endpoint reports
  counts + selectability, never meters/holds/forwards. Anything that puts aigate
  *in a provider's request path* (spend metering, held/budget breaker, metered
  on-demand handout) stays **UNBUILT** until the secure-proxy ring earns it —
  that's the drift to catch in review.

## Deferred by design (triggers)
One line per ring — the thing that has to *bite* before it earns its code, so the
audit loop doesn't drift into over-building:
- **Secure-proxy / metering mode** → only when a real API-key spend surprise a live
  meter would've stopped bites **and** a client will actually route provider calls
  through aigate.
- **Full budget/spend breaker** → only **after** the proxy is live and carrying
  traffic (it's blind to spend without it).
- **Redis hot layer** → only when you **measure** real SQLite contention **or** a
  2nd process needs the event bus.
- **MariaDB/Postgres** → only at a 2nd instance / HA, or external tools reading the
  DB directly.
- **Cost-first routing + per-agent lanes** → gated behind the proxy + universal
  registry.
- **Framework plugins** → only when a real agent needs a key plain `GET /api/keys`
  can't satisfy.
- **Inbox discovery sweep** → never daemon code — a standalone throwaway script if
  ever.
