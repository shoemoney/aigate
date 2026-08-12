# Design Jury — Round 2

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Focus rings need 2px offset for better visibility |
| 1 | REVIEW | Meta text #777 too light on mobile at 320px |
| 1 | REVIEW | Add aria-labels to all Three.js controls |
| 1 | YES | Thumbs need higher contrast SVG on small viewports |
| 1 | REVIEW | Footer nav should wrap gracefully below 480px |
| 1 | YES | Fix thumb contrast at 320px min width |
| 1 | REVIEW | Add visible loading skeleton for canvas effects |
| 1 | REVIEW | Unify focus ring offset across all interactive |
| 1 | REVIEW | Ensure touch targets ≥44px for mobile nav |
| 1 | REVIEW | Clarify active state on foot nav pills |
| 1 | REVIEW | Add visual keyboard shortcut indicators for arrow key canvas navigation. |
| 1 | REVIEW | Ensure foot nav pill link touch targets reach minimum 44px on mobile. |
| 1 | REVIEW | Add aria-live region to announce canvas slide changes to screen readers. |
| 1 | REVIEW | Implement double-tap or swipe gestures for canvas prev/next on mobile touch. |
| 1 | REVIEW | Prevent HUD text clipping on 320px screens with responsive badge padding. |
| 1 | REVIEW | Thumbs need 320px min-height floor; 16/10 crushes SVG detail |
| 1 | REVIEW | Add per-card index numerals (01–11) for wayfinding |
| 1 | REVIEW | Gallery header needs one-line 'what this is' subline |
| 1 | REVIEW | Foot nav should show effect name, not just prev/next |
| 1 | REVIEW | Card titles must truncate with ellipsis, not wrap two lines |
| 1 | YES | Add persistent effect titles beneath thumbnails; avoid hover-only identification. |
| 1 | YES | Verify thumbnail focal forms remain legible at 320px without detail collapse. |
| 1 | REVIEW | Match focus-visible card elevation, border, and metadata reveal exactly to hover. |
| 1 | REVIEW | Show current effect position in foot navigation, such as 03/11. |
| 1 | REVIEW | Keep skip-link destination visibly focused after activation. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Stagger entrance feels delayed on fast devices |
| 1 | REVIEW | Canvas resume on tab return needs instant repaint |
| 1 | REVIEW | Hover-to-focus ring transition too abrupt |
| 1 | YES | Dust points drift speed should respect reduced-motion |
| 1 | REVIEW | Vignette fade on page load is jarring |
| 1 | REVIEW | Stagger thumbs entrance at 60ms not 40ms |
| 1 | REVIEW | Add subtle green pulse on canvas HUD hover |
| 1 | REVIEW | Fade foot nav pills on transition between slides |
| 1 | REVIEW | Delay Three.js fog drift on idle to save GPU |
| 1 | REVIEW | Smooth scroll-to-gallery after skip link |
| 1 | REVIEW | Add subtle crossfade effect when switching canvases via prev/next links. |
| 1 | REVIEW | Smoothly interpolate HUD telemetry numbers instead of instantly snapping values. |
| 1 | REVIEW | Animate Three.js fog density smoothly during canvas focus mode transitions. |
| 1 | REVIEW | Add subtle scale-down spring physics to gallery cards on mouse press. |
| 1 | REVIEW | Debounce canvas resize listeners to eliminate viewport layout reflow flickering. |
| 1 | REVIEW | Add 120ms crossfade on gallery→effect nav to hide canvas pop |
| 1 | REVIEW | Hover should lift 2px only; keep shadow, drop scale |
| 1 | REVIEW | Canvas fade-in from black over 400ms on first frame |
| 1 | REVIEW | Foot nav pills need 150ms border-color ease, not instant |
| 1 | REVIEW | Stagger should run once per session, not on back-nav |
| 1 | REVIEW | Cap gallery stagger at 400ms, preserving immediate first-row comprehension. |
| 1 | REVIEW | Instrument RAF counts: hidden tabs and reduced motion must reach zero. |
| 1 | YES | Test live reduced-motion toggles; freeze pointers, shader time, and particles. |
| 1 | REVIEW | Resume animations without timestamp jumps after tab visibility restoration. |
| 1 | REVIEW | Mirror hover timing and easing exactly for keyboard focus transitions. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | HUD blur badge lacks subtle inner glow |
| 1 | REVIEW | Card shadows need tighter green hue match |
| 1 | REVIEW | Orbit controls feel consumer not premium |
| 1 | REVIEW | Entrance animation lacks sophistication |
| 1 | REVIEW | Vignette intensity too heavy on canvases |
| 1 | REVIEW | Tighten card shadow to 0 2px 10px green |
| 1 | REVIEW | Increase meta text to 0.85rem for readability |
| 1 | REVIEW | Add micro spacing (2px) between grid items |
| 1 | REVIEW | Use consistent green accent on scrollbar track |
| 1 | REVIEW | Replace #0a0a0a cards with #000 for deeper black |
| 1 | REVIEW | Apply sub-pixel 1px green alpha border gradient to gallery card frames. |
| 1 | REVIEW | Overlay 2% SVG film grain noise across #0a0a0a card backgrounds. |
| 1 | REVIEW | Differentiate active canvas HUD depth using elevated dual-layer green glow. |
| 1 | REVIEW | Add precise micro-dot status indicators to footer state telemetry badges. |
| 1 | REVIEW | Enforce strict uppercase tracking on all micro-labels and system tags. |
| 1 | REVIEW | Add 1px hsl(142 76% 50% / 0.12) hairline card borders |
| 1 | REVIEW | HUD badge needs fixed min-width so digits stop jittering |
| 1 | REVIEW | Tighten grid gutters to 24px; current spacing reads loose |
| 1 | REVIEW | Footer: version stamp plus 'no analytics, no deps' line |
| 1 | REVIEW | Vignette should be radial not linear; corners currently uneven |
| 1 | REVIEW | Standardize card border opacity across idle, hover, focus, and active. |
| 1 | REVIEW | Normalize HUD padding, corner radius, and baselines across eleven canvases. |
| 1 | REVIEW | Use one vignette curve; protect peripheral canvas detail from muddy falloff. |
| 1 | YES | Normalize thumbnail stroke weight after downscaling for consistent gallery rhythm. |
| 1 | REVIEW | Align foot-navigation pills to a shared width and optical baseline. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | Increase meta contrast to #aaa |
| 1 | REVIEW | Soften stagger to 25ms increments |
| 1 | REVIEW | Refine HUD badge with green inner glow |
| 1 | YES | Fix thumb contrast at 320px viewport |
| 1 | REVIEW | Unify focus ring offset and color |
| 1 | REVIEW | Add visible loading skeleton for canvases |
| 1 | REVIEW | Add keyboard arrow key navigation with visual UI shortcut badges in HUD. |
| 1 | REVIEW | Apply 1px green border gradients and subtle grain to gallery cards. |
| 1 | REVIEW | Add smooth crossfades and canvas transition states to prev/next navigation. |
| 1 | REVIEW | Thumb min-height at 320px — legibility is currently broken |
| 1 | REVIEW | Hairline green card borders for premium edge definition |
| 1 | REVIEW | Named foot nav so users know where next goes |
| 1 | REVIEW | Prove RAF reaches zero when hidden or reduced motion activates. |
| 1 | YES | Guarantee thumbnail focal forms remain legible at 320px. |
| 1 | REVIEW | Make focus-visible styling exactly equivalent to every card hover state. |

