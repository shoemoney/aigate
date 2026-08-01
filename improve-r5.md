# Design Jury — Round 5

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Live WebSocket card highlight flash on update (amber-indigo gradient sweep) |
| 1 | YES | Extend palette with electric violet #a78bff + teal #14f0c8 accents for glows |
| 1 | REVIEW | Drag grip uses morphing lucide icon with reactive scale on hover |
| 1 | REVIEW | Column drop-zones show colored holographic insertion beams with particle burst |
| 1 | REVIEW | Error cards emit subtle red scanline effect during hover/drag |
| 1 | REVIEW | Drag drop settle with spring overshoot animation |
| 1 | REVIEW | Completion card burst green glow + checkmark scale |
| 1 | REVIEW | Live-update new card shimmer sweep highlight |
| 1 | REVIEW | Status change icon morph (circle→check→cross) |
| 1 | REVIEW | Drag ghost tilt + shadow depth increase |
| 1 | REVIEW | Coalesce bursty WebSocket updates, animate one grouped refresh, and preserve scroll and focus. |
| 1 | REVIEW | Expose Space plus Arrow-key Todo reordering with identical priority announcements and insertion feedback. |
| 1 | YES | Add status icons alongside color, preserving WCAG contrast and color-blind recognition. |
| 1 | REVIEW | Celebrate completion with a restrained card-to-column energy trail and summary reveal. |
| 1 | REVIEW | Show connection latency or stale-state feedback without blocking task scanning or controls. |
| 1 | REVIEW | Flash WS live-updated cards with a temporary status-colored 1.5s border aura highlight. |
| 1 | REVIEW | Trigger radial bloom and checkmark ripple celebration when card status switches to Done. |
| 1 | REVIEW | Add cursor-tracking CSS radial spotlight gradient mask over card backgrounds on hover. |
| 1 | REVIEW | Elastic rubber-band scale overshoot when dropping reordered cards into place. |
| 1 | REVIEW | Animate red flame aura with subtle horizontal micro-vibration on active Error state cards. |
| 1 | REVIEW | Drop-settle: card overshoots 3px past slot, springs back, halo fades 180ms |
| 1 | REVIEW | Live-update highlight: 700ms status-colored inner glow wash on any WS-patched card |
| 1 | REVIEW | Rank badges count-renumber after reorder — digit roll cascades top-down, 30ms stagger |
| 1 | REVIEW | Auto-scroll Todo column when dragging within 60px of top/bottom edge |
| 1 | REVIEW | Custom setDragImage: compact ghost with id, rank, truncated title only |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Drag lift uses 3D rotateX(8deg) + scale(1.04) with cubic-bezier(0.32,0.72,0,1.4) overshoot |
| 1 | REVIEW | Card drop settle triggers micro-bounce + status pill morph via FLIP |
| 1 | REVIEW | Running timer digits use flip-clock style counter with blur transition |
| 1 | REVIEW | Completion triggers success confetti burst constrained to card bounds (CSS only) |
| 1 | REVIEW | Live-update triggers ripple glow from card center using ::after pseudo |
| 1 | REVIEW | Card reorder neighbor FLIP with 0.3s ease-out |
| 1 | REVIEW | Drop target insertion line glow pulse 0.5s |
| 1 | REVIEW | Running border conic gradient rotate 4s linear |
| 1 | REVIEW | Modal open bounce scale 0.9→1 with 0.2s |
| 1 | REVIEW | Staggered bullet reveal 0.05s delay each |
| 1 | REVIEW | Give dropped cards a 180ms spring settle with subtle overshoot, then restore neutral elevation. |
| 1 | REVIEW | Morph status icons between queued, running, success, and error states instead of swapping abruptly. |
| 1 | REVIEW | Highlight externally updated cards with a 700ms directional sheen and timestamp badge refresh. |
| 1 | REVIEW | Ripple a faint status-colored pulse through the destination column after successful completion. |
| 1 | REVIEW | Animate priority badges through their new ranks using staggered opacity and vertical interpolation. |
| 1 | REVIEW | Morph status pills fluidly with CSS layout transitions between states (Todo/Running/Done). |
| 1 | REVIEW | Apply spring keyframe drop-settle scale (0.96 to 1.04 to 1.0) on drag release. |
| 1 | REVIEW | Stagger board initial load with 30ms offset cascading blur-and-slide keyframe animations per card. |
| 1 | REVIEW | Pulse timer text opacity and indigo glow in sync with every running second. |
| 1 | REVIEW | Smoothly interpolate backdrop-filter blur (0px to 16px) during prompt modal presentation. |
| 1 | REVIEW | Done moment: green ripple ring expands from status pill, SVG check strokes in |
| 1 | REVIEW | Status pill icon morph: spinner→check via shared 12px circle, 220ms crossfade |
| 1 | REVIEW | Error arrival: 2-cycle 3px horizontal shake plus red bloom, once only |
| 1 | REVIEW | Running elapsed timer digits shimmer left-to-right every 10s, 8% white sweep |
| 1 | REVIEW | Empty Todo shows dashed indigo drop-well that breathes scale 0.99→1 |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Multi-layer card shadows: inset neon, ambient status-tinted bloom, deep panel shadow |
| 1 | REVIEW | Status pills use conic-gradient shimmer on active states with 4px soft outer glow |
| 1 | YES | Column headers feature glassmorphic frosted edge + vibrant status rail gradient |
| 1 | REVIEW | Drag preview uses backdrop-filter blur(12px) + vibrant halo ring matching status |
| 1 | REVIEW | Insertion line animates width + luminosity with cubic spring physics via CSS |
| 1 | REVIEW | Gradient column headers with status tint wash |
| 1 | REVIEW | Card inset highlight + ambient colored shadow |
| 1 | REVIEW | Drag halo 12px blur indigo glow |
| 1 | REVIEW | Status pill gradient with subtle inner light |
| 1 | REVIEW | Count chip digit roll 0.2s cubic-bezier |
| 1 | YES | Define indigo, violet, cyan, and status gradients with consistent lightness and contrast stops. |
| 1 | REVIEW | Layer soft radial lighting behind active columns, keeping card text areas visually quiet. |
| 1 | REVIEW | Reserve intense glows for focus, dragging, completion, and errors; keep ambient effects low-opacity. |
| 1 | REVIEW | Give drag ghosts a frosted surface, visible grip, priority badge, and destination-color edge lighting. |
| 1 | REVIEW | Use subtle grain or noise in board washes to prevent gradients feeling synthetic or flat. |
| 1 | REVIEW | Use dual-layer inset highlight rgba(255,255,255,0.08) and deep rgba(0,0,0,0.6) ambient card drop shadows. |
| 1 | REVIEW | Intensify column border glow and top rail gradient when dragging over active zones. |
| 1 | REVIEW | Add subtle multi-point radial mesh ambient gradients behind Running and Done column regions. |
| 1 | REVIEW | Animate solar-orange backlight glow behind Max-effort badges for high-urgency visual hierarchy. |
| 1 | REVIEW | Render glowing dashed outline drop placeholder matching exact dimensions of currently dragged card. |
| 1 | REVIEW | Card left edge: 2px status gradient bar, brightens on hover/focus |
| 1 | REVIEW | Effort tint upgrade: high=amber→rose gradient chip, max adds inner rim light |
| 1 | REVIEW | Add 3% overlay grain texture so gradients avoid banding on dark panels |
| 1 | REVIEW | Drag spotlight: soft radial indigo light follows pointer inside Todo column |
| 1 | REVIEW | Elevate dragged card to layer 3 shadow; source slot collapses to translucent trench |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Drag-drop with tilt, overshoot settle + neighbor FLIP refinement |
| 1 | REVIEW | Status-triggered card bloom/glow + live-update ripple highlight |
| 1 | REVIEW | Completion burst + running conic sweep polish with new teal accent |
| 1 | REVIEW | Drag settle spring overshoot for tactile feedback |
| 1 | REVIEW | Completion burst green glow + checkmark scale |
| 1 | REVIEW | Live-update shimmer sweep for new cards |
| 1 | REVIEW | Add springy drop-settle choreography with keyboard-equivalent reorder feedback and announcements. |
| 1 | REVIEW | Introduce live-update sheens plus completion energy trails without shifting layout or stealing focus. |
| 1 | YES | Refine semantic gradients, contrast, and glow hierarchy around status, focus, dragging, and errors. |
| 1 | REVIEW | Completion celebration pulse and checkmark bloom ripple when task status turns Done. |
| 1 | REVIEW | Elastic spring overshoot scale transition on drop release for tactile drag feedback. |
| 1 | REVIEW | Mouse-tracking radial spotlight glow overlay on card hover for dynamic tactile depth. |
| 1 | REVIEW | Done completion moment: ripple ring plus stroke-drawn checkmark |
| 1 | REVIEW | Live-update highlight wash on every WebSocket card patch |
| 1 | REVIEW | Drop-settle overshoot spring plus cascading rank renumber |

