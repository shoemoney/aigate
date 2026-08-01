# Design Jury — Round 3

**Models parsed:** 5 · **stop votes:** 1

## Deduped findings

### general

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add subtle column dividers using line token for visual separation |
| 1 | REVIEW | Make card #id faint instead of full ink to reduce visual noise |
| 1 | REVIEW | Truncate long directory paths with ellipsis in collapsed view |
| 1 | REVIEW | Show effort as colored dot + label only on expanded cards |
| 1 | REVIEW | Add faint last-updated timestamp on settled cards below summary |
| 1 | REVIEW | Validate directory and prompt inline; explain required fields before submission. |
| 1 | REVIEW | Support multiline follow-ups with Cmd/Ctrl+Enter and an explicit keyboard hint. |
| 1 | REVIEW | Show absolute created, started, completed, and last-updated times alongside relative timers. |
| 1 | REVIEW | Display full directory paths via expandable metadata or copy affordance, not dirname alone. |
| 1 | REVIEW | Label retry attempts clearly and preserve the failed result while the new attempt runs. |
| 1 | REVIEW | Highlight matching search terms directly within card titles, directories, and prompts. |
| 1 | REVIEW | Truncate long directory paths smart-middle e.g. ~/src/.../aigate to preserve leaf folder. |
| 1 | REVIEW | Add visual thread timeline connector lines separating user turns from model summaries. |
| 1 | REVIEW | Display total filter match count badge in search bar when filtering is active. |
| 1 | REVIEW | Provide quick dropdown of recently used working directories inside new task modal. |
| 1 | REVIEW | Consider reducing card padding by 4px to fit more cards on screen |
| 1 | REVIEW | Replace prompt fade mask with simpler ellipsis for faster rendering |
| 1 | REVIEW | Add max-height constraint to columns to prevent excessive scrolling |
| 1 | REVIEW | Show effort tag as a small chip with icon for quicker scanning |
| 1 | REVIEW | Use a solid backdrop for modal instead of blur for performance |
| 1 | REVIEW | Prompt textarea: auto-grow to ~14 rows, draft persisted in localStorage if modal closed |
| 1 | YES | Directory field: datalist of recent dirs, remember last model/effort as defaults |
| 1 | REVIEW | Follow-up input becomes auto-grow textarea; Cmd+Enter sends, matching modal submit |
| 1 | REVIEW | Error cards: full message in mono scroll box, copy-error button, elapsed-before-failure |
| 1 | REVIEW | Todo cards show queue position ("3rd in queue"); header shows workers busy/idle |

### transitions

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Reduce column move transition to 0.32s for snappier feel |
| 1 | REVIEW | Add microfade on prompt reveal instead of instant mask removal |
| 1 | REVIEW | Use 180deg chevron rotate with 0.2s ease-out timing |
| 1 | REVIEW | Confine running spinner to top-right 20px badge with fade exit |
| 1 | REVIEW | Add 80ms scale-down on card collapse before column move |
| 1 | REVIEW | Animate expansion with measured height and opacity while preserving scroll position and focus. |
| 1 | REVIEW | Crossfade column empty hints when cards enter or leave, avoiding layout jumps. |
| 1 | REVIEW | Use a brief status-transition tint and shape change when cards change columns. |
| 1 | REVIEW | Reveal newly arrived summaries and errors without replaying the entire card. |
| 1 | REVIEW | Keep modal scrim and panel transitions below 180ms for fast operator control. |
| 1 | REVIEW | Animate expanded card accordion container using smooth max-height transition on click. |
| 1 | REVIEW | Apply subtle scale-down and opacity transition when cards are hidden by search. |
| 1 | REVIEW | Animate follow-up prompt input collapse upon successful submission into thread history. |
| 1 | REVIEW | Add quick success checkmark fade on copy buttons after clipboard action triggers. |
| 1 | REVIEW | Smoothly transition sticky header drop-shadow when column scroll position leaves top. |
| 1 | REVIEW | Speed up card enter from 0.45s to 0.3s for snappier feel |
| 1 | REVIEW | Reduce running card pulse opacity to 0.3 to minimize distraction |
| 1 | REVIEW | Add subtle slide transition for expand/collapse content |
| 1 | REVIEW | Remove scale on modal open; use simple fade |
| 1 | REVIEW | Add slight shadow on sticky column headers when scrolled |
| 1 | REVIEW | Expand/collapse animates height 180ms ease-out with content fade, not instant snap |
| 1 | REVIEW | Filtered-out cards fade+collapse 120ms instead of popping; cap stagger at 6 cards |
| 1 | REVIEW | On column move, card border crossfades old→new status color over 200ms |
| 1 | YES | Newly claimed card scrolls into view smoothly; instant jump under reduced-motion |
| 1 | REVIEW | 1s elapsed tick must not re-trigger glow or reflow card layout |

