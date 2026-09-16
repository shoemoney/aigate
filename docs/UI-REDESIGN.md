# AIGate interface verification

The supported UI is `/` (password entry and authenticated control room) and
`/board` or `/board.html` (task board). The four standalone visual experiments
redirect to `/`. All authenticated views share the AI-lock identity and top menu.

The entry form is independent of Vue. A public `/api/session` probe determines
whether to open the workspace; protected data and sockets start after login.
The previous Suspense boot gate, microphone authentication, and accumulated
experimental renderers have been removed from the entry page.

`public/assets/token-field.js` renders instanced token sprites using WebGPU.
Ambient tokens are illustrative; real authenticated WebSocket events trigger
additional motion. Credentials and prompt contents are never painted in the
background. Canvas 2D handles unsupported devices and device loss. Reduced
motion produces a still field, and hidden documents stop rendering.

Fonts, icons, Vue, and ECharts are served locally. Account usage charts are
interactive and use actual API values; accounts without a usage reading show
“Not checked”. Configured selection cutoffs come from `/api/capabilities`.

Verified locally on September 15, 2026:

- 200 Node tests passed, including session, route, font MIME, and retired-page checks.
- Chromium ran the WebGPU renderer on the landing, dashboard, and board.
- Canvas fallback, GPU device loss, and reduced-motion behavior passed.
- Incorrect/correct password, logout, board login redirect, navigation, and
  return to live dashboard passed without runtime errors on the final pages.
- Account add/edit/pause/enable/delete and provider-key add/verify/delete passed
  against an isolated temporary database. Provider verification used a custom
  test provider with no external liveness probe.
- Task creation and deletion passed. Socket events reached the token renderer.
- Usage events updated the ECharts plot. Unpolled accounts produced null chart
  values rather than an invented zero reading.
- Desktop (1440px) and mobile (390px) visual checks passed. Visible DOM text was
  at least 18 CSS px, and neither layout had horizontal page overflow. Tables
  and the mobile navigation can scroll within their own containers.
- The mobile unlock button is visible in the initial 844px viewport.

The local preview uses an isolated database under `.tmp/aigate-redesign/`, with
upstream polling disabled. Production was deployed to https://aigate.shoemoney.ai on September 15, 2026.
All 200 tests also passed in the production Node 24 image. A consistent copy of
the live database passed integrity and unchanged-vault checks before rollout.
The existing password, encryption key, and vault data were preserved. Login,
API protection, WebSocket connectivity, and the new public session endpoint
were verified after deployment. Live desktop/mobile captures are saved locally
under `reports/aigate-live-2026-09-15/`. Screenshot review also corrected an
overflow from the decorative overview halo; checks compare against the document
client width, including scrollbar space. The rollback image and quiescent data
backup remain on the server under `aigate-releases/20260916T030700Z/`.
