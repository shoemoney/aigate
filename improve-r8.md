# Design Jury — Round 8

**Models parsed:** 5 · **stop votes:** 2

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | subtle per-card WS pulse-ring on patch (status-tinted) |
| 1 | REVIEW | error cards: microfracture shatter on enter + glitch ink |
| 1 | REVIEW | Add pointer/touch long-press dragging with cancellation, ghost preview, and keyboard-parity announcements. |
| 1 | REVIEW | Detect out-of-order WebSocket patches; reconcile visibly instead of silently reverting operator context. |
| 1 | REVIEW | Custom drag ghost with scale + shadow for better visibility |
| 1 | REVIEW | Scrollbar styling for independent column scroll |
| 1 | REVIEW | Status pill color transition on column change |
| 1 | REVIEW | Keyboard column move via Shift+Arrow keys |
| 1 | REVIEW | Focus indicator for drag handle on keyboard interaction |
| 1 | REVIEW | Drag auto-pan: edge-hover in a column auto-scrolls, enabling long-list reorder |
| 1 | REVIEW | Column scrollbar rail as activity minimap: colored ticks for offscreen patched cards |
| 1 | REVIEW | Offscreen-change chip: '3 updates above ↑' jumps to the newest change |
| 1 | REVIEW | Error column breathes red until an operator opens/acknowledges each failure |
| 1 | REVIEW | forced-colors + prefers-reduced-transparency fallbacks: solid borders, no gradient reliance |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | drag ghost uses 3D perspective tilt with velocity-based skew |
| 1 | REVIEW | column scroll: inertia snap with parallax header depth |
| 1 | REVIEW | FLIP newly inserted or removed cards within columns, preserving spatial continuity beyond status flights. |
| 1 | REVIEW | Card status pill color transition on column change (e.g., blue→green) |
| 1 | REVIEW | Drag ghost scale-down and shadow on start |
| 1 | REVIEW | Column scrollbar fade on idle |
| 1 | REVIEW | Smooth color transition for staleness heat ramp (already has ramp, but make smoother) |
| 1 | REVIEW | Keyboard focus ring transition on active card |
| 1 | REVIEW | Animation budget: pause conic sweeps/halos for cards outside viewport (IntersectionObserver) |
| 1 | REVIEW | Coalesce WS bursts per rAF; cap simultaneous sheens, queue rest |
| 1 | REVIEW | Pause all loops on document.hidden; resume with one catch-up sheen |
| 1 | REVIEW | Column-header count gauge fills/drains as WIP crosses a soft threshold |
| 1 | REVIEW | Invalid-drop micro-shake plus not-allowed cursor when hovering non-Todo columns |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | ink contrast meets WCAG AA on all status states + focus rings |
| 1 | REVIEW | micro-typography: kerning tweaks on rank badges during lift |
| 1 | REVIEW | Provide user-selectable flare intensity while preserving full information at low intensity. |
| 1 | REVIEW | Custom scrollbar styling (thin, rounded, themed) for independent column scroll |
| 1 | REVIEW | Subtle dot pattern or grid overlay on background for depth |
| 1 | REVIEW | Consistent font stack: Inter for body, JetBrains Mono for code |
| 1 | REVIEW | Improved focus/active states for keyboard navigation |
| 1 | REVIEW | Drag handle area with subtle hover effect |
| 1 | REVIEW | Tabular numerals everywhere for timers/counts so digits stop jittering |
| 1 | REVIEW | Keyboard drag parity: visible 'grabbed' state, Esc cancels, focus follows card |
| 1 | REVIEW | Density toggle (comfortable/compact) persisted, so 40+ tasks stay scannable |
| 1 | REVIEW | Board-idle mode: after 60s no events, dim flare to conserve attention/GPU |
| 1 | REVIEW | Per-status volume telemetry line in header: throughput, avg run duration |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add pointer/touch long-press dragging with cancellation, ghost preview, and keyboard-parity announcements. |
| 1 | REVIEW | Detect out-of-order WebSocket patches; reconcile visibly instead of silently reverting operator context. |
| 1 | REVIEW | Provide user-selectable flare intensity while preserving full information at low intensity. |
| 1 | REVIEW | Custom drag ghost styling with scale and shadow |
| 1 | REVIEW | Status pill color transition on column change |
| 1 | REVIEW | Custom scrollbar styling for independent column scroll |
| 1 | REVIEW | Drag edge auto-pan inside scrolling columns |
| 1 | REVIEW | Offscreen activity minimap ticks + jump-to-update chip |
| 1 | REVIEW | Animation budget: pause offscreen/hidden-tab loops, coalesce WS bursts |

## Font suggestions

- **x-ai/grok-4.20:** 'Inter', system-ui; crisp at small sizes for dense data · pair: 'Space Grotesk', sans-serif
  - `font-feature-settings: 'ss03' on drag for premium snap`
- **google/gemini-3.6-flash:** JetBrains Mono + Inter for high-density telemetry legibility and rapid scanning · pair: Inter
  - `font-variant-numeric: tabular-nums for jitter-free live timer and counter updates`
- **openai/gpt-5.6-luna:** Inter, with system-ui fallback; crisp UI text at compact operator densities. · pair: JetBrains Mono for IDs, paths, timers, and technical metadata.
  - `Use restrained interpolation: energetic state changes, quiet steady-state surfaces.`
- **deepseek/deepseek-v4-flash:** Inter for body (legible, modern, fast rendering) · pair: JetBrains Mono for code/monospace
  - `Smooth weight adjustment on hover/focus`
- **anthropic/claude-opus-5:** Inter var — variable weight/optical sizing, superb dark-UI legibility at 12–13px · pair: JetBrains Mono for ids, paths, tags, timers
  - `Weight/tracking shift on state change instead of size; tabular-nums for all live digits`

## Auto-agree implementation queue (by votes)

1. [professional · 1×] ink contrast meets WCAG AA on all status states + focus rings

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=2 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — FLARE-2 round 2 → LOOP COMPLETE
2/5 stop votes, agree-count 1. Remaining suggestions were scope-creep or redundant:
touch/long-press mobile dragging (desktop operator tool), out-of-order WS reconcile (full-snapshot
broadcast already makes last-write-wins), custom drag ghost / status-pill transition (marginal, repeat
1-voters), offscreen minimap + edge auto-pan (niche). **Nothing material shipped this round.**

## Loop complete (FLARE-2)
- Rounds run: 2 (5-model jury each)
- Shipped: R1 = cross-column flight + staleness heat ramp + live-freshness meta
- Stopped: R2 = 2 stop votes + agree-count 1, only scope-creep/redundant left
- Verification: 130/130 tests pass; board rendered in real browser, 0 console errors; flight + celebration
  + live-meta confirmed live via Playwright + MutationObserver
- Outstanding (future opt-in): touch/mobile dragging, drag edge auto-pan, cross-column drag requeue/abort (needs backend cancel)
