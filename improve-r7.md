# Design Jury — Round 7

**Models parsed:** 5 · **stop votes:** 2

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Micro-ambient particle burst on successful WS patch |
| 1 | REVIEW | Status-sweep radial pulse on column header rail hover |
| 1 | REVIEW | Show WebSocket health, event age, and reconnect countdown with restrained status pulse. |
| 1 | REVIEW | Batch simultaneous patches into one summarized live announcement, preventing noisy screen-reader updates. |
| 1 | REVIEW | Add custom drag ghost showing card title, rank delta, and destination context. |
| 1 | REVIEW | Expose valid drop targets with explicit status-transition previews before pointer release. |
| 1 | REVIEW | Use distinct error escalation styling: one-time edge flash, unread badge, and persistent acknowledgment state. |
| 1 | REVIEW | Live telemetry heartbeat: Running card border glow pulses rhythmically to simulate active token generation. |
| 1 | REVIEW | Filter spotlight depth: Active search query desaturates and blurs non-matching cards via backdrop-filter. |
| 1 | REVIEW | Column overflow gradient masks: Dynamic top and bottom feathering visualizes hidden off-screen cards. |
| 1 | REVIEW | Error state chromatic flash: Failing tasks trigger an acute red chromatic-aberration border pulse. |
| 1 | REVIEW | Multi-column drag targets: Dragging cards over non-Todo columns illuminates reactive column drop overlays. |
| 1 | REVIEW | Cross-column drag: drag Error→Todo to requeue, Running→Error to abort; typed drop zones |
| 1 | REVIEW | Staleness heat: queued card edge ramps dim→amber→red as age crosses SLA thresholds |
| 1 | REVIEW | Board mood vignette: edge wash tints red on any error, green when all done |
| 1 | REVIEW | Multi-select Todo (shift/ctrl-click) → single stacked ghost drags whole batch, badge shows count |
| 1 | REVIEW | Column header pressure gauge: rail saturation/width tracks queue depth and throughput sparkline |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Post-drop card scale-overshoot with status-tinted elastic squash |
| 1 | REVIEW | Error-card micro-shake + desaturate desync on live error patch |
| 1 | REVIEW | Animate status handoffs directionally between columns, preserving card identity during relocation. |
| 1 | REVIEW | Collapse removed cards smoothly while reserving space, preventing abrupt scroll jumps. |
| 1 | REVIEW | Morph changed timer digits with brief emphasis, avoiding another full-card sheen sweep. |
| 1 | REVIEW | Use staggered entrance only for genuinely new cards, capped to prevent busy-board cascades. |
| 1 | REVIEW | Task spawn particle arc: Submitting new task modal fires a luminous trajectory into Todo column. |
| 1 | REVIEW | Retry rewind transition: Retrying an Error task sweeps card backward with subtle reverse scanlines. |
| 1 | REVIEW | Done card age decay: Completed cards desaturate and fade opacity over time to elevate active work. |
| 1 | REVIEW | Modal layout spring morph: Expanding task details smoothly spring-reflows card bounds directly into modal. |
| 1 | REVIEW | Column collapse FLIP reflow: Toggling compact mode smoothly reflows board layout with spring physics. |
| 1 | REVIEW | Cross-column FLIP flight: card physically travels Todo→Running on WS status change |
| 1 | REVIEW | Edge auto-scroll with acceleration curve while dragging inside long columns |
| 1 | REVIEW | Custom setDragImage: compact canvas chip (rank+title+status) instead of default screenshot |
| 1 | REVIEW | Heartbeat tick: running card pulses one faint beat per worker heartbeat frame |
| 1 | REVIEW | Sticky header condenses on column scroll — shrink, blur, tighter type, no reflow jump |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Subtle metallic edge bevel on active grip handle |
| 1 | YES | Ink-contrast status icon micro-morph on column transfer |
| 1 | REVIEW | Add a compact activity ledger with timestamps, actor, event type, and patch source. |
| 1 | REVIEW | Provide a pause-live-updates control that preserves incoming-count visibility without freezing operator actions. |
| 1 | REVIEW | Show per-column backlog pressure using accessible bar geometry, not additional saturated color. |
| 1 | REVIEW | Add conflict resolution affordance when local drag order meets a newer server ordering. |
| 1 | REVIEW | Persist the last viewed card and restore focus after WebSocket-driven list updates. |
| 1 | YES | Glassmorphic column headers: Sticky headers use backdrop-filter blur with subtle noise texture over canvas. |
| 1 | REVIEW | Model tier metallic badges: Distinct dual-tone metallic gradient badges per AI model provider/tier. |
| 1 | REVIEW | Mini live sparkline: Inline SVG micro-sparkline inside Running cards rendering active token velocity. |
| 1 | REVIEW | Optimistic pending card: dashed outline + shimmer until WebSocket ack confirms creation |
| 1 | REVIEW | Lineage links: hover a clone to draw faint connector to origin card |
| 1 | REVIEW | Tabular-nums for all timers/counts so digits never jitter during live ticks |
| 1 | YES | forced-colors and prefers-contrast support: keep glow as borders, not color-only meaning |
| 1 | YES | Scroll-velocity parallax on background washes, capped and disabled under reduced-motion |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Show WebSocket health, event age, and reconnect countdown with restrained status pulse. |
| 1 | REVIEW | Add custom drag ghost showing card title, rank delta, and destination context. |
| 1 | REVIEW | Animate status handoffs directionally between columns, preserving card identity during relocation. |
| 1 | REVIEW | Task spawn particle arc from modal trigger to top of Todo column. |
| 1 | REVIEW | Filter spotlight depth desaturating and blurring non-matching cards during active search. |
| 1 | REVIEW | Live telemetry heartbeat pulse on Running cards simulating active worker token output. |
| 1 | REVIEW | Cross-column FLIP flight on status change |
| 1 | REVIEW | Staleness heat ramp on queued cards |
| 1 | REVIEW | Cross-column drag actions: requeue and abort |

