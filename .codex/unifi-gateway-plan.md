# UniFi gateway integration

Base: `74be18140b64e73b9efc5462407526c1e05ed451` (`transproxy`).
Review branch: `review/2026-10-25-unifi-gateway`.
User intent: manually vault the supplied UniFi key, add a dedicated setup/client script, and prove transparent credential substitution through Aigate. No real secrets belong in source, tests, logs, or review briefs.

## Implementation ownership

1. Core builder: add the `unifi` catalog/adapter, reuse upstream `X-API-KEY` substitution and encrypted capture, add an exact-origin private-literal-IP-only TLS exception, add `unifi_aigate_setup_script`, and fix the shared raw-key POST metadata response required by setup read-back. Own `src/providers.js`, `src/transparent-proxy.js`, `src/server.js`, the launcher, and core/setup tests. These coupled planner steps are combined to avoid simultaneous edits to the shared adapter and catalog.
2. Client builder: add executable `clients/aigate-unifi.mjs`, `test/unifi-client.test.js`, and UniFi instructions in `setupscripts/README.md` and `docs/TRANSPARENT-PROXY.md`. Read only explicitly supplied Aigate URL/proxy token; never fetch/export the upstream key or fall back to direct gateway access. Reject absolute and protocol-relative targets.
3. Orchestrator: integrate explicit paths, run affected and full Node 24 checks with child PATH pinned, ShellCheck launchers, perform two fresh exact-final-commit reviews, and prepare a local PR description. No publication or production deployment is implicit.

## Acceptance

- Preserve raw method, path/query, body, response status/body and application headers, except documented credential/Host/transport substitutions.
- Substitute the vault key into `X-API-KEY`; never forward the client proxy bearer credential upstream.
- TLS exception is opt-in, UniFi-only, HTTPS-only, exact-origin (including port), and private/loopback literal-IP-only. All other TLS verification remains enabled. Never disable Node TLS globally. Redirects remain unfollowed.
- Actual-server setup test proves the POST metadata/read-back contract, hidden manual intake, cancellation, and no raw secret output.
- Synthetic vault/capture tests prove encryption and absence of implicit credential provisioning.
- Client help works offline; missing configuration, invalid targets, HTTP/connection failures fail clearly without printing credentials.
- Full test command: `env PATH="/Users/shoemoney/.nvm/versions/node/v24.16.0/bin:$PATH" /Users/shoemoney/.nvm/versions/node/v24.16.0/bin/node --test`.
- ShellCheck: `shellcheck setupscripts/*_aigate_setup_script`.

## Operational boundaries

Production is currently stopped on NAS `.10` at `/mnt/tank/apps/aigate`; its endpoint returns 502. Preserve `.env`, its existing encryption key, database, and encrypted traffic files. Do not purge or restore other credentials. A separately selected persistent local runtime/vault can establish live gateway proof; label this separately from production deployment. Any production start/deploy requires a concrete reviewable decision after local implementation and reviews are complete.

The named Studio planner role was unavailable; planning used a fresh default-agent context. Native review contexts, if used, are independent but not OS-enforced read-only.
