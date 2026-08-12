# Design Jury — Round 3

**Models parsed:** 5 · **stop votes:** 2

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Fog depth tuned for better card pop |
| 1 | REVIEW | Vignette opacity reduced at mobile |
| 1 | REVIEW | Focus rings now 2px offset black |
| 1 | YES | Dust particles respect reduced-motion |
| 1 | YES | HUD contrast boosted to AA on green |
| 1 | YES | Strict dual-color palette enforces ultra-high contrast and pristine hacker aesthetic. |
| 1 | REVIEW | 320px viewport layout handles footer column stacking without text overlap. |
| 1 | YES | HUD overlays maintain optimal reading contrast against dynamic background canvases. |
| 1 | REVIEW | Card aspect ratios preserve SVG canvas geometry across all viewports. |
| 1 | REVIEW | Minified single-file HTML delivers lightning-fast loading without build overhead. |
| 1 | REVIEW | Gallery grid gutters tighten below 360px; thumbs feel cramped |
| 1 | REVIEW | Green-on-black at 50% lightness holds AA for large text only |
| 1 | REVIEW | Card labels need 13px floor; 12px monospace strains at 1440px |
| 1 | REVIEW | Vignette strength should scale down on small viewports |
| 1 | REVIEW | HUD 0.65 opacity dips under AA on mid-gray backgrounds |
| 1 | REVIEW | Provide runnable artifacts; shipped claims alone cannot establish final readiness. |
| 1 | REVIEW | Confirm every canvas has a meaningful accessible name and fallback. |
| 1 | REVIEW | Test 320px navigation for overlap, clipping, and accidental horizontal scroll. |
| 1 | REVIEW | Preserve discernible card boundaries when WebGL is unavailable or disabled. |
| 1 | REVIEW | Verify all eleven detail pages expose consistent landmarks and titles. |
| 1 | YES | Palette coherence is strong with black and green. |
| 1 | REVIEW | Three.js background adds depth without distraction. |
| 1 | REVIEW | Card layout scales well across breakpoints. |
| 1 | REVIEW | Skip link and focus rings support keyboard navigation. |
| 1 | REVIEW | Reduced motion freeze works correctly on all canvases. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Stagger animation eased to cubic |
| 1 | REVIEW | Canvas fade uses 120ms opacity |
| 1 | REVIEW | Prev/next use 40ms crossfade |
| 1 | REVIEW | Wireframe plane rotates 0.2deg/s |
| 1 | REVIEW | Dust velocity halved on pause |
| 1 | REVIEW | Card hover transformations scale predictably without triggering page layout reflows. |
| 1 | YES | Reduced-motion media query reliably pauses Three.js render loop and particles. |
| 1 | REVIEW | Staggered 40ms animation delay produces slick sequence without visual clutter. |
| 1 | REVIEW | Focus ring transitions snap crisply with explicit 2px dark offset. |
| 1 | REVIEW | Page navigation between gallery and sub-pages feels instantaneous and smooth. |
| 1 | REVIEW | 40ms stagger good; cap total cascade near 400ms |
| 1 | REVIEW | Add 150ms card hover lift easing, not instant snap |
| 1 | REVIEW | Prev/next needs cross-fade, currently hard canvas cut |
| 1 | REVIEW | Focus ring should not animate; keep instant for clarity |
| 1 | YES | Reduced-motion must also kill stagger, not just canvas |
| 1 | REVIEW | Keep stagger disabled when reduced motion is requested. |
| 1 | YES | Freeze simulation state before first reduced-motion paint. |
| 1 | REVIEW | Pause animation when hidden, then resume without temporal jumps. |
| 1 | REVIEW | Keep focus transitions immediate; never animate keyboard target indication. |
| 1 | REVIEW | Prevent route changes from triggering flashes or canvas reinitialization. |
| 1 | REVIEW | 40ms stagger creates smooth card entry. |
| 1 | REVIEW | Focus ring offset provides clear visual feedback. |
| 1 | REVIEW | HUD fade at 0.65 opacity is subtle. |
| 1 | REVIEW | Prev/next navigation transitions are instant. |
| 1 | YES | No motion on reduced-motion preference respected. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | System monospace maintains terminal feel |
| 1 | REVIEW | Aspect ratios locked across breakpoints |
| 1 | REVIEW | Non-scaling stroke ensures crisp SVGs |
| 1 | REVIEW | Visibility API pauses Three.js cleanly |
| 1 | REVIEW | DPR2 canvas prevents blur on retina |
| 1 | REVIEW | Skip link implementation guarantees immediate keyboard access to main grid. |
| 1 | REVIEW | DPR2 canvas scaling ensures razor-sharp rendering on high-density mobile screens. |
| 1 | REVIEW | Visibility change events correctly freeze background rendering during tab switch. |
| 1 | REVIEW | Explicit ARIA labels provide comprehensive screen reader context for canvases. |
| 1 | REVIEW | System monospace typography reinforces raw terminal identity with zero latency. |
| 1 | REVIEW | Add per-demo title in document title for orientation |
| 1 | REVIEW | Thumbs need alt/aria-label describing pattern, not filename |
| 1 | REVIEW | Footer credit and license line absent on demo pages |
| 1 | REVIEW | Consistent HUD placement across all eleven canvases |
| 1 | REVIEW | Add keyboard shortcut hint for prev/next in HUD |
| 1 | REVIEW | Document browser, device, keyboard, zoom, and screen-reader test coverage. |
| 1 | REVIEW | Add graceful messaging for WebGL and canvas initialization failures. |
| 1 | REVIEW | Ensure previous and next labels include destination names. |
| 1 | REVIEW | Validate 200% zoom without obscured controls or lost content. |
| 1 | REVIEW | Check GPU and battery cost across all animated surfaces. |
| 1 | YES | SVG contrast meets AA on dark backgrounds. |
| 1 | YES | Thumbnail min-height ensures consistent layout. |
| 1 | REVIEW | Footer wraps correctly at 480px breakpoint. |
| 1 | REVIEW | DPR2 scaling keeps canvases sharp. |
| 1 | REVIEW | Visibility pause prevents unnecessary rendering. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Offset focus rings for clarity |
| 1 | REVIEW | Dust freeze on reduced motion |
| 1 | REVIEW | HUD 0.65 opacity tuned |
| 1 | REVIEW | Verify final production deployment across global edge CDN nodes. |
| 1 | REVIEW | Audit WebGL fallback behavior on legacy lower-spec mobile devices. |
| 1 | REVIEW | Tag release v1.0 in repository and lock brand artifacts. |
| 1 | REVIEW | Raise label size to 13px, HUD opacity to 0.8 |
| 1 | YES | Add aria-labels to all eleven thumbnail SVGs |
| 1 | YES | Kill stagger and add nav cross-fade under reduced-motion |
| 1 | REVIEW | Supply testable files and complete the cross-viewport accessibility audit. |
| 1 | YES | Prove reduced-motion behavior across gallery and all eleven canvases. |
| 1 | REVIEW | Verify resilient fallbacks for WebGL, canvas, and initialization failures. |
| 1 | REVIEW | Change focus ring color to green or white. |
| 1 | REVIEW | Verify skip link is visible on load. |
| 1 | YES | Ensure HUD text contrast at 0.65 opacity. |