## Font suggestions

- **x-ai/grok-4.20:** system-ui mono for crisp terminal feel
  - `400/500 tracking -0.02em`
- **deepseek/deepseek-v4-flash:** JetBrains Mono — crisp monospace for tech tone
  - `weight 400/700, tracking 0.02em`
- **google/gemini-3.6-flash:** ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace for raw technical precision.
  - `font-weight 400/500, letter-spacing -0.02em body, +0.08em uppercase tags.`
- **anthropic/claude-opus-5:** ui-monospace/SFMono stack — matches terminal-instrument tone, zero payload
  - `400 body, 500 titles, 0.02em tracking, uppercase labels only`
- **openai/gpt-5.6-sol:** System monospace stack — dependency-free, technical, and consistent with constraints.
  - `Use 500 headings, 400 metadata; track labels 0.08em, body 0.02em.`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Thumbs need higher contrast SVG on small viewports
2. [general · 1×] Fix thumb contrast at 320px min width
3. [general · 1×] Add persistent effect titles beneath thumbnails; avoid hover-only identification.
4. [general · 1×] Verify thumbnail focal forms remain legible at 320px without detail collapse.
5. [transitions · 1×] Dust points drift speed should respect reduced-motion
6. [transitions · 1×] Test live reduced-motion toggles; freeze pointers, shader time, and particles.
7. [professional · 1×] Normalize thumbnail stroke weight after downscaling for consistent gallery rhythm.
8. [top3_must · 1×] Increase meta contrast to #aaa
9. [top3_must · 1×] Fix thumb contrast at 320px viewport
10. [top3_must · 1×] Guarantee thumbnail focal forms remain legible at 320px.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
