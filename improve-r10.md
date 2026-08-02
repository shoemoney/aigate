# Design Jury — Round 10 (WORKFLOW fan-out #2: 46 agents, 10 lenses + 3-skeptic panel)

## Agent decisions — round 2 (workflow-driven)
12 candidates → 9 survivors; shipped 7 (verified in-browser, 0 console errors). The panel notably caught
two real quality defects + a flaw in the round-1 flight:
- **AA-legible status pills** — dark ink on the light running/done gradients (white failed WCAG ~1.7:1) [a11y]
- **Status-coherent interaction color** — focus/selection accent derives from the card's status hue (a red
  Error card no longer glows blue on focus/open) [coherence]
- **Flight decoy-suppression** — hold the real destination card invisible until the flight-ghost lands, so the
  cross-column move is a true shared-element handoff (was a double-image) [fixes r1 flight]
- **Reconnect catch-up digest** — after a WS gap, header shows "N done · N error · N moved while you were away"
- **Status-tinted resting elevation** — cards cast a faint status-hued shadow at rest (depth = semantics)
- **Read-focus spotlight** — expanding a card dims the rest to 50% so the eye locks on the open thread
- **Running-column edge-light** — faint amber ambient while any worker runs (mirrors the error vignette)
All reduced-motion-safe.

**SKIPPED (adversarially or by judgment):**
- Silent-worker heartbeat hint — premise UNMET: running cards don't heartbeat updated_at, so it would
  false-alarm every legitimately long job. Would need a worker heartbeat mechanism first.
- Done-column chroma-decay — author-hedged, marginal, risks reading busy atop the existing recency-sort.
Panel-rejected: live output tail, optimistic pending ghost, pointer specular highlight.