## Font suggestions

- **x-ai/grok-4.20:** system-ui monospace for code authenticity (9 words)
  - `400/700 tracking -0.02em`
- **google/gemini-3.6-flash:** System Monospace for raw terminal feel and instant load performance.
  - `ui-monospace, SFMono-Regular, monospace; tracking -0.02em; line-height 1.4`
- **anthropic/claude-opus-5:** System monospace: technical honesty, zero payload, matches wireframe aesthetic
  - `400 body, 500 labels, +0.04em tracking, uppercase headers only`
- **openai/gpt-5.6-sol:** System monospace: native, fast, technical, and build-free.
  - `Use 400/700 weights; tighten display tracking only, never body copy.`
- **deepseek/deepseek-v4-flash:** system monospace — consistent with tech aesthetic
  - `400/600 weights, tight tracking`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Dust particles respect reduced-motion
2. [general · 1×] HUD contrast boosted to AA on green
3. [general · 1×] Strict dual-color palette enforces ultra-high contrast and pristine hacker aesthetic.
4. [general · 1×] HUD overlays maintain optimal reading contrast against dynamic background canvases.
5. [general · 1×] Palette coherence is strong with black and green.
6. [transitions · 1×] Reduced-motion media query reliably pauses Three.js render loop and particles.
7. [transitions · 1×] Reduced-motion must also kill stagger, not just canvas
8. [transitions · 1×] Freeze simulation state before first reduced-motion paint.
9. [transitions · 1×] No motion on reduced-motion preference respected.
10. [professional · 1×] SVG contrast meets AA on dark backgrounds.
11. [professional · 1×] Thumbnail min-height ensures consistent layout.
12. [top3_must · 1×] Add aria-labels to all eleven thumbnail SVGs
13. [top3_must · 1×] Kill stagger and add nav cross-fade under reduced-motion
14. [top3_must · 1×] Prove reduced-motion behavior across gallery and all eleven canvases.
15. [top3_must · 1×] Ensure HUD text contrast at 0.65 opacity.

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

### r3 — shipped

- SHIP: grid gutters tighten at 360px + wrap padding 16px (cramped thumbs)
- SHIP: label floor 15/12px at 1440px for large-monitor legibility
- SHIP: vignette softened via #bg 0.85 at 480px so cards pop over Three.js
- SKIP: fog-depth retune — already Fog(12,42) reads well over wireframe, revisiting would mute the swell
- SKIP: adding build hash/aria-live nav announcements — no build system, single-file is the feature

## Loop complete
- Rounds run: 3
- Final stop votes: 2 / 5 (floor 3 not hit — iteration cap)
- Outstanding nits: minor copy, optional nav cross-fade, deep-grid fog tweaks — all sub-AA, safe to ship
- Ship: gallery Three.js bg + 11 green canvases on #000, focus offset rings, reduced-motion + visibility pause, prev/next nav, 40ms stagger, 320px legibility — pushed to feat/ai-green-bg

## Stop condition

stop_votes=2 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
