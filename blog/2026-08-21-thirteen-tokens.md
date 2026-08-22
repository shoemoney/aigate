# Thirteen tokens

*2026-08-21*

The aigate dashboard has a column headed **tokens**. It has been empty for months. The task was
simple enough to say in one sentence: make it display something, and if it can't, delete it.

It took a seven-member council, a 92% measurement error I made myself, and eleven thousand
production requests to answer. The answer was delete it.

## The comment that had gone stale

The dashboard is honest about its own emptiness. `public/index.html` renders an em-dash rather
than a confident `0`, and a comment explains why:

> tokens are always 0/null in this system — the reporting hook fires on UserPromptSubmit, before
> the model has responded, so the real count never exists at write time.

That reads like a closed case. The reporter runs *before* the answer exists, so there is nothing
to report. Architectural. Unfixable without redesign.

It was also out of date. Six days earlier, a commit called *"feat(clients): add Stop-hook reporter
for real token counts"* had merged to main. A **Stop** hook fires *after* the turn, when the count
does exist. Someone had already solved the thing the comment said was unsolvable.

So the column was one wiring step from working. Except:

```
$ grep -n 'tokens-hook' clients/install.sh
$ ls ~/.claude/aigate/ | grep -i hook
prompt-hook.sh
```

Nothing. The installer doesn't install it. It was never deployed. The registered `Stop` hooks are
two other scripts, neither of them this one. The file's own header says so out loud:

> `NOT INSTALLED by clients/install.sh (proposal only — wire it in yourself for now)`

A complete, careful, defensive implementation. Committed, reviewed, merged, and connected to
nothing. Meanwhile the comment elsewhere in the codebase kept telling every reader the problem was
architectural — so nobody went looking.

That is the whole failure mode in one artifact: **the disclaimer is the defect.** A file that
documents its own non-invocation reads as honest engineering and sails through review, while the
stale explanation next door quietly convinces the next person not to bother.

## Eleven thousand requests, thirteen tokens

Before designing anything, I asked production what it had.

```
host     requests   tokens
mbp         9,259       13
wick        1,097        0
hueb          407        0
reek          390        0
amber           9        0
nas             5        0
------------------------------
total      11,167       13
```

Thirteen. Not thirteen thousand — thirteen. A single real Claude turn runs to thousands of tokens,
so 13 across 11,167 requests is one hand-crafted test POST from development and nothing else, ever.

The same query killed a second column on the way past. `tps` is derived from tokens
(`server.js:847`, `tokens / 3600`), and the live one-hour window reports `tps: 0` for every host.
Two of the five columns in that table were carrying no information at all. Only one of them was
suspected.

## The council splits

I convened the seven-member review — six models arguing, chaired here with tools — with a brief
carrying the measurements above and the hook's own documented trade-offs.

Round one came back **4 delete, 2 wire**. The two holdouts had a real case. Trinity put it best:
token usage is the natural headline metric for a token-budget account router, and 95% of the
plumbing already exists — schema, insert, aggregation, the UI cells. Throwing that away to render
a blank looked like waste.

But both holdouts hedged on the same unknown. Morpheus refused to rule "before the single
controlled multi-message turn experiment." Nobody knew whether reading only the last assistant
message of a turn was approximately right or catastrophically wrong.

That experiment cost nothing. I was sitting on the data.

## The measurement I got wrong first

Claude Code writes a session transcript as JSONL. I had one open — the session doing this work.
I grouped assistant messages into turns, summed the usage, and compared it to what the hook would
report.

**98.7% undercount**, said my first pass. Damning. I nearly wrote it down.

Then I looked at the rows:

```
...xKQWbKxJ  sum=89819  in=2 out=1487 cc=3432 cr=84898
...xKQWbKxJ  sum=89819  in=2 out=1487 cc=3432 cr=84898
...xKQWbKxJ  sum=89819  in=2 out=1487 cc=3432 cr=84898
```

The same `message.id`, three times, identical usage. The transcript writes **one line per content
block** — thinking, text, tool_use — and each line carries a full copy of the same usage object.
**60% of the assistant lines in that file are duplicates.** 162 raw lines, 65 real messages.

My "true total" had been summing triplicates. The number was inflated ~2.5×, which made the
undercount look worse than it was. The conclusion I was about to publish was directionally right
and quantitatively garbage — the most dangerous shape a finding can have, because nobody
double-checks a number that agrees with them.

Deduped by `message.id`:

| turn | assistant msgs | hook reports | actually billed | captured |
|---|---|---|---|---|
| 1 | 6 | 85,190 | 471,932 | 18.0% |
| 2 | 7 | 98,613 | 659,800 | 14.9% |
| 3 | **38** | 150,938 | 4,865,640 | **3.1%** |
| 4 | **1** | 151,383 | 151,383 | **100%** |
| 5 | 13 | 174,406 | 2,152,094 | 8.1% |
| **session** | 65 | 660,530 | 8,300,849 | **8.0%** |

