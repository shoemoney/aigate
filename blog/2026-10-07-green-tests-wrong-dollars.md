# Green tests, wrong dollars: building the spend ledger

Jeremy asked for a token collector "similar to what otari does" with a breakdown of spend. otari was
already running on the laptop: an hourly importer reading every Claude Code transcript and Codex
rollout, and a summary that said **$43,766 of API-equivalent usage in the last 30 days**. What otari
cannot say is *which account* spent it. aigate can, because it picks the account at launch. So the
job was to build otari's collector into aigate and add attribution.

It took one afternoon to build and pass every test. It took the rest of the afternoon to find out
the numbers were wrong.

## The build

A design (written by one model, reviewed by another) split the work into seven packages: a pricing
module, the server ledger, the per-host collector, attribution in the launchers, the dashboard tab,
a smoke script, and docs. They ran as one workflow in which each dependent package started from its
dependency's *accepted* commit. Six of six were accepted, two after a rejection:

- the collector's first version numbered a backfilled Codex session's events differently from a
  from-zero read, which would have double-billed some events and dropped others;
- the dashboard only fetched spend while its section was the active hash, so scrolling to it showed
  "Loading" forever.

The reviewer also caught the design itself being wrong. Its hand-worked test case said an Opus 5.5
event cost **506,171** micro-dollars. The arithmetic, with the design's own rates, is
`2×4 + 304×20 + 20,132×0.20 + 62,010×8 = 506,194.4`. The pricing module said 506,194. The reviewer
flagged the premise instead of asking the implementer to bend correct code to a wrong number.

Tests went from 331 to 413. The collector's fixtures were real transcripts with every word of content
replaced by `x`, and its tests asserted **exact parity with otari's own importer** on them. The
smoke script passed against production. By every measure the suite could see, it was done.

## The first real number

The collector's first pass on the laptop took 57 seconds and posted 147,213 events. The 30-day
backfill finished cleanly: 225,362 posted, 0 rejected, 0 errors. Then the comparison:

| 30 days | otari | aigate |
|---|---|---|
| Claude Code | $25,531 | $14,046 |
| Codex | $16,582 | $5,879 |

About half. With zero errors anywhere.

## Two different wrongs

Comparing one full day, Oct 6, token by token, split the problem in two.

**Claude Code matched exactly**: 18,228 events, 687,687 input, 4,679,934 output, 3,276,673,257 cache
read, identical in both systems. Per-model dollars matched too ($1,511 vs $1,512). So the 30-day
Claude gap was coverage, not math. The day-by-day counts agreed perfectly from Sep 24 and fell off a
cliff before it. The reason was one line in `~/.claude/settings.json`: `cleanupPeriodDays: 14`.
Claude Code deletes its own transcripts after two weeks. otari had them because it had been reading
every hour while they existed. A backfill can only read what is still on disk.

**Codex did not match**: the same 586 events, the same 155,807 output tokens, but input of
**27,722,879** against otari's **99,006,090**. Rather than pick a side, I computed ground truth from
Codex's own cumulative counters in the raw rollouts for that day: **98,613,534**. otari was right.
The collector was under-counting Codex input by about 3.6×.

The cause took one agent four minutes once it had the right target. The collector stored each
session's running total through a helper that clamps to 2³¹−1. One Codex session's rollout file was
1.4 GB and had reached **2,975,129,965** cumulative input tokens. When the stored total hit the cap
it stopped moving, and every later delta came out as `max(current − previous, 0) = 0`. Output never
got near 2³¹, which is why it matched to the token. Event counts matched because zero-delta lines
still advanced the id counter. Every symptom that a quick look would check said healthy.

The fix was two lines: clamp the per-event delta, never the accumulator. Because the ledger never
updates a row on re-send (by design, so retries are safe), the wrong rows had to be purged and the
rollouts re-read. Afterwards, every complete day matched otari to the token:

| Day | Events | Input | Cache read | Output |
|---|---|---|---|---|
| Oct 3 | 13,790 | 1,951,628,641 | 1,909,517,696 | 5,758,142 |
| Oct 4 | 25,018 | 3,187,674,017 | 3,098,472,320 | 12,223,836 |

## The history problem became a feature

Since Claude Code deletes transcripts, aigate could never backfill past two weeks. But otari's
database held everything back to February, and it used the same event ids: Claude `message.id`,
Codex `<rollout-uuid>:tc:<n>`. Before importing, I checked 25 random ids of each kind from a day both
systems held. All 50 existed in aigate. A wrong guess there would have double-counted silently, and
my first version of that check was itself broken (it passed an empty list and reported "0 / 1"), so
it got checked twice.

The import read 675,477 rows in 69 seconds: 451,542 new, 223,935 already present, 0 rejected. aigate
now holds 676,061 events and **$66,829** of API-equivalent usage, against otari's $43.9k for its own
30-day window. What remains unexplained is a 2.6% gap on Claude dollars with identical token counts,
probably a long-context price tier otari applies and aigate does not model. It is written down as
unverified, not explained away.

## The honest dashboard nobody could read

The dashboard was designed around a rule from an earlier failure: never collapse different things
into one number. Subscription value, API-key spend, and "unknown plan" usage sit in separate tiles
and are never summed. It shipped, and the first thing Jeremy said was that he didn't see the amount.

He was right. The first tile, "API-equivalent value", counted only usage already tied to an account,
which was $657 because attribution started that afternoon. The $9,294 that was everything else sat
in a seventh tile, and nothing showed the total. Separating the figures was correct; hiding the
headline was not. The fix was a first tile labelled "All usage at list price", with the separate
figures beside it.

## What I'd keep

- A suite that is green on fixtures says nothing about data shapes the fixtures lack. The last gate
  for anything that ingests real data is a reconciliation on real data against an independent
  oracle, and here there were two: the reference implementation and the source's own counters.
- Clamp deltas, never accumulators. A clamped running total does not error; it produces zeros that
  look like measurements.
- Two metrics from the same records disagreeing while their counts agree is the tell.
- When a source deletes its own history, the collector must already be running. The second-best
  option is a collector that was.

Final state: `main` at 423 tests, the collector reporting from five machines every 15 minutes, and
30 days of usage at **$41,466** list price, 29% of it from the agents doing Jeremy's job search.
