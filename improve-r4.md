# Design Jury — Round 4

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add live WebSocket reactive shimmer on card updates |
| 1 | REVIEW | Introduce vibrant gradient status pills with soft inner glow |
| 1 | REVIEW | Enhance drag with ghost card + magnetic snap feedback |
| 1 | REVIEW | Overlay subtle particle burst on task completion |
| 1 | REVIEW | Use hue-rotate filter on running cards for dynamic flare |
| 1 | REVIEW | Animate WebSocket inserts with origin-aware highlights, preserving stable scroll and keyboard focus. |
| 1 | REVIEW | Show Todo priority numbers on hover and announce reorder results through aria-live. |
| 1 | REVIEW | Make cards draggable via explicit grip, with keyboard reorder controls matching pointer behavior. |
| 1 | REVIEW | Use status-gradient accents sparingly: indigo Todo, amber Running, green Done, red Error. |
| 1 | REVIEW | Expose connection, syncing, and reorder-save states without blocking task work. |
| 1 | REVIEW | Drag grip handle with subtle dot matrix that glows on hover. |
| 1 | REVIEW | Animated neon insertion indicator line showing target drop index in Todo column. |
| 1 | REVIEW | Subtle radial background gradient aura tracking mouse cursor across active panels. |
| 1 | REVIEW | Running state card border uses multi-stop conic gradient sweep animation. |
| 1 | REVIEW | Dragged card scales to 1.03 with heavy drop shadow and blurred aura. |
| 1 | REVIEW | Add per-status CSS var triads: --hue-fill, --hue-glow, --hue-edge; drive all card chrome. |
| 1 | REVIEW | Give each card a 3px left status rail with vertical gradient, not flat border. |
| 1 | REVIEW | Drag handle: 6-dot grip at card left, brightens to accent on hover. |
| 1 | REVIEW | Live drop indicator: 2px indigo bar with soft glow between cards, animates width in. |
| 1 | REVIEW | Reactivity: any WebSocket-changed card flashes a one-shot accent ring, 400ms, then settles. |
| 1 | REVIEW | Add subtle gradient overlays to status pills (indigo→purple, amber→orange, green→teal, red→pink) for vibrancy. |
| 1 | REVIEW | Implement lift effect on drag start: card scales 1.02 with drop shadow, reduced opacity, and subtle glow. |
| 1 | REVIEW | On drop, brief color flash ripple at drop zone to confirm placement. |
| 1 | REVIEW | Add breathing glow to Running column header to indicate active work. |
| 1 | REVIEW | Use color-coded border-left on cards (thicker gradient) for quick status scanning. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | FLIP + scale-105 + springy 420ms cubic-bezier(0.34,1.56,0.64,1) on reorder |
| 1 | REVIEW | Running pulse becomes multi-layered neon ring with 0.8s rotate |
| 1 | REVIEW | Expand uses clip-path reveal + staggered child fade |
| 1 | REVIEW | Drag ghost employs 180ms backdrop-blur + 0.6 opacity lift |
| 1 | REVIEW | Error cards get micro-shake + desaturate-to-vivid flash on drop |
| 1 | REVIEW | FLIP reordered cards, then briefly spotlight the moved card and destination slot. |
| 1 | REVIEW | Use a springy lift on drag start, with pointer-aligned shadow and slight tilt. |
| 1 | REVIEW | Crossfade status changes while preserving card position, focus, and expanded content. |
| 1 | REVIEW | Pulse only newly changed metadata; stagger column arrivals by 30ms for live updates. |
| 1 | REVIEW | Add restrained radial cursor glow on actionable headers, disabled under reduced motion. |
| 1 | REVIEW | Dragged card lift animation using spring cubic-bezier bezier curve. |
| 1 | REVIEW | Column items reorder smoothly via CSS transform transitions during dragover. |
| 1 | REVIEW | Completion celebration effect using brief CSS particle burst on card status change. |
| 1 | REVIEW | Hover effect shifts card elevation Z-axis with 120ms spring backdrop filter. |
| 1 | REVIEW | Expansion accordion uses smooth grid-template-rows transition instead of max-height hack. |
| 1 | REVIEW | Drag lift: scale 1.03, rotate 1.5deg, shadow bloom, cursor-follow tilt on x-velocity. |
| 1 | REVIEW | Cards below the drop gap slide down 8px with 180ms spring, not jump. |
| 1 | REVIEW | Drop settle: card lands with 120ms overshoot squash then FLIP reflow neighbors. |
| 1 | REVIEW | Todo→Running: rail sweeps amber top-to-bottom; Done: green ring expands once outward. |
| 1 | REVIEW | Column header count numbers roll (translateY swap) instead of instantly replacing digits. |
| 1 | REVIEW | Card reorder drag: smooth FLIP animation for other cards with spring easing. |
| 1 | REVIEW | Status move (Todo→Running): brief whoosh effect – card scales down then up with color transition. |
| 1 | REVIEW | Expand/collapse prompt: staggered fade-in of content lines with slight delay. |
| 1 | YES | Modal overlay: blur background and scale in with bounce easing (reduced-motion fallback). |
| 1 | REVIEW | Status change: pill icon morphs smoothly (circle→checkmark for done) with color transition. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Indigo-to-cyan gradient borders with 8px soft outer glow |
| 1 | REVIEW | Depth via layered box-shadows (0 0 0 1px inset + 0 20px 40px -10px) |
| 1 | REVIEW | Running cards feature animated mesh gradient background |
| 1 | REVIEW | Drop targets show thick glowing indigo underline + scale |
| 1 | REVIEW | Drag uses custom cursor with trailing micro-orb trail |
| 1 | REVIEW | Build layered status gradients from base colors toward luminous, accessible endpoint accents. |
| 1 | YES | Give dragged cards a glassy elevated surface, halo, and crisp insertion line. |
| 1 | YES | Add column header ambient washes keyed to status, staying below text contrast. |
| 1 | REVIEW | Use depth hierarchy: panel shadows, inset borders, and brighter focused-card edges. |
| 1 | REVIEW | Reserve cyan-violet accent sparks for successful reorder and completed agent milestones. |
| 1 | REVIEW | Multi-layered drop shadows with colored ambient glow matching card status color. |
| 1 | YES | Glassmorphism cards with subtle 1px border gradient glowing from top-left. |
| 1 | REVIEW | Priority rank badges in Todo column with glowing chromatic index numbers. |
| 1 | REVIEW | Active WebSocket live sync indicator with dual-ring pulsing amber radial aura. |
| 1 | REVIEW | Column headers feature subtle linear gradient top borders matching status hex codes. |
| 1 | REVIEW | Panel depth: subtle top inner highlight (rgba white 4%) plus 24px ambient shadow below. |
| 1 | REVIEW | Running cards get animated conic gradient border, 6s rotation, 12% opacity — premium not noisy. |
| 1 | REVIEW | Done summary bullets fade-in staggered 40ms each, giving completion a felt cadence. |
| 1 | REVIEW | Add secondary accents: cyan #35d6e5 for follow-ups, violet #a26bff for cloned lineage. |
| 1 | REVIEW | While dragging, dim non-Todo columns to 70% and desaturate — focus the reorder space. |
| 1 | REVIEW | Subtle noise texture overlay on panels (low opacity) for depth. |
| 1 | REVIEW | Gradient background for board (dark blue to dark purple) to add richness. |
| 1 | REVIEW | Soft glow around active drag card (box-shadow with spread) and gradient drop indicator line. |
| 1 | REVIEW | Status pills: gradient background with inner shadow for 3D effect. |
| 1 | YES | Glassmorphism column headers: semi-transparent background with blur and subtle border glow. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Magnetic drag handles with gradient orb + lift glow |
| 1 | REVIEW | Neon status pill gradients + running multi-ring pulse |
| 1 | REVIEW | Springy FLIP reorder with ghost blur and particle snap |
| 1 | REVIEW | Add explicit Todo drag grips, magnetic insertion indicators, and persisted reorder feedback. |
| 1 | REVIEW | Introduce accessible status gradients, column washes, and focused-card edge glows. |
| 1 | REVIEW | Polish FLIP with lift, destination spotlight, and live-update highlight choreography. |
| 1 | REVIEW | Conic gradient border sweep animation for active Running cards. |
| 1 | REVIEW | Drag-and-drop reordering with springy neon drop-target insertion indicator line. |
| 1 | REVIEW | Status-colored ambient radial glow on card hover and drag state. |
| 1 | REVIEW | Drag handle + glowing drop indicator + neighbor slide-down for Todo reorder. |
| 1 | REVIEW | Status color triads with gradient rails and status-specific glow tiers. |
| 1 | REVIEW | Done-completion moment: green ring pulse plus staggered summary bullet reveal. |
| 1 | REVIEW | Drag-and-drop with smooth FLIP reordering and lift effect (high usability + delight). |
| 1 | REVIEW | Gradient status pills and column headers with subtle glow (immediate visual upgrade). |
| 1 | REVIEW | Staggered expand/collapse animations with spring easing (premium interaction feel). |

