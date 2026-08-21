# Backlog

Captured unbuilt items from design jury that warrant future feature passes.

## Deferred Features

### Multi-select Todo cards + block reorder
- **Source:** improve-r11.md (Design Jury Round 11)
- **Status:** DONE — shift/ctrl-click or the checkbox selects multiple Todo cards, dragging any
  selected card moves the whole block together (relative order preserved), posting one combined
  `ids[]` to `POST /api/board/reorder`; single-card drag is unchanged. See `public/board.html`
  (`selectedIds`/`toggleSelect`/`dragIds`) and the multi-id test in `test/http.test.js`.
