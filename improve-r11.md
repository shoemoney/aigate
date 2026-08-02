# Design Jury — Round 11 (WORKFLOW fan-out #3: 46 agents, 10 lenses + 3-skeptic panel)

## Agent decisions — round 3 (workflow-driven)
12 candidates → 10 unanimous (3-keep) winners; the panel had stopped finding flare and started finding
real CORRECTNESS/A11Y gaps. SHIPPED 7 (verified in-browser, 0 board console errors):
- Auto-scroll the Todo list while dragging near its edges (real DnD bug: off-screen ranks were unreachable)
- Tactile button :active depress (buttons had hover, no press feedback)
- Disabled-state affordance on buttons/inputs (disabled looked identical to enabled; hover still lifted)
- Visual copy-confirm ("✓ copied" + green tint; copy was screen-reader-only before)
- Modal focus-trap + focus restoration (Tab stays in the modal; focus returns to the trigger on close) [a11y]
- Card-local error pulse+mark (red twin of the done ripple/bloom — pinpoints WHICH card failed vs only the room vignette)
- Running-card overrun signal (elapsed vs rolling median Done duration → warm/hot; wedged-worker hint)
All reduced-motion-safe.

## DEFERRED (valuable but out of a design-polish pass — a future FEATURE pass):
- Optimistic create placeholder + WS reconcile — LAN round-trip is ~instant; reconcile heuristic risk not worth it
- Multi-select Todo cards + block reorder — a real feature, deserves its own pass
- Column-header aggregate telemetry line — marginal atop existing counts + the new overrun signal
Panel-rejected: silent-socket watchdog, model-hue/status-hue "collision".

## Loop complete (WORKFLOW jury, 3 rounds)
- Rounds run: 3 large fan-outs (46 agents each = 138 agents, 10 lenses + adversarial 3-skeptic panel per candidate)
- Shipped: R1 6 (semantics/depth), R2 7 (a11y/coherence + fixed the r1 flight), R3 7 (correctness/a11y/microinteractions) = 20 items
- Stopped: the fan-out has exhausted NEW polish; remaining candidates are deferred FEATURES, not design gaps
- Verification: 130/130 tests pass every round; each round rendered in a real browser with 0 board console errors