## Font suggestions

- **x-ai/grok-4.20:** 'Inter', system-ui - crisp readability at small sizes · pair: Space Grotesk for headers
  - `font-feature-settings: 'ss03' on drag states`
- **openai/gpt-5.6-luna:** Inter, system-ui, sans-serif — compact UI metrics, strong numerals, and reliable cross-platform fallback. · pair: ui-monospace for IDs, timers, and paths
  - `Use tabular numerals, restrained tracking, and weight changes rather than decorative type animation.`
- **google/gemini-3.6-flash:** Plus Jakarta Sans for crisp geometric dark-mode UI legibility · pair: JetBrains Mono for task IDs, terminal logs, and model tags
  - `font-variant-numeric: tabular-nums on all live timers to prevent layout jitter`
- **deepseek/deepseek-v4-flash:** Inter – crisp legibility at small sizes, pairs with monospace for code · pair: JetBrains Mono for IDs/paths
  - `smooth weight transitions on hover`
- **anthropic/claude-opus-5:** Inter var — tight optical sizing, superb dark-mode small caps, tabular figures · pair: JetBrains Mono for ids/paths/tags/timers
  - `Weight and letter-spacing shift subtly on status change; never size (no reflow).`

## Auto-agree implementation queue (by votes)

1. [professional · 1×] Ink-contrast status icon micro-morph on column transfer
2. [professional · 1×] Glassmorphic column headers: Sticky headers use backdrop-filter blur with subtle noise texture over canvas.
3. [professional · 1×] forced-colors and prefers-contrast support: keep glow as borders, not color-only meaning
4. [professional · 1×] Scroll-velocity parallax on background washes, capped and disabled under reduced-motion

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=2 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — FLARE-2 round 1
**SHIPPED** (verified in-browser, 0 console errors):
- **Cross-column flight** — a status-colored clone flies from a card's old column to its new one
  on every WS status change (todo→running→done/error). Scoped to the destination column to dodge
  the transition-group leaving-ghost race. Reduced-motion → skipped.
- **Staleness heat ramp** — queued cards warm their age-timer (dim→amber→red) + a left-edge rail
  the longer they wait; red tier gently pulses. Reduced-motion → static.
- **Live-freshness meta** — header shows live / "Ns ago" / "reconnecting…" so the WS pulse is legible.
**SKIPPED:** filter-spotlight (risky rework of the hide-based filter, 1 vote), task-spawn particle arc
(gimmick), running heartbeat pulse (redundant w/ conic sweep), cross-column drag requeue/abort (needs
a backend cancel endpoint — tracked). 2/5 stop votes this round.
