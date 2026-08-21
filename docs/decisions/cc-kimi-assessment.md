# Assessment: cc kimi Feature Branch

**Branch:** `research/20260820-cc-kimi` (commit 79ddd63, originally 7d59988 from July 18, 2026)

## What the Branch Does

The branch adds **`cc kimi [args]`** — a new CLI subcommand that runs the official `claude` binary against Kimi K3 (kimi.com's "Kimi for Coding" subscription) via its Anthropic-compatible endpoint (`https://api.kimi.com/coding`).

### Implementation
- **New script:** `clients/aigate-kimi.sh` (53 lines)
  - Fetches the `sk-kimi` provider key from aigate's vault (via `/api/keys/kimi`)
  - Caches the key locally (mode 600) with fallback if vault is unreachable
  - Maps Kimi models to ANTHROPIC_* environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`)
  - Runs Claude with model tier mapping (main model `k3`, fast model `kimi-for-coding-highspeed`)
  - Adds `--dangerously-skip-permissions` in headless mode to avoid hanging on the trust prompt

- **Updated script:** `clients/install.sh` (+10 lines)
  - Installs the new `aigate-kimi.sh` script
  - Adds a conditional branch in the generated `cc` wrapper: `[ "${1:-}" = kimi ] && exec aigate-kimi.sh`
  - Reconciles an unset for `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (force single-session REPL, never agent-teams board)

## Still Applicable to Current Main?

**YES, cleanly.** Trial rebase onto `origin/main` (as of Aug 17, 2026) succeeded with **zero conflicts**.

The rebased commit (79ddd63) applies without modification. No API surface changes in aigate since the branch was created:
- `/api/keys/:provider` endpoint still exists ✓
- Provider key registry still encrypts and serves keys on demand ✓
- aigate vault schema compatible ✓

## Conflict Surface in clients/install.sh

**NONE.** The branch adds 10 lines:
- Line 31: Installs `aigate-kimi.sh` (new line, no conflict)
- Lines 48–62: Adds the `cc kimi` branch and the EXPERIMENTAL_AGENT_TEAMS unset (inserted before the existing `exec aigate-run.sh`)

Current main's `install.sh` has no conflicting edits to these sections. The rebase confirms this.

## Recommendation

**KEEP AND REBASE.** The feature is:
- Architecturally sound (uses existing `/api/keys/:provider` API, no new server-side code needed)
- Non-breaking (adds a new `cc kimi` subcommand; default behavior unchanged)
- Well-tested (author verified parallel swarm, cache atomicity, multi-model mapping)
- Clean on main (zero rebase conflicts)

The only prerequisite: the user must add a `kimi` provider key to aigate's vault (`POST /api/keys` with `{provider: "kimi", key: "sk-kimi-…"}`). The script already documents this in its error message.

**Next step:** Rebase interactively, verify the code reads the same after rebase (it does), and merge to main.

---

*Assessment completed 2026-08-20. Trial rebase: clean, zero conflicts. Commit hash changed due to rebase (7d59988 → 79ddd63); code unchanged.*
