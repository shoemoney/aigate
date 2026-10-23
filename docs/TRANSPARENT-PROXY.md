# Transparent credential proxy

Configure one or two stable proxy-only keys in `.env`, manually enter provider
credentials, and use a provider-specific AIGate base URL such as
`$AIGATE_URL/proxy/openai/v1`. A client sends its preset proxy key; AIGate selects
the manually registered OpenAI credential and substitutes it for the upstream
request. Requests never create provider credentials.

Client keys grant proxy access only. They cannot read the vault, register
credentials, manage bindings, or download traffic. Administration uses the
existing `AIGATE_TOKEN` or an authenticated dashboard session.

## Relay contract

The transparent path preserves the HTTP method, original path and query encoding,
body bytes, model names, application headers, upstream status and error bodies.
Binary uploads, multipart bodies, compressed content, and SSE responses are
streamed without JSON parsing, decompression, model aliases, automatic key
failover, or redirect following. A provider's 401 or 429 is returned to the client
from that one attempt.

The necessary exceptions are explicit:

- The client authentication header is replaced with the configured provider key.
  Anthropic uses `x-api-key`; supported bearer providers use `Authorization: Bearer`.
- AIGate's own `aigate_sess` administrator-session cookie is removed from outgoing
  `Cookie` headers. Upstream `Set-Cookie` fields targeting that same gateway-owned
  name are excluded from the downstream response. Other application cookies are
  retained.
- `Host` addresses the configured upstream. An optional operator-supplied upstream
  path prefix is prepended to the original request target. Preset-key routing
  removes only the `/proxy/<provider>` prefix; the remaining raw path and query
  are retained.
- Connection-specific headers, including headers named by `Connection`, are
  removed. Node handles HTTP transfer framing for each connection. Header names,
  duplicate fields, and order are retained where the HTTP implementation allows.

This is application HTTP capture and forwarding, not a recording of TLS records,
TCP packets, HTTP chunk boundaries, or the original header whitespace. CONNECT,
WebSocket upgrades, and realtime protocols are unsupported. `/api*`, `/health`,
`/healthz`, and `/ws` remain AIGate routes.

Send exactly one `Authorization: Bearer <client-key>` or `x-api-key: <client-key>`
header. Duplicate or conflicting authentication is rejected. A key in a query
parameter is not accepted as proxy authentication.

Initial authentication adapters support catalog providers marked
`oaiCompat: true`, plus Anthropic, Kimi, and Muse. Other catalog providers return
422 before any upstream request; a catalog entry alone is not proof its
authentication scheme is implemented. AWS also returns 422. A custom provider
outside the catalog is available only through an explicit client binding with an
operator-supplied upstream and the bearer API-key contract.

Interim responses are recorded as `information` events. Incoming
`Expect: 100-continue` receives a recorded local 100 response before the body is
accepted. Upstream interim responses retain their status and application header
pairs when forwarded, including duplicate 103 fields without a `Link` header.
The 100 Continue handshake belongs to each connection: upstream 100 responses
are captured without sending a second downstream handshake. The same HTTP
transport exceptions above apply to interim responses.

## Configure preset proxy keys

Set either or both optional values in the server's `.env`:

```dotenv
AIGATE_PROXY_TOKEN=
AIGATE_PROXY_TOKEN_2=
```

Enter two independent random secrets manually; do not reuse the administrator
`AIGATE_TOKEN`. Each configured key must be 8–512 characters without whitespace
or commas, and the two values must differ. Invalid configured keys prevent
startup. Leave either slot empty to disable it. Restart the daemon after
editing these settings. Removing or replacing one slot revokes that key after
restart while the other slot remains available.

Both keys grant proxy access to manually registered provider credentials through
`/proxy/<provider>/...`. They do not grant vault, administration, or traffic-log
access. Use separate client bindings below when a client must be isolated to one
specific provider credential.

Preset keys are explicit gateway configuration, not provider credentials. AIGate
does not scan other environment variables, AWS profiles, login files, or instance
metadata for credentials to import.

## Manually add a provider credential

Source the installed administration environment; do not parse its quoted values:

```bash
set -a
. "$HOME/.claude/aigate/env"
set +a
```

Create `credential.json` manually. These values are examples, not usable keys:

```json
{
  "provider": "openai",
  "label": "Development API key",
  "kind": "api_key",
  "fields": { "api_key": "example-provider-key-replace-manually" }
}
```

Submit it as an administrator:

```bash
curl -sS "$AIGATE_URL/api/proxy/credentials" \
  -H "Authorization: Bearer $AIGATE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @credential.json
```

