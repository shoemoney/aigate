---
name: add-key
description: Add a third-party API-provider key to aigate's encrypted registry and fetch stored keys to USE them, via aigate's HTTP API. Use when the user wants to store/vault an API key ("add a key for X", "/add-key", "vault this openai/fal/gemini key", "save this API key"), retrieve a stored key for a script/tool ("get my fal key", "use the openrouter key"), see what's vaulted, or rotate one. aigate holds every provider key AES-256-GCM-encrypted so boxes fetch on demand instead of hardcoding secrets.
---

# add-key — vault & use provider API keys via aigate

aigate keeps every third-party **API-provider key** in one encrypted registry (AES-256-GCM at rest). Store the value once; any box fetches it on demand instead of hardcoding secrets in config. `list` never returns secrets — only the per-provider fetch route returns a decrypted key, and every fetch is audited (host/IP).

## 1. Endpoint + auth

- Base URL: **`https://aigate.shoemoney.ai`** (public) or on the LAN **`http://192.168.1.10:20200`**.
- Every call needs `Authorization: Bearer $AIGATE_TOKEN`.
- Get the bearer (in order of preference):
  1. On a wired box: **source** `~/.claude/aigate/env` — it holds `export AIGATE_URL=…` and `AIGATE_TOKEN=…` (values are often quoted, so `grep|cut` mangles them — source it instead, the way `cc` does).
  2. From the host: `ssh -l shoemoney 192.168.1.10 'sudo docker exec aigate env | grep ^AIGATE_TOKEN' | cut -d= -f2-`

```bash
BASE=https://aigate.shoemoney.ai
# source the wired-box env (parses export + quotes correctly); fall back to host
if [ -f ~/.claude/aigate/env ]; then set -a; . ~/.claude/aigate/env; set +a; fi
T="${AIGATE_TOKEN:-$(ssh -l shoemoney 192.168.1.10 'sudo docker exec aigate env | grep ^AIGATE_TOKEN' | cut -d= -f2-)}"
BASE="${AIGATE_URL:-$BASE}"
AUTH=(-H "Authorization: Bearer $T")
```

## 2. Add / update a key

`POST /api/keys {provider, key, label?, status?}` — upserts on (provider, key_hint).

```bash
curl -s "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BASE/api/keys" \
  -d '{"provider":"openai","key":"<VALUE-only>","label":"personal"}'
```

Conventions:
- **Store the VALUE only** — never the `OPENAI_API_KEY=` / `export ` prefix or surrounding quotes.
- **`provider`**: lowercase short id from the catalog (see §5): `openai`, `fal`, `google`, `openrouter`, `perplexity`, `anthropic`, `groq`, `deepseek`, `xai`, …
- **`label`** = nickname/owner. Keys are **personal unless the user says otherwise**; use a given nickname (e.g. `AmberSinclair`) else `personal`.

## 3. List what's vaulted (no secrets)

`GET /api/keys` → `id, provider, label, key_hint, status`.

```bash
curl -s "${AUTH[@]}" "$BASE/api/keys" | python3 -m json.tool
```

## 4. Fetch a key to USE it

`GET /api/keys/<provider>` → `{provider, label, key}` (newest **working** key). This is how a script gets the real secret at runtime:

```bash
OPENAI_API_KEY=$(curl -s "${AUTH[@]}" "$BASE/api/keys/openai" | python3 -c 'import sys,json;print(json.load(sys.stdin)["key"])')
# → now call the provider with $OPENAI_API_KEY
```

`404 {"error":"no working key for <provider>"}` = none vaulted for that provider.

## 5. Provider catalog

`GET /api/providers` returns the ~56 known providers with `id`, `name`, `cat`, key `prefix`, `base` URL, and `oaiCompat` flag. Use it to pick the right `id` and to know the key format:

```bash
curl -s "${AUTH[@]}" "$BASE/api/providers" | python3 -c 'import sys,json;[print(p["id"],"-",p["name"]) for p in json.load(sys.stdin)]'
```

Common ids: `openai openrouter google anthropic groq mistral cohere deepseek xai perplexity fal replicate huggingface together fireworks elevenlabs deepgram stability voyage`.

## 6. Rotate / expire

Add the new key, then delete the old id. The fetch route returns the **newest working** key, so a fresh add wins immediately even before you prune.

```bash
curl -s "${AUTH[@]}" -H 'content-type: application/json' -X POST "$BASE/api/keys" -d '{"provider":"fal","key":"<new>","label":"personal"}'
curl -s "${AUTH[@]}" "$BASE/api/keys" | python3 -c 'import sys,json;[print(k["id"],k["provider"],k["key_hint"]) for k in json.load(sys.stdin) if k["provider"]=="fal"]'
curl -s "${AUTH[@]}" -X DELETE "$BASE/api/keys/<old-id>"
```

## Notes

- Add/list/fetch are **live** (no rebuild). The dashboard at `$BASE` also has a **Provider API keys** form (pick provider → paste → Add).
- Only server-code changes need `sudo docker compose up -d --build` in `/mnt/tank/apps/aigate` on .10 (repo: GitHub `shoemoney/aigate`).
- Sibling skill `manage-aigate-keys` covers the same registry — this one is the quick "add & use" path.
