# Aigate provider setup scripts

Run a provider's executable from this directory to add credentials deliberately,
one account at a time. Filenames follow `<provider>_aigate_setup_script`.

```bash
./setupscripts/codex_aigate_setup_script
./setupscripts/claude_code_aigate_setup_script
./setupscripts/muse_aigate_setup_script
./setupscripts/kimi_code_aigate_setup_script
./setupscripts/grok_aigate_setup_script
./setupscripts/aws_aigate_setup_script
./setupscripts/fal_aigate_setup_script
./setupscripts/replicate_aigate_setup_script
./setupscripts/openrouter_aigate_setup_script
./setupscripts/unifi_aigate_setup_script
```

Use `--help` on any launcher for options, or `--once` to finish after one account.
The scripts use Node24 or newer and the existing native CLI for browser logins.
They do not install tools. Use an Aigate server built from this revision so the
create-only account guard and structured credential intake are available.

## Saving an account

The default flow asks for your Aigate URL and administrator token, then an
account name or label. Explicit `AIGATE_URL` and `AIGATE_TOKEN` environment
settings can supply the connection. The administrator token is separate from
the stable proxy keys; clients do not need the vault's encryption key.

The script checks the admin connection before collecting credentials. API keys
are entered at hidden prompts. For a subscription account, complete the native
CLI login using the intended browser account. Open the login link in a private
window if your normal browser is signed into another account. Close all private
windows between accounts so the next login starts with the intended browser
session.

Review the provider and label before saving. The script registers the credential
through the existing administrative intake and reads back metadata to confirm
the saved record. It does not fetch a secret to verify persistence or call the
provider to test a manually entered API key. A successful save means Aigate
stored it; provider validity and live execution require separate checks.

After each attempt, temporary local authentication files are removed before
you are offered the next account. Existing Codex, Claude, Muse, Kimi and Grok
login folders are preserved. The scripts never sign out or revoke a credential
after handing it to Aigate.

## Credential types

- Codex stores its complete fresh ChatGPT `auth.json` as a Codex account.
- Claude Code generates a long-lived setup token and stores it as a Claude
  account. These two account types retain their existing selector behavior.
- Muse Code, Kimi Code and Grok preserve their native login bundles in the
  encrypted structured credential store. These entries are **storage only**;
  they do not add subscription proxy adapters, account rotation or renewal.
  The script asks for explicit consent before storing that type.
- Provider API-key scripts, including fal, Replicate and OpenRouter, collect the
  raw value manually. Native subscriptions and ordinary provider API keys remain
  distinct. Where offered, `--auth api-key` selects the provider-key alternative.
- UniFi uses `unifi_aigate_setup_script` for hidden manual API-key intake. It
  stores the key under provider `unifi`; it does not discover gateway credentials
  or test the live gateway. The [UniFi proxy instructions](../docs/TRANSPARENT-PROXY.md#unifi-network-gateway)
  describe server routing, scoped gateway TLS configuration, and the proxy-only
  helper. Keep the administrator token used for setup separate from the stable
  proxy token used by that helper.
- AWS asks for access key ID, secret access key, region and an optional session
  token. AWS Bedrock has its own launcher using the same structured fields.
  These are stored as `aws_sigv4`; request signing is separate implementation
  work and is not enabled by storing the fields.
- Other services with multiple required fields use explicitly named bundle
  fields. Their scripts describe their storage limits before collecting secrets.

Catalog provider IDs retain their exact spelling in filenames, including
hyphens. Familiar underscore aliases are included for Claude Code and Kimi Code.

## Clipboard handoff

Use `--clipboard` for the earlier dashboard paste workflow when the credential
type has a matching dashboard form. A working clipboard utility is required
before a login starts. Paste the credential into the matching form, save it,
and type `saved` when prompted. This is an **operator-confirmed** save; the script
does not claim it verified the server. Structured bundles require direct
registration because the current dashboard has no matching bundle-paste form.

Clipboard contents are cleared only if they still match the copied credential.
External clipboard-history applications may retain their own copies.

## Cleanup and interrupted setup

Each account gets a new private temporary directory. Authentication roots are
overridden only for that login child process; the normal home directory and
existing login configuration are not changed. Secrets are kept out of command
arguments and runner messages. No existing credential files, AWS profiles or
SDK environment credentials are scanned for import.

Success, errors, cancellation, end of input and caught INT/TERM/HUP signals all
run the same cleanup path. Owned login children stop before their temporary
files are removed. Cleanup failure is reported instead of claiming completion.
SIGKILL and power loss cannot run cleanup; a leftover attempt directory then
requires manual removal. No broad temporary-directory purge runs automatically.

## Native login references

- [Codex credential storage](https://developers.openai.com/codex/auth)
- [Claude Code setup tokens](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)
- [Muse authentication](https://dev.meta.ai/docs/muse-code/auth) and
  [official file-backed isolation example](https://meta-models.github.io/muse-code-sdk/next/generated/examples/shared-harness/)
- [Kimi Code data-directory override](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/env-vars)
- [Grok credential storage](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-login/src/storage.rs)

Automated tests use isolated fake CLIs and loopback Aigate responses. Real login
and live-provider acceptance are not implied by those tests.