The response is metadata: `id`, `provider`, `label`, `kind`, the field names, and
`created`. Field values are encrypted together in the database and never returned
by credential-list endpoints. Provider IDs use lowercase letters, digits, dots,
underscores, or hyphens. The `api_key` kind requires exactly one `api_key` field.

For preset-key requests, AIGate selects the newest manually registered API-key
credential for the provider in the URL. Structured `proxy_credentials` are
preferred; a working manually added key from the existing `provider_keys` vault
is a compatibility fallback when no structured credential exists. If only
unsupported structured kinds exist for that provider, the request returns 422
instead of falling back. A provider without a manually registered credential
returns 503. This selection never creates a credential or reads
subscription-account OAuth credentials.

## Use the endpoint

For an OpenAI-compatible SDK, set its base URL to
`$AIGATE_URL/proxy/openai/v1` and its API key to either configured proxy-only key.
Keep the model and request payload exactly as they should be sent to the provider.
No `openai:` model prefix is needed. The application only needs the proxy key;
the real OpenAI API key stays on AIGate.

This curl example uses a deliberately illustrative model name:

```bash
curl -sS "$AIGATE_URL/proxy/openai/v1/responses" \
  -H "Authorization: Bearer $AIGATE_PROXY_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-Application-Request: example-request' \
  --data-binary '{ "model": "your-provider-model", "input": "Hello" }'
```

Here `AIGATE_PROXY_TOKEN` is an application-side variable holding the preset key
you chose; it is separate from the sourced administration environment. Applications
must not receive `AIGATE_TOKEN`.

For OpenAI, `/proxy/openai/v1/responses` is forwarded to
`https://api.openai.com/v1/responses`. For OpenRouter,
`/proxy/openrouter/v1/...` becomes `https://openrouter.ai/api/v1/...`. Provider
defaults come from the provider catalog with only a terminal `/v1` removed.
Kimi uses the explicit upstream `https://api.kimi.com/coding`.

The operator may override a preset route's upstream with
`AIGATE_TRANSPARENT_UPSTREAM_<PROVIDER>` in the server environment, such as
`AIGATE_TRANSPARENT_UPSTREAM_OPENAI`. The suffix is the uppercase provider ID
with nonalphanumeric characters replaced by underscores. The value must be an
HTTP(S) origin with an optional path prefix, without embedded credentials,
query, or fragment; the caller cannot supply its own upstream.

## Optional isolated client bindings

A manually registered client key can instead be bound to a specific credential,
independently of the preset `.env` keys. Create `client.json` using the credential
ID returned when you added the credential:

```json
{
  "token": "11111111111",
  "provider": "openai",
  "credential_id": 1,
  "label": "Example isolated application"
}
```

```bash
curl -sS "$AIGATE_URL/api/proxy/clients" \
  -H "Authorization: Bearer $AIGATE_TOKEN" \
  -H 'Content-Type: application/json' \
  --data-binary @client.json
```

For this explicit binding, use `$AIGATE_URL/v1` as the SDK base URL and the
registered client key as its API key. A call to `/v1/responses` retains that
original path; the provider is selected by the binding rather than a URL prefix.

`11111111111` is only an illustration; manually choose a random client secret for
actual use. Client keys must be 8–512 characters without whitespace or commas,
must differ from the administrator and configured preset proxy tokens, and are
stored as SHA-256 hashes.
List responses do not reveal them.

A binding selects one credential for one provider. As a compatibility option,
`key_id` can select a manually entered, working row from the existing `/api/keys`
vault instead of `credential_id`; provide exactly one of those fields. The proxy
does not fall back to another credential if that row is removed or unavailable.

An administrator may set `upstream` when creating the binding. It must be an
HTTP(S) origin with an optional path prefix, without embedded credentials, query,
or fragment. For example, `https://provider.example/api` plus an incoming
`/v1/files?purpose=test` forwards to
`https://provider.example/api/v1/files?purpose=test`. Incoming headers, bodies, and
query parameters cannot choose an arbitrary upstream.

Existing calls authenticated with the administrator token retain the older
model-routing proxy behavior described in the README. Those compatibility routes
rewrite models and have different logging; use a preset proxy key with a provider
path or a registered client binding to select the transparent relay.

## Multi-field credentials and AWS

Manual credentials can contain several named string fields. `bundle` stores a
generic set of fields; `aws_sigv4` requires `access_key_id`, `secret_access_key`,
and `region`, and accepts an optional `session_token` and other named fields.

```json
{
  "provider": "aws",
  "label": "Example AWS bundle",
  "kind": "aws_sigv4",
  "fields": {
    "access_key_id": "example-access-key-id",
    "secret_access_key": "example-secret-key",
    "session_token": "example-session-token",
    "region": "us-east-1"
  }
}
```

