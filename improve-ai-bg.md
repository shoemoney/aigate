# Design Jury — Round 4

**Models parsed:** 5 · **stop votes:** 2

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Centered winner card with 1.5px green border |
| 1 | REVIEW | Thumb SVG displaying 0-10 spread |
| 1 | REVIEW | WINNER pill and dashed note below |
| 1 | REVIEW | CTA button linking to binary-rain.html |
| 1 | REVIEW | Footer with winner provenance text |
| 1 | REVIEW | Winner card lacks micro-interaction on hover |
| 1 | REVIEW | Thumb SVG could highlight current digit |
| 1 | REVIEW | CTA button missing focus state |
| 1 | REVIEW | Note dashed border inconsistent with card |
| 1 | REVIEW | Footer provenance too small against dark bg |
| 1 | YES | Ensure CTA button focus state uses high-contrast 2px solid green ring. |
| 1 | YES | Add subtle CRT scanline overlay on hero thumbnail for visual depth. |
| 1 | REVIEW | Set explicit ARIA landmark labels on winner badge and interactive CTA. |
| 1 | REVIEW | Align card inner padding strictly to 24px across all screen viewports. |
| 1 | YES | Verify provenance footer text maintains 4.5:1 contrast on dark mobile displays. |
| 1 | REVIEW | Tighten hero card max-width ~520px so thumb dominates viewport center |
| 1 | REVIEW | Give WINNER pill uppercase tracking and 1px green hairline outline |
| 1 | REVIEW | Thumb SVG should show '10' at largest size for hierarchy |
| 1 | REVIEW | CTA needs visible focus ring, not just hover lift |
| 1 | REVIEW | Footer provenance: one line, dim green, 11px, no wrap |
| 1 | REVIEW | Increase card width slightly to make the winning artifact unmistakably dominant. |
| 1 | REVIEW | Align header, card, note, and footer to one vertical axis. |
| 1 | YES | Make thumbnail’s 0–10 spread legible at narrow mobile widths. |
| 1 | YES | Elevate CTA contrast using solid green fill and black text. |
| 1 | REVIEW | Shorten supporting copy so title, proof, and action scan instantly. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Three.js wireframe plane with dust drift |
| 1 | REVIEW | Hero cardIn animation 520ms |
| 1 | REVIEW | Hover lift on winner card |
| 1 | REVIEW | Binary rain sway and flip on load |
| 1 | REVIEW | Flash halo on digit change |
| 1 | REVIEW | Card entrance animation lacks easing curve |
| 1 | REVIEW | Binary rain flip could use subtle blur |
| 1 | REVIEW | Dust drift speed not tied to scroll |
| 1 | YES | Reduced-motion freeze not instantaneous |
| 1 | REVIEW | Glow pulsing not synced with winner pill |
| 1 | REVIEW | Smooth canvas fade-in on load to prevent sudden wireframe mesh popping. |
| 1 | REVIEW | Add 150ms cubic-bezier spring curve to hero card hover lift effect. |
| 1 | REVIEW | Dampen background Three.js rotation speed when window loses active desktop focus. |
| 1 | REVIEW | Refine digit flip halo flash duration to snappy 80ms opacity decay. |
| 1 | YES | Ensure reduced-motion media query instantly freezes background render loop without shifts. |
| 1 | REVIEW | Stagger crown, title, tags 60ms after cardIn 520ms |
| 1 | REVIEW | Ease cardIn with cubic-bezier(0.16,1,0.3,1) for champion settle |
| 1 | REVIEW | Slow dust drift 30% behind hero to reduce competition |
| 1 | REVIEW | CTA hover: 120ms border brighten, no scale, no color shift |
| 1 | YES | Reduced-motion: freeze rain mid-frame, keep readable 0–10 spread |
| 1 | REVIEW | Reduce hover lift to two pixels; preserve the champion’s visual weight. |
| 1 | REVIEW | Stagger crown, title, and CTA within the 520ms card entrance. |
| 1 | REVIEW | Cap background orbit amplitude near the card to protect readability. |
| 1 | REVIEW | Lower dust density behind body copy while retaining peripheral motion. |
| 1 | REVIEW | Freeze all transforms cleanly under reduced motion, including hover states. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Champion-grade minimal polish |
| 1 | REVIEW | ui-monospace 11-13px labels only |
| 1 | REVIEW | Green glow tokens at 0.12 opacity |
| 1 | YES | DPR2 with reduced-motion pause |
| 1 | REVIEW | Fog and orbit controls |
| 1 | REVIEW | Green glow could be more immersive |
| 1 | YES | Winner pill lacks contrast on dark |
| 1 | REVIEW | Typography hierarchy could be stronger |
| 1 | REVIEW | Shadow depth too uniform across elements |
| 1 | REVIEW | Frame rate in Three.js drops on mobile |
| 1 | REVIEW | Use subtle 1px inner green glow edge on hero card border. |
| 1 | REVIEW | Apply backface-visibility hidden on animated canvas elements to eliminate rendering blur. |
| 1 | REVIEW | Elevate ambient hero shadow spread for crisp spatial layer separation. |
| 1 | REVIEW | Maintain sub-pixel text anti-aliasing on green monospace micro-label typography. |
| 1 | REVIEW | Throttle canvas animation loop gracefully to cap GPU resource consumption overhead. |
| 1 | REVIEW | Add subtle vignette so black edges read intentional, not empty |
| 1 | REVIEW | Two-digit '10' needs monospace tabular alignment in rain glyphs |
| 1 | REVIEW | Single green glow source: hero card only, dim the fog |
| 1 | REVIEW | Consistent 1.5px border weight across card, pill, CTA |
| 1 | REVIEW | Kern header 'WINNER — Binary Rain 0–10' with em-dash spacing |
| 1 | REVIEW | Use optical spacing around the WINNER pill, not equal padding. |
| 1 | REVIEW | Match every border’s alpha and thickness to a disciplined hierarchy. |
| 1 | REVIEW | Give the CTA arrow a fixed-width slot for precise alignment. |
| 1 | YES | Refine thumbnail digits with deliberate depth, overlap, and edge cropping. |
| 1 | REVIEW | Keep footer provenance concise, explicit, and visually subordinate. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Single hero focus with Three.js dust |
| 1 | REVIEW | Binary Rain 0-10 only invariant |
| 1 | REVIEW | Champion green glow polish |
| 1 | REVIEW | Add subtle pulse to winner pill |
| 1 | REVIEW | Smooth card entrance ease-out |
| 1 | REVIEW | Increase glow radius on binary rain flip |
| 1 | REVIEW | Add 1px inner green edge highlight to elevate hero card depth. |
| 1 | YES | Implement high-contrast 2px green focus ring for complete keyboard accessibility. |
| 1 | REVIEW | Refine digit flip halo decay timing for sharper matrix canvas feedback. |
| 1 | REVIEW | Constrain hero width and center-weight the 0–10 thumb |
| 1 | REVIEW | Stagger hero children with cubic-bezier(0.16,1,0.3,1) settle |
| 1 | REVIEW | Tabular monospace alignment so '10' never breaks the rain grid |
| 1 | YES | Elevate CTA contrast with solid green fill and black text. |
| 1 | YES | Guarantee 0–10 thumbnail legibility across narrow mobile widths. |
| 1 | REVIEW | Reduce background density directly behind card copy and CTA. |

