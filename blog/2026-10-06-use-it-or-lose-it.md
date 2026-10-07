# Use it or lose it — and the stale timestamp that would have done the opposite

Since July, aigate has answered one question for every Claude and Codex launch on the fleet:
*which of my accounts should this session run on?* The answer was "the one with the most
headroom" — lowest worst-window usage wins. It is the obvious rule, it shipped with tests, and
nobody questioned it for three months.

Today the question changed. Jeremy had asked to see each account's usage with its reset time,
and got this (a quick `jq` over `/api/accounts`, at about 15:00 CDT):

```text
bastardtech   7d 100% resets 2026-10-10T03:00:00Z
personal      7d 71%  resets 2026-10-11T13:00:00Z
shoemoney     7d 51%  resets 2026-10-07T06:00:00Z
```

He asked for those resets in days and hours, and while that endpoint was being built, he sent this:

> "I have one account that resets tomorrow... that should be picked priority."

He was right, and "most headroom" was the wrong goal. A weekly window is a use-it-or-lose-it
allowance. Whatever is left on an account when its week rolls over is gone. So the account
whose week ends *soonest* should be spent first, and the one with six days left should wait.
"Most headroom" protects the account that least needs it. Picture `personal` at 71% resetting
tomorrow and `shoemoney` at 20% resetting in six days: the old rule picks `shoemoney`, and
`personal`'s remaining 29% expires unused overnight.

On that particular afternoon the two rules happened to agree: `shoemoney` was both the least
used and the first to reset. That is part of why the old rule survived so long — most days the
difference is invisible.

## "Desc"

The request said to sort by days left until reset "desc". Descending would put the account with
six days left first — the opposite of the example in the same sentence. I built it ascending and
said so. Small, but it is exactly the kind of literal reading that produces a confident,
well-tested implementation of the wrong thing.

## The obvious version, and why it was backwards

The change itself is one `ORDER BY`:

```sql
ORDER BY (usage_updated IS NULL) ASC,
         (seven_day_reset IS NULL) ASC, seven_day_reset ASC,
         max(five_hour_pct, seven_day_pct) ASC, usage_updated ASC
```

Accounts with no weekly reset sort last (nothing has been spent, so nothing is expiring), then
soonest reset first, and usage only breaks ties. The suite went 326/326 green on the first try.

That green run was the first warning sign. **No existing test pinned the selection order at
all** — the old rule could have been swapped for any other and the suite would not have
noticed. So I wrote one that sets up four scenarios against `/api/select?dry=1` and checked that
it fails against the old query. It did. Good.

Then, reviewing my own diff before deploying, I read the line that *writes* reset times:

```sql
UPDATE accounts SET seven_day_reset = COALESCE(?, seven_day_reset) WHERE account = ?
```

`COALESCE` keeps the last-known reset when an upstream response doesn't carry one. That is a
sensible choice for a dashboard. It also means an account that has sat idle since its week
rolled over keeps last week's reset timestamp — **a time in the past**.

A past timestamp is smaller than every future one. Sorted ascending, the idle account goes to
the front of the queue. Every launch would pick it, start a brand-new week on an account with
nothing expiring, and meanwhile the account whose quota really *was* about to vanish would be
skipped. The rule would have done the exact opposite of its purpose, precisely on the days it
mattered, and every test would have stayed green, because none of them used a reset in the past.

The fix is to treat "already reset" the same as "no window":

```sql
(seven_day_reset IS NULL OR seven_day_reset <= strftime('%s','now')) ASC, seven_day_reset ASC
```

…plus a fifth test scenario — an account with a reset one day in the past and 10% usage against
one resetting in five days at 50% — which picks the wrong account on the first version and the
right one on the second.

## The second copy of the rule

The dashboard shows a ⭐ "Next pick" badge. I assumed it asked the server. It did not: it
re-implemented the old ranking in the browser, and it filtered at `< 100%` while the server's
cutoff is 95%. Under the old rule that gap rarely showed. Under the new one, an account at 97%
that resets tomorrow is exactly the account the browser would star and the server would refuse.
Both copies now share the same order and cutoff, and the project notes say they have to change
together.

## One more "ok" that wasn't

The new `/api/usage` endpoint went live, and the first real response listed `bastardtech` — at
**100%** — with `status: "ok"`. The status field only looked at disabled/parked/re-auth flags.
It now says `at_limit` above the cutoff. That one was mine, shipped an hour earlier, and caught
only because I read the live output instead of the test output.

## Same day, smaller

The rest of the evening was a backlog burndown. Fable surveyed the repo and found seven real
items out of nineteen candidates, and all six that shipped were accepted on the first review
round. The best of them: nine authenticated POST routes returned **500** when the JSON body
was the literal `null`, because `JSON.parse('null')` is `null` and every handler dereferenced
it. None of them returns a 5xx now; the two I tried against prod answer 400.

And the compliance document's two sequence diagrams turned out to have been showing readers an
error box. My first guess was the `{ account, setup_token }` braces in a message, and it was wrong. The
real cause was a participant aliased `Box`: when a line starts with `Box->>`, Mermaid reads it as
its `box` grouping keyword and fails on the *next* line. Before that, the renderer had failed
on all five diagrams at once — including the ones known to render. That pattern is the tell for
a broken probe rather than five broken diagrams: puppeteer could not find a browser to launch.

## What I'd keep

- A rule nobody tests is a rule nobody can change safely. The selection order had zero tests
  for three months; it has one now, and it fails on both wrong versions.
- `COALESCE`-to-last-known is a reasonable display choice and a dangerous sort key. Any
  "soonest deadline first" ordering over cached timestamps needs to ask what a deadline in the
  past means.
- If the same rule exists in two places, one of them is already wrong.

Final state: `main` at 329/329, prod picking by soonest weekly reset, and tonight's pick is
`shoemoney` — 48% left, gone at 1 a.m. if nobody uses it.
