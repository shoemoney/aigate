# Design Jury — Round 1

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Card prompt truncation hides critical context for operators |
| 1 | REVIEW | No visible immutable lock indicator on in-flight cards |
| 1 | REVIEW | Effort tags use inconsistent visual weight vs model tags |
| 1 | REVIEW | Expanded follow-up input lacks clear session threading label |
| 1 | REVIEW | Error cards bury retry action below summary |
| 1 | REVIEW | Add created time, queue position, and worker claim state to Todo cards. |
| 1 | REVIEW | Make expanded settled cards keyboard-focusable, with clear open state and Escape-to-collapse. |
| 1 | REVIEW | Preserve scroll position and focus when cards transition between columns. |
| 1 | REVIEW | Reveal full prompts through accessible disclosure, not hover-only truncation; retain a locked indicator. |
| 1 | REVIEW | Add purposeful empty states with next-action guidance in every column. |
| 1 | REVIEW | Add an explicit prompt copy button on cards to easily reuse prompt text. |
| 1 | REVIEW | Display execution runtime duration timer on running and settled card headers. |
| 1 | REVIEW | Provide inline keyboard shortcuts like Cmd+Enter to submit new tasks and follow-ups. |
| 1 | REVIEW | Add a compact filter bar for model, effort, and search query above columns. |
| 1 | REVIEW | Include a clear visually distinct error log toggle inside expanded error cards. |
| 1 | REVIEW | Add per-card elapsed/queued timer; operators judge by wall-clock, not status color alone. |
| 1 | REVIEW | Running column should pin newest-claimed at top with worker ID label. |
| 1 | REVIEW | Replace 3-line fade mask with 2-line clamp plus hover tooltip full prompt. |
| 1 | REVIEW | Make settled cards' clickability explicit: subtle chevron or 'expand' affordance, not mystery. |
| 1 | REVIEW | Add keyboard queue: 'n' opens modal, j/k moves focus, Enter expands card. |
| 1 | REVIEW | Add keyboard shortcuts: n for new task, Esc to close expanded card, r to retry error. |
| 1 | REVIEW | Show elapsed time or progress bar for running tasks (agent may take minutes). |
| 1 | REVIEW | Allow reordering Todo cards via drag or up/down buttons for priority. |
| 1 | REVIEW | Add a search/filter bar to find cards by ID, title, or directory. |
| 1 | REVIEW | Display truncated prompt with a 'show more' tooltip or inline expand toggle. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Shimmer sweep on running cards feels consumer-app decorative |
| 1 | REVIEW | 0.45s column move animation delays operator feedback |
| 1 | REVIEW | Modal scrim blur creates unnecessary GPU load on self-hosted |
| 1 | REVIEW | Card enter scale lacks easing curve for control-room pace |
| 1 | REVIEW | Live status dot pulse competes with running card spinner |
| 1 | YES | Respect prefers-reduced-motion by disabling shimmer, flips, pulse, and scale effects. |
| 1 | REVIEW | Replace 0.45-second flips with restrained 180–240ms positional movement for faster queue scanning. |
| 1 | REVIEW | Animate status border and color changes without obscuring card content. |
| 1 | REVIEW | Confine shimmer to a running-status strip instead of sweeping across readable text. |
| 1 | REVIEW | Announce claim, completion, error, and follow-up results through an aria-live region. |
| 1 | REVIEW | Replace harsh diagonal shimmer with subtle pulsing border glow on running cards. |
| 1 | REVIEW | Scale down cards slightly on drag or state transition for visual feedback. |
| 1 | REVIEW | Animate follow-up thread expansion smoothly using CSS max-height transitions. |
| 1 | YES | Respect prefers-reduced-motion media query by disabling shimmer animations and card flips. |
| 1 | REVIEW | Add smooth cross-fade opacity when updating turn counts and status chips. |
| 1 | REVIEW | Cap FLIP at 0.28s ease-out; 0.45s cubic feels sluggish across four columns. |
| 1 | REVIEW | Shimmer sweep: reduce to 12% opacity, 2.4s cycle; current sweep competes with text. |
| 1 | REVIEW | Done arrival: single 180ms green border flash, then settle — no sustained glow. |
| 1 | REVIEW | Error arrival: 2px border pulse twice, never shake; failures need calm, not alarm. |
| 1 | YES | Honor prefers-reduced-motion: kill shimmer/FLIP, keep opacity crossfade and static spinner. |
| 1 | REVIEW | Smooth column width adjustment on card add/remove to avoid layout jump. |
| 1 | REVIEW | Card expand/collapse with max-height animation (0.3s ease). |
| 1 | REVIEW | Modal backdrop blur fade-in, fade-out (0.2s). |
| 1 | REVIEW | Running shimmer: subtle pulse border instead of diagonal sweep for reduced distraction. |
| 1 | YES | Respect prefers-reduced-motion: disable flip animations and shimmer. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add subtle #223044 column dividers for visual hierarchy |
| 1 | REVIEW | Use mono font for prompt snippets to improve scanability |
| 1 | REVIEW | Surface directory path with faint#5f728c truncation |
| 1 | REVIEW | Make count chips use accent color only on active columns |
| 1 | YES | Implement reduced-motion media query disabling all animations |
| 1 | REVIEW | Add a stable status label inside each card: queued, running, completed, or failed. |
| 1 | REVIEW | Use monospace only for IDs, directories, and technical output—not general card text. |
| 1 | REVIEW | Replace inconsistent emoji with compact labels or consistently styled glyphs for scanability. |
| 1 | REVIEW | Make errors actionable by preserving detail and offering Retry and copy controls. |
| 1 | REVIEW | Present model and effort as compact labeled pills with tooltips for unfamiliar values. |
| 1 | REVIEW | Style directory paths with monospace font and subtle background tag pill styling. |
| 1 | REVIEW | Add clear visual indicator badges for model types and effort level meters. |
| 1 | REVIEW | Display precise timestamp tooltips when hovering over created and finished cards. |
| 1 | YES | Use high-contrast status pips with distinct geometric shapes for colorblind accessibility. |
| 1 | REVIEW | Implement clear drop-zone visual highlight indicators when reordering todo queue cards. |
| 1 | REVIEW | Column headers sticky on scroll with count chip; long Done lists lose context. |
| 1 | REVIEW | Monospace the directory path and #id — operators pattern-match paths, not prose. |
| 1 | REVIEW | Tag row: use tinted pill for effort:max only; low/medium stay dim text. |
| 1 | REVIEW | Add copy-prompt and copy-summary icon buttons on expanded cards. |
| 1 | REVIEW | Empty columns get one-line hint text at 60% dim, not blank panels. |
| 1 | REVIEW | Use monospace font for card IDs and directory paths for clarity. |
| 1 | REVIEW | Add 'copy prompt' button on expanded card for reference. |
| 1 | REVIEW | Show relative timestamp for when card entered each column. |
| 1 | REVIEW | Error cards: collapsible stack trace or full error message. |
| 1 | REVIEW | Bulk action mode: select multiple Todo cards to delete or prioritize. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add immutable lock badge on cards post-submit |
| 1 | REVIEW | Replace decorative shimmer with slim progress bar |
| 1 | REVIEW | Add visible thread count + context pill on expanded cards |
| 1 | REVIEW | Expose locked status, timestamps, and queue position directly on cards. |
| 1 | REVIEW | Make expansion, follow-up, Retry, and Close fully keyboard-accessible. |
| 1 | REVIEW | Reduce motion and announce asynchronous state changes without stealing focus. |
| 1 | REVIEW | Add execution runtime timers to running and completed cards for context. |
| 1 | REVIEW | Enable Cmd+Enter keyboard shortcut for rapid task submission and follow-up prompts. |
| 1 | REVIEW | Style directory paths and model tags with monospace fonts for high legibility. |
| 1 | REVIEW | Per-card elapsed timer plus worker ID on running cards. |
| 1 | REVIEW | Faster FLIP (0.28s) and toned-down shimmer for legibility. |
| 1 | REVIEW | Explicit expand affordance and monospace paths/ids for scannability. |
| 1 | REVIEW | Keyboard shortcuts for new task, expand, retry, close. |
| 1 | REVIEW | Progress indicator for running tasks (spinner + elapsed time). |
| 1 | REVIEW | Search/filter bar to quickly locate cards in large boards. |

