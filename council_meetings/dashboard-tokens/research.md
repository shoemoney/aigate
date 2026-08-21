# Research — dispatched Operator + CHAIR's first-hand measurements

The chair's items are marked **CHAIR-VERIFIED**: run on this machine, command and output given.
They outrank anything a member or Operator recalls. Where the chair's check **contradicts** the
Operator, that is flagged explicitly — members must retract or defend.

---

## R1. CHAIR-VERIFIED — the hook's last-message-only read undercounts by 92%

This resolves brief items **U1**, **U2** and **C5**, which the brief named as possibly decisive.

Method: parsed this very session's transcript
(`~/.claude/projects/-Users-shoemoney-Projects-aigate/b87f3594-….jsonl`), grouped assistant
messages into user turns, **deduplicated by `message.id`**, and compared what
`tokens-hook.sh` would report (last assistant message only) against the sum over all messages.

### R1a. First, a trap that invalidated the chair's own first attempt

**60% of assistant lines in the transcript are DUPLICATES** — the same `message.id` written
repeatedly (one JSONL line per content block: thinking, text, tool_use). Raw lines: 162.
Unique messages: **65**.

The chair's first pass summed raw lines and produced a "98.7% undercount". That number was
**wrong** — it summed triplicates. Any design that walks this transcript MUST dedupe by
`message.id` or it overcounts by roughly 2.5×. Recorded because it is a live trap for whoever
implements this, and because the chair nearly published it.

### R1b. Corrected measurement (deduped, 5 user turns, 65 unique messages)

| turn | msgs | hook reports (last-only) | actual billed | captured |
|---|---|---|---|---|
| 1 | 6 | 85,190 | 471,932 | 18.0% |
| 2 | 7 | 98,613 | 659,800 | 14.9% |
| 3 | 38 | 150,938 | 4,865,640 | **3.1%** |
| 4 | 1 | 151,383 | 151,383 | **100%** |
| 5 | 13 | 174,406 | 2,152,094 | 8.1% |
| **session** | **65** | **660,530** | **8,300,849** | **8.0%** |

**The hook as written captures 8.0% of billed tokens — a 92% undercount.** Accuracy degrades as
the turn gets more agentic: the 38-message turn captured 3.1%. It is exactly correct only for a
**single-message turn** (turn 4), i.e. a plain question with no tool use.

This fleet's dominant workload is multi-step agentic turns. So the hook would not merely be
approximate — it would be wrong by more than an order of magnitude on the traffic that matters,
and *systematically* wrong in a way that makes heavy sessions look light.

### R1c. Why "billed" is itself three different metrics

Per-message the four fields behave very differently:

- `input_tokens` ≈ **2**, constant and negligible
- `cache_read_input_tokens` grows **monotonically** across a turn (84,898 → 150,938 in turn 3) —
  it is the whole conversation replayed to each API call
- `cache_creation_input_tokens` — the new slice cached this call
- `output_tokens` — actual generation, clean and additive

Consequences the council must rule on (**brief item C4**):

1. **Summing all four** gives billed volume, but is ~95% `cache_read`, which bills at roughly a
   **10% rate**. So the composite is not cost, and not context size. It is a number with no clean
   English meaning — which is what the column header `tokens` currently promises.
2. **`output_tokens` summed** is clean, additive, never double-counted: 23,942 for turn 3. A
   defensible "work done" metric.
3. **Last message's `cache_read + cache_creation`** = context size at end of turn (149,503 for
   turn 3). A defensible "context pressure" metric — and, notably, *this* is roughly what the
   existing hook already reports, just mislabelled as "tokens".

---

## R2. CHAIR-VERIFIED — Claude Code has FIRST-PARTY OpenTelemetry. Hooks carry no usage.

Operator finding, then **independently confirmed by the chair** against the actual installed
binary — `/Users/shoemoney/.local/share/claude/versions/2.1.238` (Mach-O arm64, 321MB), the
resolved target of `~/.local/bin/claude`.