## Font suggestions

- **x-ai/grok-4.20:** 'Inter', system-ui, sans-serif (modern premium readability) · pair: 'Space Grotesk', sans-serif
  - `600 tracking-[-0.02em] for titles, 500 for body`
- **openai/gpt-5.6-luna:** Inter, system-ui, sans-serif — highly legible UI proportions with strong numeric clarity. · pair: JetBrains Mono for ids, paths, models, and timers.
  - `400 body, 600 labels, 700 titles; -0.01em headings, normal data tracking.`
- **google/gemini-3.6-flash:** Inter, -apple-system, sans-serif for ultra-clean UI legibility · pair: JetBrains Mono for monospace IDs, paths, and model tags
  - `Font-weight 500/600 with letter-spacing -0.01em for dense modern dashboard feel`
- **anthropic/claude-opus-5:** Inter var / system-ui stack — tight optical sizes, excellent dark-mode legibility · pair: JetBrains Mono for ids, paths, model tags (already monospace — unify on it)
  - `600 titles at -0.01em, 400 body, 500 uppercase pills at +0.06em tracking`
- **deepseek/deepseek-v4-flash:** System font stack (Inter, system-ui) for legibility · pair: JetBrains Mono or SF Mono for code consistency
  - `Variable weights (400 body, 600 titles) with tracking 0.02em`