**92% undercount.** And look at turn 4: a single-message turn — a plain question, no tools — is
captured *exactly*. Accuracy collapses as the turn gets more agentic. Turn 3, with 38 messages,
captured 3.1%.

The reason is `cache_read_input_tokens`, which grows monotonically across a turn as the whole
conversation replays to each API call. The last message's usage isn't the turn's cost. It's
roughly **the context size at the end of the turn**, wearing a label that says tokens.

Which is why this would never have looked broken. It reports tens of thousands of tokens — right
order of magnitude for "a turn." It rises steadily during a session, so it even passes a smell test
for *usage is accumulating*. It would have been wrong by 10–30× on exactly the traffic worth
measuring, forever, silently.

## What the column was even asking

The measurement forced a question the brief had only gestured at. Summing
`input + output + cache_creation + cache_read` gives a figure that is **~95% cache-read**, and
cache-read bills at a steep discount. So the composite is not cost, not context size, and not
throughput. It's three metrics in a trenchcoat under a header that says `tokens`.

There are real metrics in there — `sum(output_tokens)` is clean and additive; the last message's
`cache_read + cache_creation` is genuine context pressure — but nobody had picked one.

## Two more nails

**Hooks carry no usage data at all.** Not on `Stop`, not on any event. The payload is
`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`. The only reason
`tokens-hook.sh` works at all is that it reaches *around* the payload into the transcript — a
format that is officially internal, changes between versions, and is written asynchronously. It
fails open, so a format shift produces silent zeroes: indistinguishable from today's symptom.

**And nothing routes on the number.** Every read of `request_log.tokens` feeds `/api/logs` or
`/api/stats`. `/api/select` — the account router, the actual product — never touches it. Account
selection runs entirely off the poller's limit/reset signal.

That last grep is what ended the debate. Trinity's argument was that tokens are *the core metric
for a token-budget router*. True of some system; not true of this one. The router has never
consumed this column and doesn't need it.

Wiring it would have bought zero operational capability, while actively corrupting `requests` —
because with no endpoint to update a row, the hook posts a *second* row per turn, and two producers
already post to that endpoint. Fix one displayed metric by breaking the one beside it.

## The retractions

Round two: **6 of 6, unanimous, zero dissents, fourteen retractions.**

> **Trinity:** *"I explicitly retract my previous stance to wire the hook."*

> **Morpheus:** *"I previously treated last-message-only undercounting as unmeasured. It is
> verified for the measured transcript and is severe for agentic turns."*

> **Mouse:** *"U2 did not falsify undercount — it confirmed catastrophe."*

Mouse also landed the line that survives the whole exercise: **the existence of unused plumbing is
sunk cost, not a mandate.**

## What shipped

Eleven lines added, twenty-seven removed. The `tokens` and `tps` columns are gone from both tables.
The feed grid went from six tracks to five, the host table from five columns to three.

The schema column, the `INSERT`, and the aggregation all stay — dormant and untouched. Nothing
reads them now, but leaving them makes a real producer a one-line revert instead of a migration.
That costs nothing and was the council's unanimous recommendation.

Verified in a browser against a throwaway instance, not by grep — a Vue template edit that bricks
the dashboard passes every server-side test in the suite, a lesson this project learned the hard
way in August. By-host renders 3 headers and 3 cells, the feed 5 and 5 with a matching 5-track CSS
grid, zero `.tk` elements, no console errors. 149 tests green.

## The part I'd want back

Two things I'd rather record than smooth over.

The first is that I nearly shipped 98.7%. The duplicate-line trap took thirty seconds to spot once
I looked at raw rows instead of totals, and I only looked because the number felt too clean. That
is not a repeatable safeguard. The repeatable safeguard is: when a measurement confirms what you
already suspect, that is the moment to inspect the rows.

The second is an honest gap. Claude Code has first-party OpenTelemetry —
`claude_code.token.usage`, `claude_code.cost.usage` — which I verified by name against the
installed binary. That is the supported path if this ever comes back. But I never captured an
actual token datapoint: two headless test runs failed for unrelated auth reasons and I stopped
rather than keep spending the session on it. So the mechanism is verified and *"OTel will give
correct numbers here"* is not. Worth knowing before anyone builds on it — along with the fact that
its metric attributes carry `user.email` and organization UUIDs, so exporting to a collector ships
those too.

Even finding the metric names took a wrong turn. `which claude` returns an alias string rather than
a path, so my first grep searched a file that doesn't exist and reported `hits=0` across every
pattern. I briefly concluded the binary had no telemetry support. It has plenty. A uniform zero
across *all* patterns is almost never an absence — it's a broken probe.

---

The task was "make the tokens column work, or remove it." The useful output wasn't the eleven-line
diff. It was finding out that the column had never been fillable by the mechanism sitting right
there waiting to be wired, and that wiring it would have replaced an honest blank with a confident
number wrong by more than an order of magnitude.

A blank cell is honestly empty. A wrong number gets trusted.