AWS signing and other multi-field authentication adapters are future work.
Storage support does not imply forwarding support: binding a `bundle` or
`aws_sigv4` credential returns 422 rather than treating one field as a bearer
token. An AWS adapter will need request signing, not simple key substitution.
See [AWS's SigV4 description](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html).

Credential creation always requires an explicit authenticated administrative
request. The relay never imports credentials from traffic, local SDK settings,
environment variables, AWS profiles, or instance metadata. Existing Codex sync
can update an already registered account; it cannot create an unknown account.
Startup creates schema without importing credentials or deleting newly added
ones.

## Complete encrypted traffic records

Every exchange handled by the transparent relay records the incoming request,
forwarded request headers, request body, upstream response headers and body,
trailers, timestamps, and the completion, rejection, abort, or error outcome.
Stream body events contain base64 bytes. Rejected requests handled by this relay
are captured too; unrelated administrative, static, health, and legacy-proxy
requests are outside this capture path.

Capture includes the raw client and upstream credential values. Those values,
headers, targets, and body events are encrypted at rest using the existing vault
key. An administrative download decrypts them in full. Metadata lists contain
IDs, timestamps, provider, status/state, and byte counts, with no headers or body
content.

The original incoming and upstream response headers are still captured when
gateway-session cookie isolation removes a field from the relay. Recorded
forwarded headers show the effective request and response after those removals.

The SQLite `proxy_traffic` table indexes per-exchange encrypted event files under
`proxy-traffic/` beside `AIGATE_DB`. The directory has mode 0700 and new files have
mode 0600. Body capture uses bounded chunks and records them durably before
forwarding. A capture failure stops forwarding rather than silently omitting
traffic. After a restart, unfinished exchanges are marked interrupted.

There is no automatic retention deletion or body truncation. Existing summary-log
retention does not prune these complete records. Preserve the event directory,
database, and encryption key together when backing up or restoring this feature.

The offline `scripts/rotate-key.js` helper re-encrypts structured credentials, but
refuses rotation if traffic metadata or any encrypted `.events` file exists. It
also refuses if it cannot inspect the event directory. Rotating complete capture
files is not implemented; do not delete traffic records or event files merely to
bypass this refusal. Keep the current encryption key with those records until a
capture-aware rotation procedure is available.

List records, newest first:

```bash
curl -sS "$AIGATE_URL/api/proxy/traffic?limit=100" \
  -H "Authorization: Bearer $AIGATE_TOKEN"
```

Use `before=<record-id>` for the next page. Read one record with paginated events:

```bash
curl -sS "$AIGATE_URL/api/proxy/traffic/1?limit=100" \
  -H "Authorization: Bearer $AIGATE_TOKEN"
```

If `next_after` is non-null, pass it as `after` to the same record endpoint for
the next event page. Limits are capped at 1000. Download every decrypted event
without loading the whole record into memory:

```bash
curl -sS "$AIGATE_URL/api/proxy/traffic/1/events" \
  -H "Authorization: Bearer $AIGATE_TOKEN" \
  --output proxy-traffic-1.ndjson
```

Each NDJSON object has `sequence`, `type`, and `at`. Event types include `request`,
`forward`, `request_body`, `request_end`, `response`, `response_body`,
`response_end`, `information`, `error`, `end`, and `interrupted`. Concatenate the base64-decoded
`data` fields of each `request_body` or `response_body` event in sequence to
reconstruct that direction's body. Event segmentation reflects capture reads,
not the provider's original network packet boundaries.

Preset-key exchanges have `client_id: null` in metadata because they are not
database client bindings; their provider and the original request are still
captured.

## Administrative endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` / `POST` | `/api/proxy/credentials` | List metadata / manually add encrypted fields |
| `DELETE` | `/api/proxy/credentials/:id` | Delete a stored credential; its bindings then fail closed |
| `GET` / `POST` | `/api/proxy/clients` | List metadata / manually bind a client key |
| `DELETE` | `/api/proxy/clients/:id` | Revoke the client key |
| `GET` | `/api/proxy/traffic?limit=&before=` | Paginated exchange metadata |
| `GET` | `/api/proxy/traffic/:id?after=&limit=` | Exchange metadata and an event page |
| `GET` | `/api/proxy/traffic/:id/events` | Stream all decrypted events as NDJSON |

`AIGATE_TRANSPARENT_TIMEOUT_MS` controls upstream inactivity timeout. It defaults
to 300000 milliseconds and has a minimum of 1000 milliseconds. This setting
applies to the transparent relay; it does not configure the legacy proxy.
