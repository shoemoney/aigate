# Design Jury — Round 1

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | Increase gallery card thumb contrast for scannability |
| 1 | YES | Add reduced-motion fallback on all canvas effects |
| 1 | REVIEW | Tighten top HUD badge padding to 6px 10px |
| 1 | REVIEW | Make gallery footer meta smaller at 10px |
| 1 | REVIEW | Ensure all canvases clear on resize before redraw |
| 1 | REVIEW | Add visible green focus rings to gallery cards for keyboard accessibility. |
| 1 | YES | Ensure prefers-reduced-motion systematically pauses requestAnimationFrame loops across all pages. |
| 1 | REVIEW | Add descriptive ARIA labels to canvas containers and interactive HUD elements. |
| 1 | REVIEW | Add keyboard shortcuts like Left/Right arrows for direct gallery effect switching. |
| 1 | YES | Improve inline SVG thumbnail contrast to better preview dense particle effects. |
| 1 | REVIEW | Add prev/next effect links in foot for sequential browsing |
| 1 | REVIEW | Give cards keyboard focus-visible ring matching hover glow |
| 1 | REVIEW | Show live index number badge on each gallery thumb |
| 1 | REVIEW | Make HUD badge collapsible via keypress; canvas stays hero |
| 1 | REVIEW | Unify tag vocabulary across cards — same 2 tags, same order |
| 1 | REVIEW | Standardize card title, tags, and arrow baselines across responsive columns. |
| 1 | REVIEW | Add visible green focus rings matching hover emphasis to every interactive element. |
| 1 | REVIEW | Make entire cards semantic links with descriptive accessible names. |
| 1 | YES | Reserve thumbnail aspect ratios to prevent responsive grid reflow. |
| 1 | REVIEW | Equalize HUD safe-area offsets across every effect page. |
| 1 | REVIEW | Add visible focus ring for keyboard navigation on cards and links. |
| 1 | YES | Ensure HUD text contrast passes WCAG AA on blurred background. |
| 1 | REVIEW | Add loading state placeholder while canvas initializes. |
| 1 | YES | Make gallery card thumbnails clickable with full card area. |
| 1 | REVIEW | Include skip-to-content link for keyboard users. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add 80ms ease-out on card hover lift glow |
| 1 | REVIEW | Smooth vignette opacity on page load |
| 1 | REVIEW | Fade HUD badge in after canvas init |
| 1 | YES | Particle systems respect reduced-motion |
| 1 | REVIEW | Consistent 300ms nav link hover tint |
| 1 | REVIEW | Throttle canvas frame rates automatically when browser tab loses active focus. |
| 1 | REVIEW | Add subtle CSS opacity fade-in when loading canvas HUD elements. |
| 1 | REVIEW | Smooth mouse repulsion physics in particle-field using damped exponential interpolation. |
| 1 | REVIEW | Use cubic-bezier easing for gallery card transform lift on hover. |
| 1 | REVIEW | Enforce dynamic devicePixelRatio scaling during browser resize events across canvas pages. |
| 1 | REVIEW | Stagger card entrance fade-up 40ms apart on gallery load |
| 1 | REVIEW | Cross-page canvas fade-in from black over 400ms |
| 1 | YES | Extend prefers-reduced-motion to freeze all eleven canvases consistently |
| 1 | REVIEW | Animate SVG thumbs subtly on hover, previewing real motion |
| 1 | REVIEW | Ease HUD badge opacity down after three idle seconds |
| 1 | YES | Extend reduced-motion handling consistently across all eleven canvases. |
| 1 | REVIEW | Pause rendering when tabs are hidden using visibilitychange. |
| 1 | REVIEW | Cap DPR at two to protect mid-range GPU performance. |
| 1 | REVIEW | Ease canvas activity after resize instead of abruptly resetting scenes. |
| 1 | REVIEW | Unify card hover timing while preserving zero-motion keyboard focus. |
| 1 | REVIEW | Add subtle parallax or mouse-tracking to gallery cards. |
| 1 | REVIEW | Smooth fade-in for canvas on page load (opacity transition). |
| 1 | REVIEW | Gentle pulsing glow on active HUD badge. |
| 1 | YES | Respect reduced-motion media query on all canvas animations. |
| 1 | REVIEW | Animate gallery card border color on hover from dim to mid green. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Uniform monospace kerning across all badges |
| 1 | REVIEW | DPR-aware canvas scaling on every effect |
| 1 | REVIEW | Precise 60fps RAF timing with timestamp |
| 1 | REVIEW | Vignette radial gradient uses exact green alpha |
| 1 | REVIEW | Scanline overlay only on data-stream page |
| 1 | REVIEW | Add customizable scanline density toggle inside HUD overlay control bar. |
| 1 | REVIEW | Implement radial green alpha glow around high-density particle collision points. |
| 1 | REVIEW | Display real-time rendering latency in milliseconds next to page counter. |
| 1 | REVIEW | Refine vignette gradient steps to ensure seamless blending on ultra-wide screens. |
| 1 | REVIEW | Add interactive cursor proximity glow effect to structural grid intersections. |
| 1 | REVIEW | Cap thumb SVG stroke widths for consistent optical density |
| 1 | REVIEW | Align all HUD baselines and insets to shared 20px |
| 1 | REVIEW | Add faint green scanline texture at 3% across all pages |
| 1 | REVIEW | Tighten card copy to single-line descriptions, equal length |
| 1 | REVIEW | Pin footer provenance with monospace build hash and timestamp |
| 1 | YES | Tune thumbnail compositions for legibility at the smallest breakpoint. |
| 1 | REVIEW | Harmonize green alpha hierarchy across borders, labels, and glows. |
| 1 | REVIEW | Give each effect a deliberate focal zone beneath unobtrusive HUDs. |
| 1 | REVIEW | Align provenance footer rhythm with gallery grid gutters. |
| 1 | REVIEW | Audit canvas line weights for consistent crispness across DPR values. |
| 1 | REVIEW | Add very low opacity noise texture to background for depth. |
| 1 | REVIEW | Consistent spacing and alignment in HUD elements. |
| 1 | REVIEW | Subtle green glow on vignette edge for cohesion. |
| 1 | REVIEW | Apply font-smoothing: antialiased for crisp text. |
| 1 | YES | Add subtle drop shadow to gallery card thumbnails. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | YES | Add reduced-motion to all canvases |
| 1 | REVIEW | DPR-aware scaling everywhere |
| 1 | REVIEW | Tighten HUD badge padding |
| 1 | YES | Pause canvas animation loops when prefers-reduced-motion media query triggers. |
| 1 | YES | Add high-contrast green focus rings for enhanced keyboard gallery navigation. |
| 1 | REVIEW | Throttle frame loops on tab blur to preserve mid-tier laptop battery. |
| 1 | REVIEW | Add prev/next effect navigation in bottom-right foot |
| 1 | REVIEW | Keyboard focus-visible ring on cards matching hover glow |
| 1 | REVIEW | Stagger card entrance fade-up on gallery load |
| 1 | YES | Extend reduced-motion handling consistently across all eleven canvases. |
| 1 | REVIEW | Add visible green focus rings matching hover emphasis to every interactive element. |
| 1 | REVIEW | Cap DPR at two to protect mid-range GPU performance. |
| 1 | REVIEW | Add keyboard focus indicators to all interactive elements. |
| 1 | REVIEW | Implement consistent scan line overlay across all effect pages. |
| 1 | REVIEW | Add smooth canvas fade-in on page load. |

