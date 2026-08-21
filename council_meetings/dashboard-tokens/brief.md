# Brief — the aigate dashboard's "tokens" column shows nothing. Wire it, or cut it?

## The question

The aigate dashboard renders a **tokens** column in two places. It is empty for essentially every
row, in both. The user's instruction: *"see what we need to do to make the dashboard display the
tokens used part — if it can't be done we can just remove it."*

So: **can real per-account / per-host token usage be displayed, at acceptable cost — or is the
honest move to delete the column?**

This is not a greenfield design question. Most of the machinery already exists. The council's job is
to rule on whether the *remaining* gap is worth closing, and if so, which of several bad trade-offs
is least bad.

---

## Measured facts (chair verified each of these directly — commands and output below)

### F1. The server-side chain is COMPLETE. VERIFIED.

Every layer below the reporter already handles tokens:

| Layer | Location | State |
|---|---|---|
| Schema | `src/server.js:138` — `prompt TEXT, tokens INTEGER` | present |
| Insert | `src/server.js:299` `INSERT INTO request_log(...,tokens)`; `:823` `b.tokens ?? null` | accepts tokens on POST |
| Aggregate | `src/server.js:306,313` — `sum(coalesce(tokens,0)) AS tokens` | sums per host, and per host over 1h |
| Rate | `src/server.js:847` — `tps: +(r.tokens / 3600).toFixed(2)` | tokens/sec derived |
| UI feed | `public/index.html:412,420` — `<span class="tk num">{{ r.tokens }}</span>` | renders |
| UI table | `public/index.html:431,435` — by-host `tokens` column | renders |

Nothing needs to be built server-side. **The only missing link is a producer.**

### F2. A complete Stop-hook reporter EXISTS in the repo and is NEVER INVOKED. VERIFIED.

`clients/tokens-hook.sh` (4.8K, mode 0755) — added in `02e326e`, merged to main in `cd78c58`. It is
a finished, careful implementation: reads the Claude Code session transcript JSONL, walks to the
last assistant message carrying a `usage` block, sums
`input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens`, dedups
against a per-session cache file, and POSTs to `/api/events/prompt`. It is defensive throughout and
fails open.

**But it is wired to nothing.** Three independent checks:

```
$ grep -n 'tokens-hook' clients/install.sh
  (no output — NOT installed by the installer)

$ ls ~/.claude/aigate/ | grep -i hook
  prompt-hook.sh          # tokens-hook.sh was never deployed here

$ python3 -c "...json.load(open('~/.claude/settings.json'))['hooks']['Stop']"
  [aaa-selfimprove.sh, nohumans.js journal --hook]     # neither is tokens-hook.sh
```

Its own header says so plainly:
> `NOT INSTALLED by clients/install.sh (proposal only — wire it in yourself for now)`

This is the *declared-but-never-invoked* failure shape: the artifact exists, is correct, passed
review, and is connected to nothing — so the system behaves exactly as if it were never written,
while every inspection confirms it is there.

### F3. Production data: 11,167 requests, 13 tokens total. VERIFIED.

Read-only `GET /api/stats` against prod (`https://aigate.shoemoney.ai`, HTTP 200):

| host | requests | tokens |
|---|---|---|
| mbp | 9,259 | **13** |
| wick | 1,097 | 0 |
| hueb | 407 | 0 |
| reek | 390 | 0 |
| amber | 9 | 0 |
| nas | 5 | 0 |
| **total** | **11,167** | **13** |

Thirteen. Not thirteen thousand. A single real Claude turn is typically thousands of tokens, so 13
across 11k requests is almost certainly one hand-crafted test POST during development, not
telemetry. **Effectively the column has never carried data.**

### F4. The UI's own explanatory comments are now STALE. VERIFIED.

`public/index.html:1081-1083` and `:703-705` tell the reader:

> *"tokens are always 0/null in this system — see CLAUDE.md; the reporting hook fires on
> UserPromptSubmit, before the model has responded, so the real count never exists at write time."*

That was true when written. It is no longer the whole truth: a Stop-hook reporter — which fires
*after* the turn, when the count does exist — has since landed in-repo (F2). The comment now
describes a limitation that has been solved in code but not deployed. A reader trusting the comment
would conclude the problem is architectural when it is actually a packaging gap.