## Font suggestions

- **x-ai/grok-4.20:** system-ui, -apple-system, sans-serif – highest legibility for dense operator UIs · pair: optional
  - `font-weight:500;letter-spacing:-0.015em`
- **openai/gpt-5.6-luna:** System UI sans stack; use strong text rendering, 600 headings, and 14–16px operational copy. · pair: Monospace system stack for IDs, directories, prompts, and agent output.
  - `Use 500–600 weights for labels; keep tracking near normal, with +0.06em uppercase metadata.`
- **google/gemini-3.6-flash:** System UI sans (-apple-system, BlinkMacSystemFont, Segoe UI, Roboto) for fast loading · pair: Monospace (ui-monospace, SFMono-Regular, Menlo, Consolas) for directory paths and model tags
  - `Letter-spacing -0.01em on headings, font-variant-numeric: tabular-nums for counters and timers`
- **anthropic/claude-opus-5:** Keep system UI sans — zero load cost, native crispness at 13-14px on dark bg; set -0.01em tracking on body, +0.06em on uppercase column labels. · pair: ui-monospace/SFMono-Regular for paths, ids, model names, and error stack lines.
  - `600 titles, 450-500 body, 700 uppercase labels at 11px/+0.08em; never below 12px for prompts.`
- **deepseek/deepseek-v4-flash:** System UI stack (SF Pro/Inter/Segoe UI) – use weight 500 for headings, 400 for body; letter-spacing 0.01em for body. · pair: Monospace (SF Mono/Cascadia Code) for IDs and paths.
  - `headings: 500 weight, 0 tracking; body: 400 weight, 0.01em tracking; monospace: 400 weight, 0 tracking.`