```
$ grep -c --binary-files=text -F '<pattern>' <binary>
  claude_code.token.usage          hits=2
  claude_code.cost.usage           hits=2
  CLAUDE_CODE_ENABLE_TELEMETRY     hits=10
  OTEL_METRICS_EXPORTER            hits=10
  OTEL_EXPORTER_OTLP_ENDPOINT      hits=10
  cache_read_tokens                hits=7
```

Full set of telemetry identifiers actually present in the binary:

```
$ strings -a <binary> | grep -oE 'claude_code\.[a-z_.]+' | sort -u
claude_code.active_time.total      claude_code.mcp.rpc
claude_code.bash.subprocess        claude_code.pull_request.count
claude_code.code_edit_tool.decision claude_code.session.count
claude_code.commit.count           claude_code.subagent.spawn
claude_code.compaction             claude_code.token.usage
claude_code.events                 claude_code.tool
claude_code.hook                   claude_code.tool.blocked_on_user
claude_code.interaction            claude_code.tool.execution
claude_code.lines_of_code.count    claude_code.tracing
claude_code.llm_request
```

**CHAIR CORRECTION OF THE OPERATOR:** the Operator reported a log event named
`claude_code.api_request` carrying per-request `input_tokens` / `output_tokens` /
`cache_read_tokens` / `cost_usd`. **That identifier returns ZERO hits.** The real per-request
identifier is **`claude_code.llm_request`**. The Operator's mechanism claim survives; its name
does not. Any member who repeats `api_request` must retract.

Operator's documentation findings (docs.anthropic.com, retrieved 2026-08-21), NOT independently
re-verified by the chair beyond the binary greps above:

- `claude_code.token.usage` is a **counter**, attributes `type` (input / output / cache_read /
  cache_creation), `model`, with further breakdown by `skill.name` / `plugin.name` / `agent.name`
- `claude_code.cost.usage` is a counter of estimated USD
- Env: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER` (`otlp|prometheus|console|none`),
  `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`,
  `OTEL_METRIC_EXPORT_INTERVAL` (default 60000ms)
- **Hooks receive NO token/usage/cost fields** in any event payload. Common fields only:
  `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `prompt_id`.
  → *This is fatal to the entire hook-based approach and directly contradicts the design premise
  of `tokens-hook.sh`, which only works by reaching around the hook payload into the transcript.*
- `claude -p --output-format json` includes `total_cost_usd` plus a per-model cost breakdown,
  described as a **client-side estimate** that "can differ from your actual bill"
- The **transcript JSONL is explicitly internal and changes between versions**, and is written
  asynchronously so it "may lag the in-memory conversation"

That last point compounds R1: `tokens-hook.sh` parses a format that is officially unstable, in a
hook that fires possibly before the final write lands, and fails **open** — so a format change
yields silent zeroes, which is indistinguishable from today's symptom.

---

## R3. CHAIR-VERIFIED — aigate already speaks Prometheus

`src/server.js:854` — `if (p === '/api/metrics' && req.method === 'GET')`. A bearer-gated
Prometheus text endpoint already exists and already exports `aigate_*` series.

Relevant because the OTel path (R2) can export **`OTEL_METRICS_EXPORTER=prometheus`** or OTLP.
The council should consider whether the correct architecture is *"Claude Code exports OTel;
something scrapes it"* rather than *"a bash hook POSTs parsed transcript data to aigate"*. Note
this may put usage data somewhere other than aigate's own `request_log` table, which changes
what the dashboard would render and from where.

---

## R4. CHAIR-VERIFIED — `tps` is a second dead column, and there are already 2 posters

**R4a. `tps` is derived from tokens and is therefore equally dead.**
`src/server.js:847` — `tps: +(r.tokens / 3600).toFixed(2)`.
Live prod `GET /api/stats` → `by_host_1h`:
```
{'host': 'mbp',  'requests': 23, 'tokens': 0, 'rps': 0.006, 'tps': 0}
{'host': 'wick', 'requests': 10, 'tokens': 0, 'rps': 0.003, 'tps': 0}
```
`tps: 0` for every host. The by-host table has five columns — `host, requests, tokens, last seen,
tps` — and **two of the five carry no information**. Any "delete the column" verdict must say what
happens to `tps`; any "wire it up" verdict revives both at once.