### professional

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Replace emoji tags with 12px Unicode symbols for tighter alignment |
| 1 | REVIEW | Use panel2 for expanded card background to create clear hierarchy |
| 1 | YES | Add 1px inset shadow on modal glass panel for depth |
| 1 | YES | Make status pips 6px with 2px stroke for better contrast |
| 1 | REVIEW | Implement focus ring using accent color at 2px offset |
| 1 | REVIEW | Trap focus inside the modal and restore focus to New task after closing. |
| 1 | REVIEW | Add strong, consistent focus-visible outlines to cards, fields, buttons, and follow-up controls. |
| 1 | REVIEW | Show transient confirmation after every copy action, identifying exactly what was copied. |
| 1 | REVIEW | Add a compact stale-connection banner explaining queue reliability and delayed worker updates. |
| 1 | REVIEW | Make Close visibly destructive and keep Retry visually secondary to result inspection. |
| 1 | REVIEW | Show explicit keycap badges e.g. / N Esc in header for keyboard shortcut discovery. |
| 1 | REVIEW | Add attempt count badge e.g. Attempt #2 on retried error cards. |
| 1 | REVIEW | Style turn prompts and model summaries with distinct user versus assistant background tints. |
| 1 | REVIEW | Add clear search button inside filter bar when text is present. |
| 1 | REVIEW | Display keyboard shortcut hint overlay when pressing shift question-mark anywhere on board. |
| 1 | REVIEW | Show keyboard shortcut hint on new task button e.g. '(N)' |
| 1 | REVIEW | Add subtle grid lines between cards or on column background |
| 1 | REVIEW | Use consistent icon set for folder/model/effort (small SVG or single emoji set) |
| 1 | REVIEW | Add 'scroll to top' button in columns with many cards |
| 1 | REVIEW | Increase hover shadow depth instead of border lift for better depth perception |
| 1 | REVIEW | Per-card permalink (?task=12) that opens board with that card expanded |
| 1 | REVIEW | Expanded card metadata line: started/finished absolute timestamps, turns, model id, mono |
| 1 | REVIEW | Done column hygiene: "clear closed" plus collapse cards older than today |
| 1 | REVIEW | Density toggle (comfortable/compact) and collapsed-column state persisted per operator |
| 1 | REVIEW | Empty Error column recedes (faint border, no red pip) so red means signal |

### top3_must

| Votes | Agree? | Item |
|---|---|---|
| 1 | REVIEW | Add faint last-updated timestamp on settled cards below summary |
| 1 | REVIEW | Make card #id faint instead of full ink to reduce visual noise |
| 1 | REVIEW | Use panel2 for expanded card background to create clear hierarchy |
| 1 | REVIEW | Add robust field validation and keyboard-friendly multiline follow-ups. |
| 1 | REVIEW | Improve modal focus trapping, restoration, and visible focus treatment. |
| 1 | REVIEW | Clarify retry attempts, timestamps, connection freshness, and result provenance. |
| 1 | REVIEW | Highlight active search query matches inside card title, directory, and prompt text. |
| 1 | REVIEW | Add vertical timeline connector line between conversation turns in expanded card history. |
| 1 | REVIEW | Truncate long directory paths in middle to preserve root and leaf folder names. |
| 1 | REVIEW | Reduce card padding and increase info density |
| 1 | REVIEW | Add subtle grid background for visual rhythm |
| 1 | REVIEW | Optimize running indicator to be less distracting |
| 1 | YES | Modal input ergonomics: auto-grow prompt, draft persistence, recent-dir datalist, remembered defaults |
| 1 | REVIEW | Error card forensics: mono scrollable message, copy-error, time-to-failure, retry clarity |
| 1 | REVIEW | Queue transparency: Todo queue position plus header worker-capacity readout |

## Font suggestions

- **x-ai/grok-4.20:** system-ui, -apple-system, sans-serif – retain for zero-load speed; apply -0.01em tracking and 500 weight on card titles · pair: optional
  - `font-weight:500;letter-spacing:-0.01em;`
- **openai/gpt-5.6-luna:** system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif — native rendering, strong legibility, and dependable density. · pair: Use the existing monospace stack for IDs, paths, model tags, and technical values.
  - `Use 600 for card titles, 700 for column labels, normal body weight, and restrained tracking.`
- **google/gemini-3.6-flash:** system-ui, -apple-system, sans-serif for clean high-density operator legibility · pair: ui-monospace, SFMono-Regular, Menlo, monospace for IDs, paths, and model tags
  - `font-normal tracking-tight tabular-nums for metrics and dense UI metadata`
- **deepseek/deepseek-v4-flash:** System UI sans (SF/Inter/Helvetica Neue) with letter-spacing -0.01em for body, 0.02em for labels · pair: Keep monospace for ids and paths as already done
  - `Use font-weight 400 body, 600 headings, 500 tags; tracking tight`
- **anthropic/claude-opus-5:** Keep system UI sans: zero load cost, native legibility at 13px on dark panels · pair: ui-monospace/SFMono for ids, paths, timestamps, error bodies — already partially in use
  - `Body 13px/1.45 weight 400; titles 600; uppercase labels 11px 600 tracking +0.06em`

## Auto-agree implementation queue (by votes)

1. [general · 1×] Directory field: datalist of recent dirs, remember last model/effort as defaults
2. [transitions · 1×] Newly claimed card scrolls into view smoothly; instant jump under reduced-motion
3. [professional · 1×] Add 1px inset shadow on modal glass panel for depth
4. [professional · 1×] Make status pips 6px with 2px stroke for better contrast
5. [top3_must · 1×] Modal input ergonomics: auto-grow prompt, draft persistence, recent-dir datalist, remembered defaults

## Agent decisions

_Fill during implement step: which YES items you shipped, which you skipped and why._

## Stop condition

stop_votes=1 / n_parsed=5. Loop ends when stop_votes >= 3 OR agree queue is empty of shippable UI work.

## Agent decisions — Round 3 → LOOP COMPLETE
Round 3 surfaced only scattered 1-vote nits (faint #id — already faint; expanded-bg tint;
timeline connector; middle-truncate paths; search-match highlight) plus 1 stop vote.
No material, cross-model design gap remained that respects the locked calm-operator tone.
**Stopped** per stop-check #3 (agree queue = nits only) + rising stop votes. Nothing shipped this round.