## Auto-agree implementation queue (by votes)

1. [transitions · 1×] Respect prefers-reduced-motion by disabling shimmer, flips, pulse, and scale effects.
2. [transitions · 1×] Respect prefers-reduced-motion media query by disabling shimmer animations and card flips.
3. [transitions · 1×] Honor prefers-reduced-motion: kill shimmer/FLIP, keep opacity crossfade and static spinner.
4. [transitions · 1×] Respect prefers-reduced-motion: disable flip animations and shimmer.
5. [professional · 1×] Implement reduced-motion media query disabling all animations
6. [professional · 1×] Use high-contrast status pips with distinct geometric shapes for colorblind accessibility.

## Agent decisions — Round 1

**SHIPPED** (verified in-browser, 0 console errors):
- `prefers-reduced-motion` block (5/5) — kills shimmer/flip/pulse/spin, keeps static legibility
- Monospace `#id` / directory / model tags + tabular-nums (5/5)
- Live elapsed timer on running cards, total duration on settled (4/5) — 1s ticker
- Shimmer sweep → confined pulsing border-glow; FLIP 0.45s→0.26s (4/5)
- Keyboard: `n` new, `Esc` close/collapse, `Cmd/Ctrl+Enter` submit; cards focusable + Enter/Space (4/5)
- Rotating chevron expand affordance (3/5)
- Full prompt revealed on expand (mask removed when open) (3/5)
- Copy-prompt / copy-summary buttons (3/5)
- Colorblind-safe status pills w/ distinct shapes (▸ △ ● □) not color-alone (2/5)
- aria-live announcements of state changes (2/5)
- Effort tag: only high/max tinted, low/medium dim (2/5)
- Purposeful empty-state hints per column

**SKIPPED (this round):**
- Search/filter bar — board is small; YAGNI until many cards
- Drag-reorder + explicit queue-position numbers — heavier; defer
- Bulk multi-select — no demand yet
- Sticky column headers — minor; revisit if Done lists grow long

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.
