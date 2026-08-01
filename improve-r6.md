# Design Jury — Round 6

**Models parsed:** 5 · **stop votes:** 2

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add reactive WS live card tint flash on status change |
| 1 | YES | Extend palette with electric violet #a78bff + teal glow accents |
| 1 | REVIEW | Introduce particle burst on Done drop with status hue |
| 1 | REVIEW | Enhance drag with scale+rotate lift and dynamic shadow |
| 1 | REVIEW | Add subtle noise texture overlay on panels for depth |
| 1 | REVIEW | Add subtle status-change icon morph (todo→running→done) with SVG path transition |
| 1 | REVIEW | Enhance drag ghost with 3D tilt + soft glow + reduced opacity |
| 1 | REVIEW | Introduce completion confetti burst (CSS-only, 12 particles, 0.6s) |
| 1 | REVIEW | Add live-update pulse highlight (0.3s glow fade on WS patch) |
| 1 | REVIEW | Implement drag insertion line with animated dash offset |
| 1 | REVIEW | Add pointer-based touch dragging fallback; native HTML5 drag remains desktop enhancement. |
| 1 | REVIEW | Auto-scroll Todo at column edges, with velocity preview and scroll-position announcements. |
| 1 | REVIEW | Resolve reorder races using server revision tokens, optimistic rollback, and conflict toast. |
| 1 | REVIEW | Differentiate fresh, changed, and acknowledged live updates with localized field-level highlights. |
| 1 | REVIEW | Audit every accent against dark surfaces; reserve brightest cyan for actionable focus. |
| 1 | REVIEW | Add subtle red chromatic pulse and micro-shake on task transition into Error state. |
| 1 | REVIEW | Add interactive radial cursor-spotlight subtle glow over dark panel background (#131b28). |
| 1 | REVIEW | Display WebSocket connection quality ring with ambient green/amber pulse in header bar. |
| 1 | REVIEW | Add dashed glowing ghost placeholder frame showing exact drop target footprint during DnD. |
| 1 | REVIEW | Provide optional toggle for subtle Web Audio synthetic tick/pop sound micro-effects. |
| 1 | REVIEW | Rank-1 Todo card gets breathing 'next up' halo and micro-label |
| 1 | REVIEW | Todo→Running claim: card flies across columns with brief motion-trail |
| 1 | REVIEW | Error cards: one-shot red jitter, crimson vignette, retry-pulse affordance |
| 1 | REVIEW | Drag auto-scroll near column edges, with edge-glow gradient hint |
| 1 | REVIEW | Running border hue warms amber→orange as elapsed crosses time thresholds |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Card drop uses elastic overshoot + micro-bounce settle |
| 1 | REVIEW | Status pill morphs via SVG icon blend on change |
| 1 | REVIEW | Live-update sheen now follows cursor on hover |
| 1 | REVIEW | Running sweep conic accelerates on claim with flare |
| 1 | REVIEW | Error column gets reactive red particle flicker on new |
| 1 | REVIEW | Spring overshoot on drop-settle (0.5s cubic-bezier) |
| 1 | REVIEW | Staggered card reveal on column mount (0.1s delay each) |
| 1 | REVIEW | Status pill morph with color crossfade + scale bounce |
| 1 | REVIEW | Running conic border sweep speed up on hover |
| 1 | REVIEW | Done card fade-in with ripple ring + checkmark bloom |
| 1 | REVIEW | Morph status icon and label through a compact state-specific CSS mask. |
| 1 | REVIEW | Animate priority rank badges with color interpolation, not abrupt renumbering. |
| 1 | REVIEW | Use a brief directional trail behind dragged cards, disappearing before drop. |
| 1 | REVIEW | Crossfade updated card fields, preserving text position to prevent layout jitter. |
| 1 | REVIEW | Pulse column rail only on meaningful count or status changes, never timer ticks. |
| 1 | REVIEW | Error state entry triggers 300ms directional micro-shake and subtle red ambient flash. |
| 1 | REVIEW | Filter/search matching highlights slide in with 180ms staggered horizontal fade-scale transition. |
| 1 | REVIEW | Card deletion executes 200ms shrink-and-implode motion before neighbor FLIP recalculation. |
| 1 | REVIEW | Column expansion/collapse toggles smooth cubic-bezier 300ms width morph and header realign. |
| 1 | REVIEW | Hovering card action buttons triggers 120ms spring scale-up with background glow fill. |
| 1 | REVIEW | Cross-column claim flight: FLIP between containers, 0.42s overshoot easing |
| 1 | REVIEW | Sticky headers crossfade backdrop-blur plus shadow once column scrolls |
| 1 | REVIEW | Filter typing: non-matches shrink-desaturate out, matches pop with token highlight |
| 1 | REVIEW | Empty column shows breathing dashed drop socket, brightens on dragover |
| 1 | REVIEW | Status icon morphs spinner→check→cross via SVG stroke-dash transition |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Dynamic status-tinted ambient glow on card hover |
| 1 | YES | Multi-layer glassmorphic headers with gradient shine |
| 1 | REVIEW | Drag grip uses reactive color shift + scale pulse |
| 1 | REVIEW | Depth via inset bevel + colored drop-shadow system |
| 1 | REVIEW | Column drop zones highlight with vibrant status rim glow |
| 1 | REVIEW | Gradient column headers with subtle animated shimmer |
| 1 | REVIEW | Card depth via inset highlight + ambient colored shadow |
| 1 | REVIEW | Drag halo with radial gradient glow (indigo/violet) |
| 1 | REVIEW | Status-colored hover lift with box-shadow spread |
| 1 | REVIEW | Count chip digit roll with easing (0.3s) — already done |
| 1 | YES | Introduce a four-step semantic tint scale: surface, hover, active, focus, with verified contrast. |
| 1 | REVIEW | Give Todo priority ranks a violet-to-cyan spectral progression tied to urgency, not arbitrary color. |
| 1 | REVIEW | Render a custom compact drag ghost showing title, rank, and destination priority. |
| 1 | REVIEW | Add low-frequency radial spotlight following pointer within Todo, clipped and GPU-cheap. |
| 1 | YES | Use subtle noise-free glass edge highlights; avoid blur behind dense text. |
| 1 | YES | Glassmorphism backdrop-filter blur on sticky column headers when scrolling cards underneath. |
| 1 | YES | Error cards gain subtle dark-red ambient drop shadow (#ff5d6c22) to contrast Todo/Running. |
| 1 | REVIEW | Model selector badge displays fine metallic gradient edge on hover for high-effort models. |
| 1 | REVIEW | Drag phantom preview uses semi-transparent frosted card blur with vibrant indigo rim. |
| 1 | REVIEW | Task duration counters glow cyan when updated live via active agent execution thread. |
| 1 | REVIEW | Custom setDragImage: 2x canvas ghost, rounded, status-tinted, cursor-anchored |
| 1 | REVIEW | Per-column mask-image scroll fades for depth without extra borders |
| 1 | REVIEW | Formalize OKLCH accent ramps as tokens; verify 4.5:1 over gradients |
| 1 | REVIEW | Multi-select drag: shift-click range, stacked ghost with count badge |
| 1 | REVIEW | Board ambient wash reacts to state: red when errors, green when drained |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Elastic drop overshoot with status-colored bloom |
| 1 | REVIEW | Dynamic ambient glow tied to card status |
| 1 | REVIEW | SVG morphing status icons on transition |
| 1 | REVIEW | Completion confetti burst (CSS-only, 12 particles) |
| 1 | REVIEW | Drag ghost 3D tilt + soft glow |
| 1 | REVIEW | Status-change icon morph with SVG path transition |
| 1 | REVIEW | Add touch dragging with edge auto-scroll and clear destination-priority preview. |
| 1 | REVIEW | Ship state-change icon morphs and localized field highlights for visibly reactive updates. |
| 1 | YES | Tune semantic accent contrast and add a custom destination-aware drag ghost. |
| 1 | YES | Glassmorphism backdrop-blur on sticky column headers during card list scroll. |
| 1 | REVIEW | Interactive mouse cursor radial spotlight subtle glow over dark background grid. |
| 1 | REVIEW | Chromatic error transition micro-shake when tasks enter Error state live. |
| 1 | REVIEW | Claim-handoff flight animation Todo→Running with FLIP overshoot |
| 1 | REVIEW | Next-up anticipation halo on rank-1 Todo card |
| 1 | REVIEW | Drag edge auto-scroll plus custom crisp drag ghost image |

## Font suggestions

- **x-ai/grok-4.20:** 'Inter', system-ui, sans-serif (modern premium readability) · pair: 'Space Grotesk', sans-serif
  - `500-700 weights, -0.015em tracking for headings`
- **deepseek/deepseek-v4-flash:** system-ui -1 for crispness, zero dep · pair: none needed
  - `500 weight, -0.01em tracking for compact labels`
- **openai/gpt-5.6-luna:** Inter, ui-sans-serif, system-ui; highly legible at compact sizes with excellent numeric clarity. · pair: JetBrains Mono for identifiers, paths, models, and priority metadata.
  - `Use 500–700 weights, slightly tightened headings, and normal tracking for body text.`
- **google/gemini-3.6-flash:** Inter, system-ui, sans-serif for crystal clarity and sleek modern metric geometry · pair: JetBrains Mono for monospace IDs, model tags, durations, and prompt code blocks
  - `font-weight 500/600 with -0.011em tracking on titles; monospace tabular-nums on timers`
- **anthropic/claude-opus-5:** System UI stack (-apple-system, Segoe UI, Inter): zero-dep, crisp at small dark-theme sizes · pair: ui-monospace/JetBrains Mono for ids, paths, model tags, elapsed digits
  - `600 titles at -0.01em, 500 pills uppercase +0.06em, 400 body, tabular-nums timers`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Extend palette with electric violet #a78bff + teal glow accents
2. [professional · 1×] Multi-layer glassmorphic headers with gradient shine
3. [professional · 1×] Introduce a four-step semantic tint scale: surface, hover, active, focus, with verified contrast.
4. [professional · 1×] Use subtle noise-free glass edge highlights; avoid blur behind dense text.
5. [professional · 1×] Glassmorphism backdrop-filter blur on sticky column headers when scrolling cards underneath.
6. [professional · 1×] Error cards gain subtle dark-red ambient drop shadow (#ff5d6c22) to contrast Todo/Running.
7. [top3_must · 1×] Tune semantic accent contrast and add a custom destination-aware drag ghost.
8. [top3_must · 1×] Glassmorphism backdrop-blur on sticky column headers during card list scroll.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=2 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — FLARE round 3 → LOOP COMPLETE
**SHIPPED:** next-up anticipation halo on the rank-1 Todo card (pulsing indigo glow = "claimed next"),
tying the drag-reorder priority to a visible cue. Reduced-motion → static glow.
**SKIPPED:** completion confetti (already have ripple+bloom), mouse cursor spotlight (per-frame cost,
declined in r2), cross-column claim-flight animation + touch-drag/edge-autoscroll (scope-creep;
board is a desktop operator tool), glassmorphism header blur (marginal — header doesn't overlap scroll).
**STOPPED:** 2/5 stop votes and the agree queue held only gimmick/scope-creep beyond the halo.

## Loop complete (FLARE)
- Rounds run: 3 (5-model jury each)
- Shipped: R1 big flare+DnD pass (gradients/glow/depth/conic-sweep/drag-reorder/rank-badges/accents/bg/roll/bounce/staggered),
  R2 unanimous refinements (drop-settle spring, done ripple+bloom, live sheen, keyboard reorder),
  R3 next-up halo
- Stopped: R3 = 2 stop votes + nits/scope-creep remainder
- New backend: POST /api/board/reorder (drag priority). 130/130 tests pass each round; 0 console errors in-browser.
- Outstanding (future, opt-in): touch-drag + mobile, cross-column claim-flight animation