## Font suggestions

- **x-ai/grok-4.20:** ui-monospace for terminal lab authenticity
  - `400/600 -0.06em tracking`
- **google/gemini-3.6-flash:** ui-monospace stack for zero-latency terminal aesthetic without webfont overhead.
  - `fontFamily: 'ui-monospace, SFMono-Regular, monospace', letterSpacing: '-0.06em', fontWeight: 800`
- **anthropic/claude-opus-5:** System ui-monospace stack — terminal authenticity, zero load cost
  - `H1 700/-0.06em; labels 500/0.08em uppercase 10-11px`
- **openai/gpt-5.6-sol:** System ui-monospace stack — native, fast, and terminal-authentic.
  - `H1 800 at -0.06em; labels 600 with 0.08em tracking.`
- **deepseek/deepseek-v4-flash:** system ui-monospace stack for terminal vibe
  - `400/700 weights, -0.06em heading, 0 body tracking`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Increase gallery card thumb contrast for scannability
2. [general · 1×] Add reduced-motion fallback on all canvas effects
3. [general · 1×] Ensure prefers-reduced-motion systematically pauses requestAnimationFrame loops across all pages.
4. [general · 1×] Improve inline SVG thumbnail contrast to better preview dense particle effects.
5. [general · 1×] Reserve thumbnail aspect ratios to prevent responsive grid reflow.
6. [general · 1×] Ensure HUD text contrast passes WCAG AA on blurred background.
7. [general · 1×] Make gallery card thumbnails clickable with full card area.
8. [transitions · 1×] Particle systems respect reduced-motion
9. [transitions · 1×] Extend prefers-reduced-motion to freeze all eleven canvases consistently
10. [transitions · 1×] Extend reduced-motion handling consistently across all eleven canvases.
11. [transitions · 1×] Respect reduced-motion media query on all canvas animations.
12. [professional · 1×] Tune thumbnail compositions for legibility at the smallest breakpoint.
13. [professional · 1×] Add subtle drop shadow to gallery card thumbnails.
14. [top3_must · 1×] Add reduced-motion to all canvases
15. [top3_must · 1×] Pause canvas animation loops when prefers-reduced-motion media query triggers.
16. [top3_must · 1×] Add high-contrast green focus rings for enhanced keyboard gallery navigation.
17. [top3_must · 1×] Extend reduced-motion handling consistently across all eleven canvases.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
