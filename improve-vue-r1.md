# Design Jury — Round 1

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Fix empty-state card flex to prevent 7-line break |
| 1 | REVIEW | Add subtle row hover on activity feed for target |
| 1 | REVIEW | Make critical banner dismissible with 30s auto-rehide |
| 1 | REVIEW | Widen account cards slightly for gauge breathing room |
| 1 | REVIEW | Use mono consistently for all percentages and countdowns |
| 1 | REVIEW | Fix empty-state card: set .card to display:grid; grid-template-columns:1fr; gap:15px; span chips inline. |
| 1 | REVIEW | Add sticky column headers in activity feed and host table for long scrolls. |
| 1 | REVIEW | Show '—' in tokens column with a muted tooltip 'count unavailable at submit time'. |
| 1 | REVIEW | Make account card severity badge always visible on first glance, not hidden behind hover. |
| 1 | REVIEW | Add a subtle border-left color on account cards matching status (amber/green/red). |
| 1 | REVIEW | Fix empty-state card: wrap sentence in <p>, chips inline |
| 1 | REVIEW | Drop tokens/model columns; add footnote 'not reported upstream' |
| 1 | REVIEW | Rollup line needs fixed-width mono slots to stop reflow jitter |
| 1 | REVIEW | Sort/collapse READY cards; escalate only RUNAWAY/RE-AUTH to top |
| 1 | REVIEW | Add persistent 'worst account' pin in header for tab-title glance |
| 1 | REVIEW | Fix zero-accounts flex layout bug by wrapping code chips in paragraph. |
| 1 | REVIEW | Replace empty tokens column with prompt status flag or collapse space. |
| 1 | REVIEW | Mute empty model column header to reclaim visual focus for events. |
| 1 | REVIEW | Combine reset countdown and timestamp into single scannable inline string. |
| 1 | REVIEW | Highlight selected account badge with amber outline for instant visual pick. |
| 1 | REVIEW | Fix zero-account copy wrapping; group sentence and code chips. |
| 1 | REVIEW | Label each hero percentage with its governing 5-hour or weekly window. |
| 1 | REVIEW | Pin critical banner beneath header until selectable accounts recover. |
| 1 | REVIEW | Remove empty model and tokens columns; explain unavailable telemetry once. |
| 1 | REVIEW | Lock feed column widths and use tabular numerals for scanning. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | Add reduced-motion guard to hero number rAF tween |
| 1 | REVIEW | Stagger feed row enter with 40ms offset in TransitionGroup |
| 1 | REVIEW | CSS fade + scale on critical banner enter only |
| 1 | REVIEW | Keep gauge width transition but cap at 300ms |
| 1 | YES | Pause live flare animation when reduced-motion active |
| 1 | YES | Sparkline draw-in uses CSS stroke-dashoffset animation, not JS, for reduced-motion compliance. |
| 1 | REVIEW | Host table row wash uses a CSS keyframe that fades out, triggered by adding/removing a class. |
| 1 | REVIEW | Header status dot pulse uses CSS animation with a 2s cycle, not per-frame WebSocket beat. |
| 1 | REVIEW | Gauge fill transitions use CSS transition: width 0.6s ease-out, no JS timer. |
| 1 | REVIEW | Account card reorder uses Vue TransitionGroup with move class, no JS position calculation. |
| 1 | REVIEW | Cap concurrent flares: one wash at a time per table |
| 1 | REVIEW | Card re-sort should FLIP only on severity change, not poll |
| 1 | REVIEW | Hero tween under 220ms; skip when delta <1% |
| 1 | REVIEW | Feed enter: 1-frame background wash, no slide or height |
| 1 | REVIEW | Status dot beat needs idle decay, not per-frame retrigger |
| 1 | YES | Ensure hero percentage JS tween strictly respects prefers-reduced-motion media query. |
| 1 | REVIEW | Animate critical banner enter transition with subtle vertical slide and fade. |
| 1 | REVIEW | Transition sparkline stroke-dashoffset smoothly on inbound live usage WebSocket samples. |
| 1 | REVIEW | Use scale-down fade transition for dismissed action-required inbox rows. |
| 1 | REVIEW | Cap host table live-wash highlight to brief 300ms bg-color fade. |
| 1 | REVIEW | Animate card reordering only on severity changes, never polling jitter. |
| 1 | REVIEW | Beat the status dot once per coalesced burst, not every frame. |
| 1 | REVIEW | Wash changed host cells only, using low-alpha accent. |
| 1 | REVIEW | Run sparkline drawing only at boot; keep subsequent updates stable. |
| 1 | REVIEW | Use opacity and transform only for panel, inbox, and feed motion. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | Ensure all status chips have 4.5:1 contrast minimum |
| 1 | REVIEW | Add aria-live=polite to header rollup for screen readers |
| 1 | REVIEW | Make sparkline SVG focusable with tooltip on worst value |
| 1 | REVIEW | Use consistent 1px focus ring on all interactive controls |
| 1 | REVIEW | Align all timestamps to right in activity table |
| 1 | YES | Add a subtle 1px inset shadow on panels for depth without breaking contrast. |
| 1 | REVIEW | Use a monospace font for all numeric values, IDs, and timestamps for alignment. |
| 1 | REVIEW | Add a thin 1px solid var(--line) separator between feed rows for readability. |
| 1 | REVIEW | Ensure all interactive elements have a visible focus ring using var(--accent). |
| 1 | REVIEW | Use a consistent 8px grid for spacing; replace arbitrary margins with multiples of 8. |
| 1 | REVIEW | Tabular-nums + fixed decimals on every percentage |
| 1 | REVIEW | Align gauge tick labels to baseline grid across cards |
| 1 | REVIEW | Stale data: dashed border plus timestamp, never gray-out only |
| 1 | REVIEW | Chips: one weight, uppercase, 0.06em tracking, no borders |
| 1 | REVIEW | Document title reflects worst state for background-tab glance |
| 1 | REVIEW | Apply font-variant-numeric tabular-nums globally across all numerical dashboard values. |
| 1 | REVIEW | Add subtle dark inset borders on panel cards to enhance separation. |
| 1 | REVIEW | Distinguish status chips using border patterns alongside color for accessibility. |
| 1 | REVIEW | Render stale sparklines with reduced opacity and dashed stroke style. |
| 1 | REVIEW | Color-code burn-rate trend indicators with explicit directional delta symbols. |
| 1 | REVIEW | Align chips, percentages, gauges, and timestamps to a strict baseline grid. |
| 1 | REVIEW | Use consistent status vocabulary across header, inbox, cards, and keys. |
| 1 | REVIEW | Separate destructive controls spatially and require explicit confirmation states. |
| 1 | REVIEW | Standardize empty, stale, loading, paused, and disconnected treatments. |
| 1 | YES | Reduce decorative borders; reserve strongest contrast for actionable, critical elements. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Fix empty-state card flex layout |
| 1 | YES | Add reduced-motion guard to JS hero tween |
| 1 | YES | Ensure status chips meet contrast minimum |
| 1 | REVIEW | Fix empty-state card layout bug (broken span chips). |
| 1 | REVIEW | Add sticky headers to scrollable tables (feed, host). |
| 1 | REVIEW | Replace JS-driven sparkline draw with CSS stroke-dashoffset animation. |
| 1 | REVIEW | Fix empty-state flex bug; wrap prose in block element |
| 1 | REVIEW | Remove dead tokens/model columns, label absence honestly |
| 1 | REVIEW | Constrain motion: cap flares, gate re-sort on severity change |
| 1 | REVIEW | Fix zero-accounts flex card layout bug breaking empty state text. |
| 1 | REVIEW | Replace unpopulated token column with prompt availability or queue indicator. |
| 1 | YES | Guard JS hero number interpolation with matchMedia reduced-motion check. |
| 1 | REVIEW | Fix the seven-line zero-account empty-state regression. |
| 1 | REVIEW | Label hero percentages with their governing quota window. |
| 1 | REVIEW | Throttle liveness beats and restrict washes to changed cells. |