## Auto-agree implementation queue (by votes)

1. [transitions · 1×] Modal overlay: blur background and scale in with bounce easing (reduced-motion fallback).
2. [professional · 1×] Give dragged cards a glassy elevated surface, halo, and crisp insertion line.
3. [professional · 1×] Add column header ambient washes keyed to status, staying below text contrast.
4. [professional · 1×] Glassmorphism cards with subtle 1px border gradient glowing from top-left.
5. [professional · 1×] Glassmorphism column headers: semi-transparent background with blur and subtle border glow.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — FLARE round 1 (direction unlocked by founder)
**SHIPPED** (verified in-browser, 0 console errors, DnD endpoint tested):
- Native HTML5 **drag-and-drop** Todo reorder → new POST /api/board/reorder (sets worker priority);
  grip handle, violet **rank badges**, lift+tilt+halo drag, glowing indigo drop-insertion line,
  neighbor FLIP, dim non-Todo columns while dragging, optimistic local reorder + persist
- **Gradient status pills** (per-status) + **gradient column-header rails** + status glow
- Card **depth**: inset top highlight + colored ambient hover/drag glow; hover lift (spring)
- Running **conic-gradient rotating border sweep** (3.2s, low opacity — premium not noisy)
- Secondary **cyan/violet accents** (follow-up focus = cyan, thread prompt = cyan, rank = violet)
- Richer **board background** (indigo+violet radial washes)
- **Count-chip digit roll**, **modal bounce-in**, **staggered summary bullet reveal** (40ms)
- ALL new motion gated under prefers-reduced-motion
**SKIPPED (this round):** cross-column drag (workers own Running), particle-burst on completion
(deferred to r2 if wanted), custom cursor-trail orb (gimmick), noise-texture overlay.