**R4b. `requests` double-count (brief item C1) — premise confirmed.**
Two producers already POST to `/api/events/prompt`:
- `clients/prompt-hook.sh:25` (UserPromptSubmit)
- `clients/aigate-run.sh:23` — `report_prompt()`

`src/server.js:823` does one `INSERT` per POST, unconditionally. So `tokens-hook.sh` would be a
**third** producer, and the existing 11,167-row prod history was accumulated under the current
semantics. Any change makes the historical `requests` series non-comparable, and there is no
UPDATE-by-id endpoint to amend an existing row instead.

---

## Bearing on the brief's open items

| item | status after this research |
|---|---|
| U1 / U2 / C5 | **RESOLVED.** Last-message-only captures 8.0% of billed; exact only for single-message turns. |
| U3 | **RESOLVED.** Official path exists and is OTel; hooks carry no usage; transcript is officially unstable. |
| C2 | **STRENGTHENED to near-disqualifying.** Officially internal + async-written + fails open = silent zeroes. |
| C4 | **SHARPENED.** Three distinct real metrics identified; "tokens" as one composite is ~95% cache-read. |
| C1 | **CONFIRMED**, and worse than stated — two producers already exist. |
| U4 / U5 | Still open. U5 (what should the column actually answer?) is now arguably the central question. |

---

## R5. CHAIR-VERIFIED — `request_log.tokens` is DISPLAY-ONLY. Nothing routes on it.

Directly answers two round-1 `open_research` items: *"Does any server path read
request_log.tokens for routing, or is it display-only?"* and *"Confirmation that no selector code
path reads request_log.tokens (full grep readout)."*

Full readout — every occurrence of `tokens` in `src/server.js`, with OAuth/setup-token/max_tokens
noise filtered out:

```
138:  prompt TEXT, tokens INTEGER                                    -- schema
299:  insReq: INSERT INTO request_log(...,tokens) VALUES(...)        -- write
301:  recentReq: SELECT ...,tokens                                   -- read → /api/logs (display)
306:  statByHost: sum(coalesce(tokens,0)) AS tokens                  -- read → /api/stats (display)
313/314: statByHost1h: sum(coalesce(tokens,0)) ...                   -- read → /api/stats (display)
823:  q.insReq.run(..., b.tokens ?? null)                            -- write
847:  tps: +(r.tokens / 3600).toFixed(2)                             -- derived (display)
536:  // comment about poller health, unrelated ("all tokens erroring")
1027: // comment about vault polling, unrelated
```

**Every single read feeds a display surface.** `/api/select` — the account-selection path, the
actual product — never reads `request_log.tokens`. Account selection runs off the poller's
usage-limit/reset data, an entirely separate and *working* signal.

**Consequences for the ruling:**
- Deleting the column is **operationally inert**. No routing, no alerting, no billing, no
  selection behavior changes. The blast radius is two dashboard cells and one derived `tps`.
- The counter-argument *"token usage is the core metric for a token-budget account router"*
  (Trinity, round 1) is **factually wrong about this codebase**: the router does not consume
  tokens and never has. It is an argument for a system aigate is not.
- Conversely, wiring it buys **zero** operational capability today — it is purely an observability
  nice-to-have — while C1 actively degrades `requests`, a metric that IS displayed.

## R6. Round-1 tally, for the record

**4 delete** (mouse, niobe, seraph, tank) — **2 wire-with-fixes** (morpheus, trinity).
6/6 reachable. **Unanimous on one point: do NOT install `clients/tokens-hook.sh` as written.**
Not one member defends the status quo path.

Note both wire-camp members conditioned their vote on U2/C5 being resolved — Morpheus explicitly
refused to rule "before the single controlled multi-message turn experiment." **R1 is that
experiment**, and its answer (8.0% captured, 92% undercount) is materially worse than the
wire-camp assumed. Members must now retract or defend against R1, R2 and R5.
