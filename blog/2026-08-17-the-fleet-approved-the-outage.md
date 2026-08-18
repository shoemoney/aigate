# The fleet approved the outage

*2026-08-17*

This week aigate got the most thorough review it has ever had. Fifty-four raw findings from a
nine-lens fan-out, each one independently adversarially verified — a skeptic agent told to
*refute* it — down to 30 confirmed. Then implementation in isolated worktrees, an independent
verify step that re-ran every done-command, and an Opus judge with rejection power over each
item. Twenty-three fixes landed across three rounds. The test suite grew from 140 to 142, every
merge gated on green.

One of those fixes was "add security headers." `Content-Security-Policy: default-src 'self'`,
`X-Frame-Options: DENY`, `nosniff`, `no-store` on secrets JSON. Textbook hardening. The finder
found it, the verifier verified it, the judge accepted it, the suite passed, it deployed.

The dashboard died instantly, and nothing in the pipeline noticed.

## Two layers of dead

Jeremy noticed — "why does aigate not render css" — and the diagnosis came in two acts, because
the failure had two layers.

The first was obvious once seen: the dashboard is a single-file Vue app. Inline `<style>`,
inline `<script>`, vendored `vue.global.prod.js`, no build step. `default-src 'self'` without
`'unsafe-inline'` blocks both, so the browser served raw template soup — unstyled HTML with
`{{ loginMsg }}` mustaches showing. Fix: allow inline for style and script, and while in there,
add `connect-src 'self' ws: wss:` because CSP2-era browsers don't match WebSockets against
`'self'` — the *next* silent break, pre-empted.

Deployed. Hard-reloaded. The page painted its dark background… and nothing else. Styled but
empty. Mustaches gone.

That's the interesting rung. Mustaches-gone means Vue *mounted* — it consumed the template —
but rendered nothing. The console (Playwright, because the OS-level screenshot tool can show you
the page but not the console) had the answer:

```
EvalError: Evaluating a string as JavaScript violates the following
Content Security Policy directive … 'unsafe-eval' is not an allowed source
    at aX (vue.global.prod.js:13:318)
```

The full Vue build compiles in-DOM templates through `new Function()`. That needs
`'unsafe-eval'`. Second fix, second deploy, dashboard alive — verified this time with an actual
browser screenshot of the login card *and* a clean console, not a grep.

## The turn

The uncomfortable part isn't the CSP details — those are a table you can look up. It's this:

**Every stage of the pipeline was doing its job, and the failure was invisible to all of them
simultaneously.** The suite (`node --test`, 142 passing) exercises HTTP endpoints; it never
executes a page's JavaScript. `curl` sees a 200 and correct HTML bytes; CSP only acts inside a
browser. The done-command checked that the header *exists* — which was precisely the bug. The
adversarial verifier and the judge read code. Multi-model consensus is not evidence when every
model is looking through the same keyhole.

We even had a skill in the library titled "model-panel-consensus-is-not-evidence." It's about
benchmarks. It was also about this, and nobody — human or model — made the connection until prod
was down.

The rule that came out of it: **a change to response headers, or to anything that serves HTML,
is not verified until a real browser has loaded the real page and something has read the
console.** That's now baked into the todo-cycle checklist and a new `csp-bricks-inline-ui`
skill, with the three-rung symptom ladder (mustaches → styled-but-empty → dead WebSocket) so
the next person recognizes which layer they're on in seconds instead of acts.

## Also today, in "the loop said done"

A smaller one, same species. The landing step merges accepted branches one at a time, suite
after each, logging to a file. The log path's directory didn't exist — the session's scratchpad
had rotated — and in a shell, a failed redirect aborts the *whole command*, not just the
logging. Eleven `git merge` commands ran zero times. The loop printed its own completion line
and exited 0.

`git log` caught it: main hadn't moved. The merges then ran fine without log files. But it's
the same lesson wearing different clothes — the probe (a completion message, a green suite, an
approving judge) is not the thing. The thing is the page rendering, the commit graph moving,
the WebSocket frame arriving. Check the thing.

## Where it stands

`main` at `714376f`: 143 tests (the new one force-splits a UTF-8 emoji across two TCP writes —
a test the old suite admitted in a comment it couldn't do), first-ever GitHub Actions CI green
in 19 seconds, 34 fixes landed this week from 4 cycles, and a dashboard whose CSP now carries a
comment explaining exactly why `'unsafe-eval'` is there — so the next hardening pass reads the
reasoning instead of repeating the outage.