The dashboard currently renders `—` rather than a confident `0`, which is the honest choice given
no data. That part is good and was a deliberate design-jury decision (`0fa66d9` "honest empty-state
+ honest tokens").

---

## The known costs of wiring it — stated by the hook's own author

These are documented in `clients/tokens-hook.sh`'s header as accepted trade-offs. The council should
rule on whether they are acceptable, or whether a different design is warranted.

**C1 — request counts roughly double.** The server has no endpoint to UPDATE an existing
`request_log` row by id. So the hook posts a **new** row (with `prompt: ""`) rather than amending the
prompt row written earlier by `prompt-hook.sh`. Consequence: `/api/stats` per-host `requests` counts
roughly **2× per turn**. The author argues `tokens` and `tps` stay correct because the prompt row
always carries `tokens=null`. **But `requests` is itself a displayed dashboard metric** — so fixing
the tokens column corrupts the requests column. Is that trade acceptable? Is adding a
`PATCH /api/events/prompt/:id` the right answer instead? Note prod already holds 11,167 rows under
the old semantics, so any change makes the historical series non-comparable.

**C2 — the transcript JSONL is an undocumented internal format.** The hook parses Claude Code's own
session transcript. The author notes the format "has shifted before" and codes defensively. This is
a dependency on an internal contract that no test covers and that can break silently on any Claude
Code update — and it fails *open*, so a format change produces silent zeroes, i.e. exactly the
current symptom, with nothing surfacing the breakage.

**C3 — unbounded dotfile litter.** One `~/.claude/aigate/.tokens-last-<session_id>` file per
session, never reaped. Explicitly deferred by the author (`08195db`).

**C4 — what does "tokens" even mean here?** The hook sums input + output + cache-creation +
cache-read into ONE number. Cache-read tokens are billed at a large discount, so this sum is not
cost, not context size, and not throughput — it is a composite with no clean interpretation. The
column header just says `tokens`. What question is a user asking when they look at it?

**C5 — it only reads the LAST assistant message.** A single Stop covers a whole turn, which may
contain many assistant messages (tool-use loops). Reading only the last one appears to
under-count multi-step agentic turns — the dominant workload on this fleet. **This is UNMEASURED
and the chair flags it as possibly the most important open question in the brief.**

---

## The alternative: delete the column

The user explicitly authorized removal. Deleting is cheap, reversible (git), and immediately makes
the dashboard honest. Against that: the plumbing is already built and paid for, the reporter is
already written, and a dashboard for a *token-budget-aware account router* arguably has token usage
as its most natural headline metric.

Note the product context: aigate's purpose is usage-aware account selection across rate-limited
Claude accounts. It already tracks per-account **usage limits and reset windows** through a
different path (the account poller). So the council should establish whether the `tokens` column is
**redundant** with an existing, working signal — or genuinely additive.

---

## What is explicitly UNKNOWN

- **U1.** Does one Stop hook fire per *turn* or per *session*? Determines whether C5's
  last-message-only read under-counts by a little or by an order of magnitude.
- **U2.** Does the transcript's last assistant `usage` block report cumulative turn usage or only
  that message's? If cumulative, C5 dissolves entirely. **This single fact may decide the verdict.**
- **U3.** Is there a supported, documented way to get token usage out of Claude Code — an official
  hook payload field, an OTel/telemetry export, a `--output-format json` field — that does not
  require parsing an internal transcript? If yes, C2 dissolves and the whole design changes.
- **U4.** Do the other Stop hooks already registered on this machine establish a working pattern
  worth copying?
- **U5.** What does the fleet actually want to *see*? Cost, context pressure, throughput, or
  per-account burn against a limit? The right column may not be "tokens" at all.

---

## Constraints the council must respect

- **aigate is a selector, NOT a proxy.** It never sits in Anthropic's request path. Any design that
  routes traffic through aigate to count tokens is disqualified on compliance grounds — this is the
  project's #1 constraint. Counting must stay client-side and after-the-fact.
- Node, ONE dependency (`ws`), `node:sqlite`. No new runtime deps without a strong argument.
- Must fail open: the user's shell and Claude Code must never break or block because reporting failed.
- Prod carries 11,167 historical rows. Any schema/semantic change must state its migration story.

## The ruling we need

1. **Wire it, redesign it, or delete it?** One recommendation, with the reasoning.
2. If wiring: what is the minimum correct change, and what is done about C1 (double-counted
   requests) and C5 (multi-message turns)?
3. If deleting: delete the UI only, or also the schema column, the aggregation, and
   `tokens-hook.sh`? What is the reversibility story?
4. Name the **single experiment** that most cheaply resolves U1/U2 — the chair can run it.
