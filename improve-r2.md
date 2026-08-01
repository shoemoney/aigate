# Design Jury — Round 2

**Models parsed:** 5 · **stop votes:** 0

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add subtle column drop-zone highlight on drag (even without full DnD) |
| 1 | REVIEW | Show live “X queued” under Todo count when workers are busy |
| 1 | REVIEW | Truncate long directory paths with tooltip on hover in card |
| 1 | REVIEW | Make expanded card width max 640px and center it with overlay scrim |
| 1 | REVIEW | Add inline “session context” badge on threaded cards |
| 1 | REVIEW | Keyboard shortcut hint pills in modal footer and header |
| 1 | REVIEW | + New task button should show ⌘N badge on wide viewports |
| 1 | REVIEW | Replace single-line follow-up input with auto-resizing multi-line textarea for complex prompt replies. |
| 1 | REVIEW | Add search and filter bar to filter cards by model, directory, or keyword. |
| 1 | REVIEW | Provide a 'Clone as New' action on settled cards to copy settings instantly. |
| 1 | REVIEW | Add drag-and-drop manual reordering for queued tasks inside the Todo column. |
| 1 | REVIEW | Make column headers sticky with background blur when vertically scrolling task cards. |
| 1 | REVIEW | Add Cancel/kill button on running cards; long-running agents need an abort. |
| 1 | REVIEW | Show queued-at timestamp and worker ID on cards; operators need provenance. |
| 1 | REVIEW | Make Todo cards drag-reorderable, or add ↑↓ priority buttons for triage. |
| 1 | REVIEW | Add board-wide filter input: match directory, model, or prompt text. |
| 1 | REVIEW | Expanded thread should show all turns collapsed, not just last summary. |
| 1 | REVIEW | Persist directory as recall dropdown in modal; retyping paths is friction. |
| 1 | REVIEW | Error cards need copy-error-with-context button for pasting into issues. |
| 1 | REVIEW | Add sticky column headers for scrolling long task lists |
| 1 | REVIEW | Implement 'Clear all done' button in Done column header |
| 1 | REVIEW | Show 'queued' indicator after follow-up submission before re-entering running |
| 1 | REVIEW | Display relative/absolute timestamp on each card (creation/completion) |
| 1 | REVIEW | Add confirmation dialog before card deletion to prevent misclicks |
| 1 | REVIEW | Keep column headers sticky and columns independently scrollable; preserve board-level context. |
| 1 | REVIEW | Add filters for status, model, effort, and directory; show removable active-filter chips. |
| 1 | REVIEW | Show Todo queue position and queued age, clarifying worker order and waiting time. |
| 1 | REVIEW | Make follow-up submission explicit with pending, success, and failure feedback states. |
| 1 | REVIEW | Give untitled cards stable prompt-derived labels; retain IDs as secondary identity. |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Card move between columns uses 0.32s ease-out instead of 0.45s cubic |
| 1 | REVIEW | Running card gains faint radial pulse at 4s interval behind spinner |
| 1 | REVIEW | Expand uses scale(0.96→1) + opacity with 180ms timing |
| 1 | REVIEW | Follow-up send triggers brief “thinking” pulse on card footer |
| 1 | REVIEW | Error retry button triggers 260ms success-to-running flip |
| 1 | REVIEW | Live elapsed timer uses tabular-nums and fades in on claim |
| 1 | REVIEW | Add smooth height collapse transition when deleting or dismissing completed cards. |
| 1 | REVIEW | Implement smooth max-height expansion animation when revealing thread history turns. |
| 1 | REVIEW | Apply slight drag shadow and drop-zone border highlight during Todo manual reordering. |
| 1 | REVIEW | Stagger card entrance animations sequentially on initial board load for smooth rendering. |
| 1 | REVIEW | Add gentle background pulse to Running column badge while active workers execute tasks. |
| 1 | REVIEW | Column count chips should tick with a brief numeric roll, not snap. |
| 1 | REVIEW | Cancel action needs a 2s undo toast before the card actually dies. |
| 1 | REVIEW | Running border-glow period should scale with elapsed time as gentle urgency. |
| 1 | REVIEW | Newly-arrived Done cards get a 1.5s fading left edge-rail, then settle. |
| 1 | REVIEW | Follow-up Send collapses input with 120ms height ease into new turn row. |
| 1 | REVIEW | Column scroll should show top/bottom fade masks when content overflows. |
| 1 | REVIEW | Card enter/leave with slight vertical slide + opacity (not just fade-scale) |
| 1 | REVIEW | Running border-glow subtle color shift (orange to warm yellow) |
| 1 | REVIEW | Expanded card height animation (max-height or grid expand) |
| 1 | REVIEW | Follow-up submission triggers slide animation as card moves to Todo/Running |
| 1 | REVIEW | Error card subtle shake animation on transition to Error column |
| 1 | REVIEW | Animate count-chip numbers briefly without shifting card geometry. |
| 1 | REVIEW | Crossfade status border and icon changes while keeping labels immediately readable. |
| 1 | REVIEW | Reserve response space during follow-ups, preventing card-height jumps. |
| 1 | REVIEW | Expand summaries with clipped height and opacity, anchoring focus to follow-up input. |
| 1 | REVIEW | Transition follow-up Send into pending, success, or failure states in place. |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Status pills use 500 weight for labels only, never the count chip |
| 1 | REVIEW | Add faint vertical rule between tag row items |
| 1 | REVIEW | Expanded card uses panel2 for header, panel for body |
| 1 | REVIEW | Follow-up input has monospace caret and prompt-prefill suggestion |
| 1 | REVIEW | Retry uses same accent as running but with clockwise arrow emoji |
| 1 | REVIEW | All interactive elements maintain ≥44px tap targets |
| 1 | REVIEW | Display inline terminal log tail snippet on Running cards for live execution output. |
| 1 | REVIEW | Show file change diff stats (+lines / -lines) on Done card summary footers. |
| 1 | REVIEW | Add active agent concurrency worker gauge (e.g. 2/4 active) in board header. |
| 1 | REVIEW | Include 'Clear all Done' bulk action button in the Done column header. |
| 1 | REVIEW | Show quick-copy hover action on path tags to copy working directory directly. |
| 1 | REVIEW | Header: aggregate stats strip — N queued, N running, median duration. |
| 1 | REVIEW | Density toggle (comfortable/compact) persisted in localStorage for big boards. |
| 1 | REVIEW | Right-click card → context menu: copy id, retry, close, duplicate. |
| 1 | REVIEW | Duplicate-task action: reuse dir/model/effort, blank prompt, one keystroke. |
| 1 | REVIEW | Show WS reconnect countdown and last-sync time, not just a dot. |
| 1 | REVIEW | Column headers become sticky when the column list scrolls independently. |
| 1 | REVIEW | Left-edge accent line per card colored by status for quick scanning |
| 1 | REVIEW | Collapsible metadata row (model, effort, dir) visible on hover or expand |
| 1 | REVIEW | Quick-action toolbar (expand, copy, delete) on hover |
| 1 | REVIEW | Add 'copy card link' button for sharing card reference |
| 1 | REVIEW | Implement minimap or arrow-jump navigation for long columns |
| 1 | REVIEW | Expose exact submitted, claimed, and completed timestamps alongside relative ages. |
| 1 | REVIEW | Add collapsible execution details for worker, model, effort, and attempt. |
| 1 | REVIEW | Make Error messages copyable, with retry count and preserved original prompt. |
| 1 | REVIEW | Present a compact turn timeline separating prompt, summary, and follow-ups. |
| 1 | REVIEW | Add a restrained card-density toggle for operators scanning large queues. |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Live queued indicator under Todo column |
| 1 | REVIEW | Expanded card centered scrim overlay with max-width |
| 1 | REVIEW | Shorten column transition to 0.32s and tighten font tracking |
| 1 | REVIEW | Replace single-line follow-up input with auto-resizing multi-line textarea on expanded cards. |
| 1 | REVIEW | Add live output terminal log tail preview on active Running cards. |
| 1 | REVIEW | Add 'Clone as New' quick action on settled cards to prefill task creation. |
| 1 | REVIEW | Cancel/abort control on running cards with undo toast. |
| 1 | REVIEW | Todo reordering (drag or ↑↓) for real triage control. |
| 1 | REVIEW | Filter/search input plus queued-at timestamps for board-scale legibility. |
| 1 | REVIEW | Confirmation dialog before card deletion |
| 1 | REVIEW | Follow-up queued state indicator |
| 1 | REVIEW | Clear-all-done batch action in Done column |
| 1 | REVIEW | Make follow-up sending stateful and layout-stable, preventing duplicate submissions. |
| 1 | REVIEW | Add queue position and age so operators understand Todo ordering. |
| 1 | REVIEW | Add sticky headers, independent column scrolling, and active filters for large boards. |