## Font suggestions

- **x-ai/grok-4.20:** system-ui, -apple-system, sans-serif for chrome because high readability at 1.3 zoom from distance · pair: ui-monospace, monospace
  - `400/500 weights, -0.015em tracking, no ligatures`
- **deepseek/deepseek-v4-flash:** system-ui, -apple-system, sans-serif for chrome · pair: ui-monospace, 'SF Mono', 'Cascadia Code', monospace for data
  - `sans: weight 400/600, tracking 0.02em; mono: weight 400, tracking 0`
- **anthropic/claude-opus-5:** System UI stack (-apple-system/Segoe/Inter local) — zero-dependency, tight at 1.3 zoom · pair: ui-monospace/SFMono/Consolas for all numerics and IDs
  - `Chrome 500/600, numerics 500 tabular, labels 600 uppercase 0.06em, body 1.45`
- **google/gemini-3.6-flash:** JetBrains Mono for telemetry metrics and system values · pair: Inter for chrome and structural labels
  - `font-variant-numeric: tabular-nums; letter-spacing: -0.01em; weights 400/600`
- **openai/gpt-5.6-sol:** var(--sans) system stack — readable at distance and dependency-free · pair: var(--mono) monospace stack — aligns numerics, IDs, and timestamps
  - `600 statuses, 500 chrome, 400 body; uppercase tracking only on labels.`

## Auto-agree implementation queue (by votes)

1. [transitions · 1×] Add reduced-motion guard to hero number rAF tween
2. [transitions · 1×] Pause live flare animation when reduced-motion active
3. [transitions · 1×] Sparkline draw-in uses CSS stroke-dashoffset animation, not JS, for reduced-motion compliance.
4. [transitions · 1×] Ensure hero percentage JS tween strictly respects prefers-reduced-motion media query.
5. [professional · 1×] Ensure all status chips have 4.5:1 contrast minimum
6. [professional · 1×] Add a subtle 1px inset shadow on panels for depth without breaking contrast.
7. [professional · 1×] Reduce decorative borders; reserve strongest contrast for actionable, critical elements.
8. [top3_must · 1×] Add reduced-motion guard to JS hero tween
9. [top3_must · 1×] Ensure status chips meet contrast minimum
10. [top3_must · 1×] Guard JS hero number interpolation with matchMedia reduced-motion check.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
