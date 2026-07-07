# 🛡️ cclb

**Safe multi-account Claude Code — an audited token vault, usage-aware account
selection, and a live dashboard. Uses the *official* `claude` binary, never a
relay/proxy, so it won't get your accounts flagged.**

If you legitimately hold more than one Claude Max subscription, Anthropic's
Claude Code team has said [multiple accounts are *not* against ToS](https://github.com/anthropics/claude-code/issues/54464)
— what gets banned is **relaying/reselling tokens through a proxy that
impersonates the client.** cclb deliberately stays on the accepted side of
that line:

- ✅ every request runs the **official `claude` binary** against **your own token**
- ✅ cclb is **never in Anthropic's request path** — it only *picks* the account and *records* activity via Claude Code's local **hooks**
- ❌ no MITM proxy, no `ANTHROPIC_BASE_URL` interception, no token relay server

## What it does

- **🔐 Token vault** — your account setup-tokens stored **AES-256-GCM encrypted** at rest.
- **⚖️ Usage-aware selection** — hands out the account with the **most headroom** (lowest of the 5-hour / weekly rate-limit %), so no single account runs away.
- **🧾 Full audit** — every token handout is logged with **timestamp + source IP + host**. Every prompt is logged (via a local hook) with account, host, cwd.
- **📊 Live dashboard** — WebSocket UI: account cards with live usage bars (🚨 on runaway), a streaming activity feed, and **per-host/device stats**.

## Architecture (no proxy)

```
 each box (official claude):
   cclb-run     → GET /api/select  → best account + token  (audited by IP)
   UserPromptSubmit → POST /api/events/prompt   {account,host,cwd,prompt}
   statusLine       → POST /api/events/usage    {account,5h%,weekly%}
                                   │
                        cclb daemon (SQLite)
                                   │  WebSocket push
                             live dashboard
```

The daemon never sees Anthropic traffic. Hooks report *what happened*; the
official client talks to Anthropic directly with your token.

## Quick start

```bash
git clone <this repo> && cd cclb
cp .env.example .env
# set CCLB_TOKEN (any long random string) and
# CCLB_ENCRYPTION_KEY=$(openssl rand -hex 32)
npm install
npm start          # → http://localhost:20200
```
Or Docker: `docker compose up -d`.

Open the dashboard, enter your `CCLB_TOKEN`, then add your accounts:
```bash
curl -X POST http://localhost:20200/api/accounts -H "Authorization: Bearer $CCLB_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"account":"max_1","setup_token":"sk-ant-oat01-...","label":"personal"}'
```
Get each token with `claude setup-token` while logged into that account.

### Wire up a box (client side)
```bash
mkdir -p ~/.claude/cclb && cp clients/*.sh ~/.claude/cclb/
export CCLB_URL=https://cclb.example.com CCLB_TOKEN=...
# launch via the router so the account is chosen by headroom:
alias cc='bash ~/.claude/cclb/cclb-run.sh'
```
Register `prompt-hook.sh` as a `UserPromptSubmit` hook and `statusline-feed.sh`
as your `statusLine` in `~/.claude/settings.json` (snippets in each file).

## API
| Method | Path | Purpose |
|--------|------|---------|
| `GET`  | `/api/select?host=` | best account + token (logs access w/ IP) |
| `GET/POST/DELETE` | `/api/accounts` | vault CRUD (tokens write-only) |
| `POST` | `/api/events/prompt` | log a prompt (from the hook) |
| `POST` | `/api/events/usage`  | update an account's 5h/weekly % |
| `GET`  | `/api/stats` · `/api/logs` | dashboard data |
| `WS`   | `/ws?token=` | live event stream |

All endpoints require `Authorization: Bearer $CCLB_TOKEN`.

## ⚠️ Use responsibly
Multiple **personal** subscriptions used via the official client is fine per
Anthropic. **Reselling or pooling access for others is not** — don't. cclb
gives you visibility so you stay honest and no account runs away.

## Roadmap
- [ ] Periodic prober (keep idle accounts' usage fresh)
- [ ] `CLAUDE_CONFIG_DIR` profile mode (keep tokens fully local per box)
- [ ] Failover on 429 mid-session
- [ ] Per-account daily/hourly budgets + alerts

MIT © shoemoney
