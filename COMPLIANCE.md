# Request paths and credential boundaries

AIGate provides an encrypted credential vault, account selection, provider
API-key proxies, and an explicit Claude Code subscription pool. This document
describes which component sends each request and where credentials are used.

## Request paths

| Path | Credential source | Model request path |
|---|---|---|
| Claude account selection through `/api/select` | Manually added Claude account | AIGate returns the selected token; the official `claude` client connects directly to Anthropic. |
| Codex account selection through `/api/select?kind=codex` | Manually added Codex `auth.json` | The launcher writes the selected authentication file; the official `codex` client connects directly to ChatGPT. |
| Transparent `/proxy/<provider>/...` API-key routes | Manually added provider API key | The application connects to AIGate; AIGate substitutes the provider credential and forwards the request. |
| Explicit `/proxy/claude-code/...` | Manually added Claude Code setup tokens in `accounts` | The official Claude Code client connects to AIGate with a stable gateway key; AIGate selects an account and forwards the request to Anthropic. |
| Legacy administrator-token model-routing proxy | Manually added provider API keys | AIGate routes the request using the older model/provider mapping behavior documented in the README. |

The Claude Code pool is in the inference request path. The original selector
paths remain available, and Codex subscription inference retains its direct
official-client path. Provider API-key proxy routes and the Claude Code pool use
separate credential sources.

## Manual credential registration and access

Claude setup tokens are registered as `accounts.kind='claude'`. Codex
authentication files are registered as `accounts.kind='codex'`. Provider API keys
belong in `provider_keys` or an encrypted `proxy_credentials` entry. API-key
intake rejects Claude setup tokens, and API-key relays reject them if found in a
configured API credential. The explicit Claude Code pool reads Claude accounts.

Credential creation requires an authenticated administrative action. Proxy
requests, quota probes and historical usage/pricing imports do not create
credentials. AIGate does not discover credentials from request traffic, SDK
configuration, AWS profiles or instance metadata. Existing Codex sync updates an
already registered account.

`AIGATE_PROXY_TOKEN` and `AIGATE_PROXY_TOKEN_2` are stable proxy-only gateway keys.
Manually registered client bindings can pin an API-key client to one credential.
These keys do not grant vault administration, credential retrieval or traffic-log
downloads. The administrator bearer or an authenticated dashboard session
controls those operations. Credential lists expose metadata; explicit selector
and key-fetch APIs return credentials to authenticated administrators.

## Claude Code pool behavior

The client creates its normal model request, application headers and system
attribution. AIGate substitutes the chosen account's Bearer token while keeping
the requested model and body bytes. It does not forge client fingerprints,
User-Agent strings or system attribution. Required OAuth capability headers are
configured on the client and forwarded with its other beta values.

The pool requires fresh, known remaining allowance above zero in both five-hour
and weekly windows, preferring the eligible account whose weekly reset is
soonest. Manual quota scopes group tokens sharing a subscription; credential
expiry is separate metadata. A confirmed quota admission rejection can select
another compatible account before upstream output is exposed. Generic
throttling, overload, ambiguous transport failures and partial streams do not
cause hidden quota replay.

AIGate also constructs its own minimal inference probes to observe quota
headers every five minutes by default. These consume allowance, identify
themselves with AIGate's usage-probe User-Agent, and receive full encrypted
traffic capture. They do not impersonate the official client. Setup tokens are
replaced manually when expired or revoked.

## Forwarding and complete traffic capture

Transparent routes retain application headers, request/response body bytes,
model names, query encoding and upstream error bodies subject to the documented
authentication and HTTP transport handling. AIGate replaces authentication,
addresses the configured upstream in `Host`, removes the routing mount prefix,
and handles connection headers and transfer framing for each HTTP connection.
It removes its own `aigate_sess` cookie from provider-bound traffic and excludes
upstream cookies targeting that gateway-owned name. Other application cookies
are retained. The [transparent proxy guide](docs/TRANSPARENT-PROXY.md) defines
the full relay contract and replay limits.

Complete captures contain raw request and response bytes, including credential
values. They are encrypted at rest with the vault encryption key; administrative
downloads decrypt the complete record. The Claude pool separately records each
attempt's account, quota observation, effective headers, upstream response and
retry decision. Its bounded replay files are also encrypted. Capture or replay
failure stops forwarding. Metadata lists do not expose captured headers or body
content, and legacy summary logs are separate from these complete records.

## Codex refresh ownership

The existing Codex path stores `auth.json` encrypted, reads account usage through
the configured usage endpoint and refreshes expiring credentials server-side.
Refresh operations are single-flight per account, and rotated credentials are
persisted before being returned. An uncertain refresh outcome halts automatic
refresh; the external refresh ledger protects against reuse after restoring an
older database. The client keeper can adopt the vault's current authentication
file. These usage and authentication calls do not relay Codex model inference.

## Technical references

- [AIGate setup, selector and spend APIs](README.md)
- [Transparent proxy setup, account pool, capture and administration](docs/TRANSPARENT-PROXY.md)
- [Anthropic: connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)
- [Anthropic: Claude Code gateway compatibility guide](https://code.claude.com/docs/en/llm-gateway-protocol)
- [Anthropic: Claude Code authentication](https://code.claude.com/docs/en/authentication)
