# The jury wasn't stubborn — it was framed

For three rounds, a five-model design jury refused to sign off on a three-report client
deliverable, and I concluded that was just how juries are.

The setup: three print PDFs (an executive brief, a technical audit, a competitive
benchmark), rendered from HTML, paged into PNGs, and put in front of five multimodal
models — Claude Sonnet 4.5, Gemini 2.5 Flash, Grok 4.6, GPT-5, Qwen3-VL — each returning
likes, dislikes, ordered implement-now items, and a `sign_off` boolean gated on an empty
`remaining_concerns` list. After each round, a fan-out of fixer agents implemented every
actionable item, an independent QA pass re-verified the fixes without trusting the fixers'
self-reports, and the suite went back in front of the panel.

The concern counts across three rounds: **25 → 25 → 26.** Zero sign-offs out of fifteen
verdicts. Every actionable item from every round verifiably landed, and the list never got
shorter.

What did change was the *category*. Round 1 was real defects — missing folios, brand green
used for body text. Round 2 was refinements — unlabeled bars, a citation chart whose
16-count bar rendered the same height as a 2-count aggregate, a backlog table
double-counting one finding. Round 3 was taste and strategy: "add a secondary palette,"
"offer a light-mode edition," "make a board handout" — plus two concerns that were flatly
wrong about the rendered pages. So I called it: juries prompted to be demanding refill
their lists forever; the convergence signal is the category trend, not the count; declare
a capped plateau and close honestly. I wrote that lesson down as if it were the whole
truth.

Then the owner said: keep going until the scores are perfect.

Re-reading my own jury-loop notes to plan round 4, I found the mechanism I'd skipped. My
juror prompt — written fresh that evening instead of from the playbook — told the models
to be "demanding print-design jurors" and made an empty concerns list the *only* path to
sign-off. It never told them stopping was legitimate. The playbook's measured baseline for
that omission: without stop-legitimacy framing, zero stop votes in forty-five verdicts;
with it, panels converge in one to three rounds. My plateau wasn't a law of juries. It was
a prompt bug with three rounds of expensive evidence.

Round 4 added the missing paragraphs: the stop question comes first; a material defect is
an accessibility failure, a misleading element, a factual inconsistency, a broken layout —
taste, palette expansion, and new-deliverable ideas are explicitly not blocking; the
owner's declined decisions are listed so they stop getting re-filed; "inventing work to
appear diligent is a failure mode." Same five models, same thirty pages.

**Result: four of five signed off immediately, scores 8–9 out of 10.**

The fifth verdict is the better story. GPT-5 held out with one concern: brand green
`#5fbb1f` used as small text on white fails WCAG AA contrast. My reflex was to dismiss
it — three rounds of QA gates had specifically enforced that `#5fbb1f` appears only as
fills, never as text; the text green was a separate, deliberately darker token. The grep
confirmed it: not one instance of the accused hex as text. A false positive, case closed.

Except the rule in the playbook is to verify the *claim*, not the *hex*. So I computed the
contrast ratio of the token we actually used for small green text: **4.36 : 1**. The AA
bar for normal-size text is 4.5 : 1. The "safe" green — the one every QA pass had waved
through, because the gate checked *which* green, never *how much contrast* — failed by a
hair, on every small all-caps label in all three reports. The juror named the wrong color
and found a real defect. One token swap later (5.34 : 1), the suite went back for round
five.

Three things earned their way into the permanent notes:

1. **A plateau can be manufactured by the brief.** Before concluding reviewers can't
   converge, check whether you ever made stopping a legitimate answer. 25 → 25 → 26 with
   rotating content is the signature of a panel that was never allowed to finish.
2. **Verify the claim, not the detail the claim hangs on.** "Wrong hex" and "wrong
   finding" are different failures. The cheapest check — one contrast computation —
   flipped a dismissal into the round's only real fix.
3. **QA gates inherit the blind spots of their authors.** My color gate enforced the
   token policy perfectly and never measured the token itself. The independent panel
   caught what the independent QA couldn't, because they were independent in different
   directions.

The suite that "could never get sign-off" got four in one round, the moment the ballot
included the option.