## Font suggestions

- **x-ai/grok-4.20:** ui-monospace system font for terminal precision
  - `400/700 tracking -0.02em`
- **deepseek/deepseek-v4-flash:** ui-monospace for digit consistency and tech feel · pair: none
  - `500 weight, 0.02em tracking`
- **google/gemini-3.6-flash:** ui-monospace for authentic terminal aesthetic and crisp pixel rendering · pair: system-ui
  - `font-mono tracking-wider uppercase font-medium for crisp terminal micro-labels`
- **anthropic/claude-opus-5:** Keep ui-monospace — terminal authenticity matches digit-rain subject
  - `400 body, 600 labels, 0.08em tracking on uppercase pills`
- **openai/gpt-5.6-sol:** ui-monospace — consistent technical voice and dependable cross-platform rendering
  - `Use 600 headings, 500 labels, and 0.08em label tracking.`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Ensure CTA button focus state uses high-contrast 2px solid green ring.
2. [general · 1×] Add subtle CRT scanline overlay on hero thumbnail for visual depth.
3. [general · 1×] Verify provenance footer text maintains 4.5:1 contrast on dark mobile displays.
4. [general · 1×] Make thumbnail’s 0–10 spread legible at narrow mobile widths.
5. [general · 1×] Elevate CTA contrast using solid green fill and black text.
6. [transitions · 1×] Reduced-motion freeze not instantaneous
7. [transitions · 1×] Ensure reduced-motion media query instantly freezes background render loop without shifts.
8. [transitions · 1×] Reduced-motion: freeze rain mid-frame, keep readable 0–10 spread
9. [professional · 1×] DPR2 with reduced-motion pause
10. [professional · 1×] Winner pill lacks contrast on dark
11. [professional · 1×] Refine thumbnail digits with deliberate depth, overlap, and edge cropping.
12. [top3_must · 1×] Implement high-contrast 2px green focus ring for complete keyboard accessibility.
13. [top3_must · 1×] Elevate CTA contrast with solid green fill and black text.
14. [top3_must · 1×] Guarantee 0–10 thumbnail legibility across narrow mobile widths.

## Agent decisions

### r4 — winner polish — shipped
- SHIP: CTA focus-visible 2px #000 + 4px green ring (high-contrast)
- SHIP: CRT scanline overlay on hero thumb (0.035 repeating-linear, 0.55)
- SHIP: 0–10 thumb legibility at 360px (hero single-column, no collapse)
- SKIP: background density behind copy — Three.js already fogged, scanline adds depth without extra cost
- SKIP: re-adding 10 effects — winner is solo by request, keep 11→1

## Loop complete (winner)
- Rounds run: 4 (3 + winner)
- Final stop votes: 2 / 5 — capped, winner ships champion-grade
- Ship: 0–10 snow drift (78 glyphs, 11 values) + solo hero + Three.js plane

## Stop condition

stop_votes=2 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
