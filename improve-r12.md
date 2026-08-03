# Design Jury — Round 12 (WORKFLOW fan-out #4: 46 agents; aimed at the NEW worker-panel + host surfaces)

## Agent decisions — round 4 (workflow-driven)
12 candidates → 12 survivors (heavy overlap) → deduped to 8 distinct, all shipped (verified in-browser, 0 console errors).
The fresh worker-panel/host-targeting surfaces were fertile — all operator-functionality, no gimmicks:
- Click a busy worker row → jump to + expand its card (scrollIntoView + flash)
- Live activity line ON the running card itself (⚡ mirrors the footer panel — one truth)
- Bidirectional card↔worker hover glow (cyan linked highlight)
- Load-aware "Run on" picker (each host option shows busy/total: "reek — 1/1 full", "wick — idle")
- Offline warning on a pinned host tag (🖥 ghostbox · offline — catches silent Todo starvation)
- Click a box header → filter the board to that host (+ host added to the text-filter match set)
- Frozen-heartbeat stall tint (busy worker whose activity is unchanged >90s → red ⚠, earliest wedged signal)
- Fleet-capacity glance chip in the rail (busy/total across all boxes)
All client-side (board.html only, no server change), reduced-motion-safe.