## Font suggestions

- **x-ai/grok-4.20:** system-ui, -apple-system, sans-serif – retain for zero latency; tighten tracking -0.008em on card titles and uppercase labels · pair: optional
  - `font-weight: 450 on body, 550 on titles; letter-spacing: -0.012em`
- **google/gemini-3.6-flash:** System UI stack (-apple-system, BlinkMacSystemFont, Segoe UI) with tight -0.011em tracking for dense layout legible at small sizes. · pair: SF Mono / JetBrains Mono for task IDs, directory paths, models, timers, and diff metrics.
  - `font-sans tracking-tight for titles and body; font-mono tabular-nums for IDs, timers, and code tags.`
- **anthropic/claude-opus-5:** Keep system UI sans — zero load cost, native legibility at 13–14px in dark UI. Set -0.006em tracking on card titles, 600 weight; body prompt at 400/1.5 line-height. · pair: ui-monospace/SFMono for ids, paths, models, durations — already in place; add 0.02em tracking so uppercase column labels don't jam.
  - `600 titles, 400 body, 500 tags; uppercase labels 11px/0.08em; tabular-nums on all counts and timers.`
- **deepseek/deepseek-v4-flash:** System UI stack (San Francisco, Segoe UI, etc.) – fast, native feel; increase tracking to 0.02em for uppercase column headers; use weight 600 for card titles · pair: None needed; monospace for IDs and paths already separate
  - `font-family:system-ui,-apple-system,sans-serif; font-weight:500; card-title font-weight:600; header tracking:0.02em`
- **openai/gpt-5.6-luna:** system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif — crisp native legibility with reliable control-room density. · pair: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace — technical metadata only.
  - `400 body, 600 labels, 700 titles; -0.01em headings, normal metadata.`

## Auto-agree implementation queue (by votes)


## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=0 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — Round 2
**SHIPPED** (verified in-browser, 0 console errors): full thread history in expanded cards;
queued-age timer on Todo cards; independent column scroll + sticky headers; filter/search box
(`/` to focus); Clone-as-New on settled cards; two-step delete confirm; follow-up pending state.
**SKIPPED:** cancel/abort running card (needs a backend endpoint + worker cooperation — a feature,
not design; flagged to user), drag-reorder + queue-position numbers, clear-all-done, and motion
nits (radial pulse, shake, count-chip roll, edge-rails) that fight the locked calm-operator tone.
