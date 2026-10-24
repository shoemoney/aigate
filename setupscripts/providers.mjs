import { PROVIDERS } from '../src/providers.js';

// The setup catalog extends the server's descriptive registry without changing
// its routing or credential intake. A native login is a different credential
// type from that provider's API key, even when both are offered by the same CLI.
const AWS_FIELDS = [
  { name: 'access_key_id', label: 'AWS access key ID', secret: true, required: true },
  { name: 'secret_access_key', label: 'AWS secret access key', secret: true, required: true },
  { name: 'region', label: 'AWS region', secret: false, required: true, default: 'us-east-1' },
  { name: 'session_token', label: 'AWS session token (optional)', secret: true, required: false },
];

const OVERRIDES = {
  aws: { kind: 'aws_sigv4', fields: AWS_FIELDS, storageOnly: true },
  'aws-bedrock': { kind: 'aws_sigv4', fields: AWS_FIELDS, storageOnly: true },
  'azure-openai': {
    kind: 'bundle', storageOnly: true,
    fields: [
      { name: 'endpoint', label: 'Azure OpenAI endpoint URL', secret: false, required: true },
      { name: 'api_key', label: 'Azure OpenAI API key', secret: true, required: true },
      { name: 'deployment', label: 'Azure deployment name (optional)', secret: false, required: false },
    ],
  },
  cloudflare: {
    kind: 'bundle', storageOnly: true,
    fields: [
      { name: 'api_token', label: 'Cloudflare API token', secret: true, required: true },
      { name: 'account_id', label: 'Cloudflare account ID', secret: false, required: true },
    ],
  },
  'vertex-ai': {
    kind: 'bundle', storageOnly: true,
    fields: [
      { name: 'service_account', label: 'Service account credential JSON (one line)', secret: true, required: true },
      { name: 'project', label: 'Google Cloud project ID', secret: false, required: true },
      { name: 'location', label: 'Vertex AI location', secret: false, required: true, default: 'us-central1' },
    ],
  },
  modal: {
    kind: 'bundle', storageOnly: true,
    fields: [
      { name: 'token_id', label: 'Modal token ID', secret: true, required: true },
      { name: 'token_secret', label: 'Modal token secret', secret: true, required: true },
    ],
  },
  muse: {
    name: 'Muse CLI login', kind: 'native', provider: 'muse-code', nativeId: 'muse',
    apiKeyProvider: 'muse', storageOnly: true,
  },
};

// These literal vault IDs also appear in the existing client scripts. They are
// intentionally preserved rather than renamed to a superficially similar API.
const CLIENT_PROVIDERS = [
  { id: 'kimi', name: 'Kimi for Coding API key', provider: 'kimi', kind: 'api_key', docs: 'https://www.kimi.com/code' },
  { id: 'meta', name: 'Meta Muse API key (legacy meta ID)', provider: 'meta', kind: 'api_key', docs: 'https://ai.meta.com' },
  { id: 'qwen-tokenplan', name: 'Qwen token plan API key', provider: 'qwen-tokenplan', kind: 'api_key', docs: 'https://www.alibabacloud.com/help/en/model-studio' },
  { id: 'apify', name: 'Apify API token', provider: 'apify', kind: 'api_key', docs: 'https://docs.apify.com' },
  { id: 'fontawesome', name: 'Font Awesome API token', provider: 'fontawesome', kind: 'api_key', docs: 'https://docs.fontawesome.com' },
  {
    id: 'gmail', name: 'Gmail app credential', provider: 'gmail', kind: 'bundle', storageOnly: true,
    docs: 'https://support.google.com/accounts/answer/185833',
    fields: [
      { name: 'email', label: 'Gmail email address', secret: false, required: true },
      { name: 'app_password', label: 'Google app password', secret: true, required: true },
    ],
  },
];

const NATIVE_PROVIDERS = [
  { id: 'codex', name: 'Codex CLI login', kind: 'codex', provider: 'codex', nativeId: 'codex', apiKeyProvider: 'openai', docs: 'https://developers.openai.com/codex' },
  { id: 'claude-code', name: 'Claude Code login', kind: 'claude', provider: 'claude-code', nativeId: 'claude-code', apiKeyProvider: 'anthropic', docs: 'https://code.claude.com/docs' },
  { id: 'kimi-code', name: 'Kimi Code login', kind: 'native', provider: 'kimi-code', nativeId: 'kimi-code', apiKeyProvider: 'kimi', storageOnly: true, docs: 'https://www.kimi.com/code' },
  { id: 'grok', name: 'Grok CLI login', kind: 'native', provider: 'grok', nativeId: 'grok', apiKeyProvider: 'xai', storageOnly: true, docs: 'https://docs.x.ai' },
];

const BASE_PROVIDERS = [
  ...PROVIDERS.map(({ id, name, docs }) => ({ id, name, kind: 'api_key', provider: id, docs, ...OVERRIDES[id] })),
  ...CLIENT_PROVIDERS,
  ...NATIVE_PROVIDERS,
  { id: 'muse-api-key', name: 'Muse API key', kind: 'api_key', provider: 'muse', docs: 'https://ai.meta.com' },
];

const ALIASES = { claude: 'claude-code', claude_code: 'claude-code', kimi_code: 'kimi-code' };

/** Every descriptor has an exact-name <id>_aigate_setup_script launcher. */
export const SETUP_PROVIDERS = [
  ...BASE_PROVIDERS,
  ...Object.entries(ALIASES).map(([id, target]) => ({ ...BASE_PROVIDERS.find((entry) => entry.id === target), id })),
];

const BY_ID = new Map(SETUP_PROVIDERS.map((entry) => [entry.id, entry]));

export function getSetupProvider(id) {
  return BY_ID.get(id);
}