## Font suggestions

- **x-ai/grok-4.20:** 'Inter', system-ui, sans-serif (improved readability over mono while retaining tech feel) · pair: 'Space Grotesk', sans-serif
  - `500-700 weights, -0.02em tracking, dynamic font-size scaling`
- **deepseek/deepseek-v4-flash:** Inter system stack for crisp legibility · pair: JetBrains Mono for monospace IDs
  - `500 weight, -0.01em tracking`
- **openai/gpt-5.6-luna:** Inter, ui-sans-serif, system-ui, sans-serif — highly legible at compact dashboard sizes · pair: IBM Plex Mono, ui-monospace, SFMono-Regular, monospace for ids, paths, and model tags
  - `Use 500–700 weights for state emphasis; track headings -0.01em and metadata +0.02em.`
- **google/gemini-3.6-flash:** JetBrains Mono, Inter, system-ui - Crisp technical precision with humanized UI readability. · pair: Fira Code for mono task IDs and prompt tokens.
  - `Font-weight 500-700, tracking -0.015em on titles, tabular numerals for live timers.`
- **anthropic/claude-opus-5:** Inter var via system stack (-apple-system, Segoe UI Variable) — tight dark-UI legibility · pair: JetBrains Mono fallback ui-monospace for ids, paths, model tags, timers
  - `600/-0.01em titles, 500 pills uppercase +0.06em, tabular-nums all timers`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Extend palette with electric violet #a78bff + teal #14f0c8 accents for glows
2. [general · 1×] Add status icons alongside color, preserving WCAG contrast and color-blind recognition.
3. [professional · 1×] Column headers feature glassmorphic frosted edge + vibrant status rail gradient
4. [professional · 1×] Define indigo, violet, cyan, and status gradients with consistent lightness and contrast stops.
5. [top3_must · 1×] Refine semantic gradients, contrast, and glow hierarchy around status, focus, dragging, and errors.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — FLARE round 2
**SHIPPED** (verified in-browser, 0 console errors): unanimous 5/5 refinements —
- **Drop-settle overshoot spring** on the landed card after a drag reorder
- **Done completion moment**: green ripple ring + ✓ checkmark bloom when a card turns Done (WS-driven)
- **Live-update sheen** sweep on every WebSocket card patch
- **Keyboard reorder** (Alt+↑/↓ on a focused Todo card) + aria-live announce — a11y complement to DnD
All gated under prefers-reduced-motion.
**SKIPPED:** mouse-tracking radial spotlight (1 vote, per-frame mousemove cost/jank risk) — hover glow already covers it.
