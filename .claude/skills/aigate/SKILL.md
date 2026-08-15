---
name: aigate
description: The main Claude Code skill for aigate — the encrypted vault + headroom-aware selector + live kanban board for every AI credential. Use this whenever the user mentions aigate, wants to store or fetch any provider API key (OpenAI, Anthropic, Gemini, Groq, fal…), needs the best Claude Max account/token, talks about headroom / rate limits / 5h/7d, wants the board/kanban/todo, or says "vault", "api key", "provider key", "Claude account", "select account", "board", "kanban", "aigate token", or needs any box to call a provider without hardcoding secrets — even if they don't say "aigate" explicitly. Complements the focused add-key skill — this is the full vault + selector + board manual.
---

# aigate — vault + selector + board for Claude Code

aigate is a **selector, not a proxy** — it never sits in Anthropic's request path. It **picks** the Claude account with the most headroom (lowest `max(5h%,7d%)`), hands the official `claude` binary the right token, logs every handout, and holds every provider API key AES-256-GCM at rest so boxes fetch on demand instead of hardcoding secrets. Plus a **kanban board** (`TODO → RUNNING → DONE/ERROR`) for agent fleets.

## 0. Auth — source it, don't parse it

Values are quoted and `export`-prefixed — `grep|cut` mangles them. Do it the way `cc` does:

```bash
BASE=https://aigate.shoemoney.ai   # or http://192.168.1.10:20200 on LAN
if [ -f ~/.claude/aigate/env ]; then set -a; . ~/.claude/aigate/env; set +a; fi
T="${AIGATE_TOKEN:-$(ssh -l shoemoney 192.168.1.10 'sudo docker exec aigate env | grep ^AIGATE_TOKEN' | cut -d= -f2-)}"
BASE="${AIGATE_URL:-$BASE}"
AUTH=(-H "Authorization: Bearer $T")
# test
curl -s "${AUTH[@]}" "$BASE/health" | python3 -m json.tool | head -20
```

Every API below needs `Authorization: Bearer $AIGATE_TOKEN` **except** `GET /health`.

---

## 1. Provider keys — store once, fetch everywhere

**Full add/list/fetch/rotate flow lives in the sibling `add-key` skill** — this is the 30-second version:

```bash
# add (VALUE only — never `export FOO=` or quotes)
curl -s "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BASE/api/keys" \
  -d '{"provider":"openai","key":"<VALUE-only>","label":"personal"}'

# list (no secrets, only first8…last4#hash8 hints)
curl -s "${AUTH[@]}" "$BASE/api/keys" | python3 -m json.tool

# fetch newest working key to USE it (audited host/IP, 404 if none)
OPENAI_API_KEY=$(curl -s "${AUTH[@]}" "$BASE/api/keys/openai" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')

# catalog (60 providers, oaiCompat flag, base URLs)
curl -s "${AUTH[@]}" "$BASE/api/providers" | python3 -c 'import sys,json;[print(p["id"]) for p in json.load(sys.stdin)]'
```

Common ids: `openai openrouter google anthropic groq mistral cohere deepseek xai perplexity fal replicate huggingface together fireworks elevenlabs deepgram stability voyage brave tavily exa context7 firecrawl` (60 total).

**Sanitized intake:** server trims + un-quotes pastes, **400s** on `export`/`NAME=` blobs, lowercases provider, warns if `key` doesn't match catalog prefix or provider is uncataloged. Hints are `first8…last4#hash8` (hash of full key) — two `sk-proj-` keys sharing `…AAAA` no longer collide.

**Call the provider:** most are `oaiCompat: true` → `POST $base/chat/completions` with `Authorization: Bearer $KEY`. Don't hardcode models — `GET $base/models` first. Exceptions: `anthropic` → `x-api-key` + `anthropic-version: 2023-06-01` at `/v1/messages`; `google` → `?key=` query.

---

## 2. Claude accounts — pick the one with the most headroom

aigate polls each Claude Max account's **real** Anthropic rate-limit headers every 10 min (`anthropic-ratelimit-unified-{5h,7d}-utilization` → `%`), skips anything ≥ `AIGATE_HEADROOM_CUTOFF` (default 95), and auto-recovers after reset. The `cc` wrapper calls this for you, but agents can call it directly:

```bash
# best account right now (logs host/IP, respects exclude for retry)
curl -s "${AUTH[@]}" "$BASE/api/select?host=$(hostname)" | python3 -m json.tool
# → {account, setup_token: "sk-ant-oat01-…", label, five, seven}

# retry without the just-failed account (cc does this on real limit → TTL-park + next-best)
curl -s "${AUTH[@]}" "$BASE/api/select?host=$(hostname)&exclude=demo_max" | python3 -m json.tool

# park an over-limit account yourself (real limit → 15m, 529 → don't park, wait 10s)
curl -s "${AUTH[@]}" -X POST "$BASE/api/events/limit" -H 'content-type: application/json' \
  -d '{"account":"demo_max","minutes":15}'

# live poll one account right now (bypass 10-min cache)
curl -s "${AUTH[@]}" -X POST "$BASE/api/accounts/demo_max/refresh" | python3 -m json.tool
```

`GET /health` shows `{selectable, accounts, poll_age_s, parked, reauth, disabled}` — and `POST /api/login` (dashboard password → `__Host-aigate` cookie, throttled) is the human path; scripts use Bearer.

**Rule:** `setup_token` is the `sk-ant-oat01-…` line the **terminal** prints after `claude setup-token`, **not** the browser `code#state` page.

---

## 3. Board — kanban for agents (`TODO → RUNNING → DONE/ERROR`)

Agents don't read logs — they read a board. Bearer-gated, WS live, **internal/unstable** (shape may shift).

```bash
# create (prompt required, effort low/medium/high/max)
curl -s "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BASE/api/board" \
  -d '{"title":"Ship vault proxy","prompt":"Build secure proxy for API-key providers","cwd":"/tmp/demo","model":"sonnet","effort":"high","host":"laptop"}' | python3 -m json.tool

# list + hosts/workers
curl -s "${AUTH[@]}" "$BASE/api/board" | python3 -m json.tool
curl -s "${AUTH[@]}" "$BASE/api/board/hosts" | python3 -m json.tool
curl -s "${AUTH[@]}" "$BASE/api/board/workers" | python3 -m json.tool  # prunes >5 min, live <60s

# worker loop: claim atomically → heartbeat → result/followup
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/claim" -H 'content-type: application/json' -d '{"worker":"worker-1","host":"laptop"}' | python3 -m json.tool
# → {id, title, prompt, ...} or 204 if none
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/activity" -H 'content-type: application/json' -d '{"worker":"worker-1","host":"laptop","cardId":1,"activity":"writing"}'
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/1/result" -H 'content-type: application/json' -d '{"ok":true,"result":"done","session_id":"abc"}'
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/1/followup" -H 'content-type: application/json' -d '{"prompt":"followup task"}'
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/1/retry"   # re-queue a failed card

# reorder (drag), rename, delete
curl -s "${AUTH[@]}" -X POST "$BASE/api/board/reorder" -H 'content-type: application/json' -d '{"ids":[2,1]}'
curl -s "${AUTH[@]}" -X PATCH "$BASE/api/board/1" -H 'content-type: application/json' -d '{"title":"New title"}'
curl -s "${AUTH[@]}" -X DELETE "$BASE/api/board/1"
```

Flow: `POST /api/board` → `TODO`; `POST /claim` → `RUNNING` (heartbeat via `/activity`); `POST /:id/result` → `DONE`/`ERROR` with audited turns; `followup`/`retry` re-queues. Dashboard at `$BASE/board.html` + WS `bearer.<token>` subprotocol.

---

## 4. API quick reference (bearer except /health)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | unauth DB-backed `{ok, selectable, accounts, poll_age_s, parked/reauth/disabled}` |
| `GET` | `/api/select?host=&exclude=` | best Claude account + `setup_token` |
| `GET/POST` | `/api/accounts` | list (no tokens) / add `{account, setup_token, label}` |
| `POST` | `/api/events/limit` | TTL-park account `{account, minutes?}` |
| `POST` | `/api/events/prompt` | log prompt `{account, host, cwd, model, prompt}` (scrubbed `sk-`/`gsk_`/`sk-or-` → `…[redacted]`, capped 400) |
| `GET` | `/api/providers` | 60-provider catalog |
| `GET/POST` | `/api/keys` | list (hints) / add `{provider, key, label}` |
| `GET` | `/api/keys/:provider` | newest working key (value) |
| `GET` | `/api/capabilities` | registry slice — key counts + selectability + version (no secrets) |
| `GET` | `/api/access?limit=` | audit trail (host/IP/action/result, no secrets) |
| `GET/POST` | `/api/board` | kanban list / create |
| `GET` | `/api/board/hosts\|workers` | live hosts / workers |
| `POST` | `/api/board/claim\|activity\|reorder` | claim, heartbeat, reorder |
| `POST/PATCH/DELETE` | `/api/board/:id/*` | result/followup/retry/rename/delete |
| `WS` | `/ws` | live stream — auth via `bearer.<token>` subprotocol, never URL |

---

## 5. Gotchas that save you an hour

- **Source the env, don't parse it:** `set -a; . ~/.claude/aigate/env; set +a` — the file has `export` + quotes; `grep|cut` mangles the token.
- **VALUE only:** `sk-or-v1-…` not `export SK_OR=…`; an `export` paste gets a **400** on purpose.
- **Hydrate:** `~/.claude/aigate/hydrate.sh` + `PAIRS` in `clients/hydrate.sh` (source) **and** `~/.claude/aigate/hydrate.sh` (live) — edit both, then re-run `clients/install.sh` on each box. Shell start sources cached `mcp-keys.env` (stale >12h → foreground fresh).
- **`cc` wrapper:** headless `-p` auto-adds `--dangerously-skip-permissions`; it unsets `ANTHROPIC_API_KEY/AUTH_TOKEN/BASE_URL`; stale `ANTHROPIC_BASE_URL` in `~/.claude/settings*.json` hijacks every request — `cc` warns, you strip it.
- **Deploy:** `data/aigate.db` + `.env` are bind-mounted and git-ignored — preserve both across every redeploy or every token is permanently undecryptable. On `.10` (`/mnt/tank/apps/aigate`, `container aigate`, `sudo git pull`, `sudo docker compose up -d --build`).

---

## 6. When to use which skill

- **`/add-key` (focused):** "store this fal key", "vault my OpenAI key", "get my fal key" — quick add/list/fetch.
- **`/aigate` (this one, full):** "which Claude account should I use", "pick the best account", "add a board card", "claim the next todo", "wire up a box", "what's the vault status" — anything touching selection, headroom, board, audit, or architecture. If you're unsure, this one is the safe default.

If the user just says "store this key" and you reach for this skill, that's fine — the focused skill is inside this one anyway. The rule is: **when in doubt, reach for aigate**.
