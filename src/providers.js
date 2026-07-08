/**
 * aigate/providers — curated catalog of the top AI providers whose API keys the
 * key registry can hold. Powers the dashboard's add-key dropdown and the
 * key-format hint. `prefix` (when known) is the recognizable start of that
 * provider's keys; `oaiCompat` marks providers that speak the OpenAI API
 * (usable as a drop-in base_url). Purely descriptive data — no secrets.
 */
export const PROVIDERS = [
  // --- LLM frontier / gateways ---
  { id: 'anthropic',    name: 'Anthropic (Claude)',   cat: 'llm',     prefix: 'sk-ant-',   base: 'https://api.anthropic.com',            docs: 'https://docs.anthropic.com' },
  { id: 'openai',       name: 'OpenAI',               cat: 'llm',     prefix: 'sk-',       base: 'https://api.openai.com/v1',            docs: 'https://platform.openai.com', oaiCompat: true },
  { id: 'google',       name: 'Google Gemini',        cat: 'llm',     prefix: 'AIza',      base: 'https://generativelanguage.googleapis.com', docs: 'https://ai.google.dev' },
  { id: 'openrouter',   name: 'OpenRouter',           cat: 'gateway', prefix: 'sk-or-',    base: 'https://openrouter.ai/api/v1',         docs: 'https://openrouter.ai/docs', oaiCompat: true },
  { id: 'perplexity',   name: 'Perplexity',           cat: 'llm',     prefix: 'pplx-',     base: 'https://api.perplexity.ai',            docs: 'https://docs.perplexity.ai', oaiCompat: true },
  { id: 'xai',          name: 'xAI (Grok)',           cat: 'llm',     prefix: 'xai-',      base: 'https://api.x.ai/v1',                  docs: 'https://docs.x.ai', oaiCompat: true },
  { id: 'venice',       name: 'Venice AI',            cat: 'llm',     prefix: '',          base: 'https://api.venice.ai/api/v1',         docs: 'https://docs.venice.ai', oaiCompat: true },
  { id: 'mistral',      name: 'Mistral AI',           cat: 'llm',     prefix: '',          base: 'https://api.mistral.ai/v1',            docs: 'https://docs.mistral.ai', oaiCompat: true },
  { id: 'cohere',       name: 'Cohere',               cat: 'llm',     prefix: '',          base: 'https://api.cohere.com',               docs: 'https://docs.cohere.com' },
  { id: 'deepseek',     name: 'DeepSeek',             cat: 'llm',     prefix: 'sk-',       base: 'https://api.deepseek.com',             docs: 'https://platform.deepseek.com', oaiCompat: true },
  { id: 'ai21',         name: 'AI21 Labs',            cat: 'llm',     prefix: '',          base: 'https://api.ai21.com/studio/v1',       docs: 'https://docs.ai21.com' },
  { id: 'reka',         name: 'Reka AI',              cat: 'llm',     prefix: '',          base: 'https://api.reka.ai',                  docs: 'https://docs.reka.ai' },
  { id: 'writer',       name: 'Writer',               cat: 'llm',     prefix: '',          base: 'https://api.writer.com',               docs: 'https://dev.writer.com' },
  { id: 'aleph-alpha',  name: 'Aleph Alpha',          cat: 'llm',     prefix: '',          base: 'https://api.aleph-alpha.com',          docs: 'https://docs.aleph-alpha.com' },

  // --- Asia frontier LLMs ---
  { id: 'moonshot',     name: 'Moonshot (Kimi)',      cat: 'llm',     prefix: 'sk-',       base: 'https://api.moonshot.cn/v1',           docs: 'https://platform.moonshot.cn', oaiCompat: true },
  { id: 'zhipu',        name: 'Zhipu (GLM)',          cat: 'llm',     prefix: '',          base: 'https://open.bigmodel.cn/api/paas/v4', docs: 'https://open.bigmodel.cn', oaiCompat: true },
  { id: 'alibaba',      name: 'Alibaba (Qwen)',       cat: 'llm',     prefix: 'sk-',       base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', docs: 'https://help.aliyun.com/dashscope', oaiCompat: true },
  { id: 'baidu',        name: 'Baidu (ERNIE)',        cat: 'llm',     prefix: '',          base: 'https://qianfan.baidubce.com',         docs: 'https://cloud.baidu.com/product/wenxinworkshop' },
  { id: 'minimax',      name: 'MiniMax',              cat: 'llm',     prefix: '',          base: 'https://api.minimax.chat',             docs: 'https://www.minimaxi.com' },
  { id: '01ai',         name: '01.AI (Yi)',           cat: 'llm',     prefix: '',          base: 'https://api.lingyiwanwu.com/v1',       docs: 'https://platform.lingyiwanwu.com', oaiCompat: true },

  // --- fast inference / open-weights hosts ---
  { id: 'groq',         name: 'Groq',                 cat: 'inference', prefix: 'gsk_',    base: 'https://api.groq.com/openai/v1',       docs: 'https://console.groq.com/docs', oaiCompat: true },
  { id: 'together',     name: 'Together AI',          cat: 'inference', prefix: '',        base: 'https://api.together.xyz/v1',          docs: 'https://docs.together.ai', oaiCompat: true },
  { id: 'fireworks',    name: 'Fireworks AI',         cat: 'inference', prefix: 'fw_',     base: 'https://api.fireworks.ai/inference/v1', docs: 'https://docs.fireworks.ai', oaiCompat: true },
  { id: 'deepinfra',    name: 'DeepInfra',            cat: 'inference', prefix: '',        base: 'https://api.deepinfra.com/v1/openai',  docs: 'https://deepinfra.com/docs', oaiCompat: true },
  { id: 'anyscale',     name: 'Anyscale',             cat: 'inference', prefix: 'esecret_', base: 'https://api.endpoints.anyscale.com/v1', docs: 'https://docs.anyscale.com', oaiCompat: true },
  { id: 'cerebras',     name: 'Cerebras',             cat: 'inference', prefix: 'csk-',    base: 'https://api.cerebras.ai/v1',           docs: 'https://inference-docs.cerebras.ai', oaiCompat: true },
  { id: 'sambanova',    name: 'SambaNova',            cat: 'inference', prefix: '',        base: 'https://api.sambanova.ai/v1',          docs: 'https://docs.sambanova.ai', oaiCompat: true },
  { id: 'hyperbolic',   name: 'Hyperbolic',           cat: 'inference', prefix: '',        base: 'https://api.hyperbolic.xyz/v1',        docs: 'https://docs.hyperbolic.xyz', oaiCompat: true },
  { id: 'novita',       name: 'Novita AI',            cat: 'inference', prefix: '',        base: 'https://api.novita.ai/v3/openai',      docs: 'https://novita.ai/docs', oaiCompat: true },
  { id: 'nebius',       name: 'Nebius AI',            cat: 'inference', prefix: '',        base: 'https://api.studio.nebius.ai/v1',      docs: 'https://docs.nebius.com', oaiCompat: true },
  { id: 'baseten',      name: 'Baseten',              cat: 'inference', prefix: '',        base: 'https://inference.baseten.co',         docs: 'https://docs.baseten.co' },
  { id: 'octoai',       name: 'OctoAI',               cat: 'inference', prefix: '',        base: 'https://text.octoai.run/v1',           docs: 'https://octo.ai/docs', oaiCompat: true },
  { id: 'featherless',  name: 'Featherless',          cat: 'inference', prefix: '',        base: 'https://api.featherless.ai/v1',        docs: 'https://featherless.ai', oaiCompat: true },

  // --- cloud platform model services ---
  { id: 'azure-openai', name: 'Azure OpenAI',         cat: 'cloud',   prefix: '',          base: '',                                     docs: 'https://learn.microsoft.com/azure/ai-services/openai' },
  { id: 'aws-bedrock',  name: 'AWS Bedrock',          cat: 'cloud',   prefix: '',          base: '',                                     docs: 'https://docs.aws.amazon.com/bedrock' },
  { id: 'vertex-ai',    name: 'Google Vertex AI',     cat: 'cloud',   prefix: '',          base: '',                                     docs: 'https://cloud.google.com/vertex-ai' },
  { id: 'cloudflare',   name: 'Cloudflare Workers AI', cat: 'cloud',  prefix: '',          base: 'https://api.cloudflare.com/client/v4', docs: 'https://developers.cloudflare.com/workers-ai' },
  { id: 'nvidia',       name: 'NVIDIA NIM',           cat: 'cloud',   prefix: 'nvapi-',    base: 'https://integrate.api.nvidia.com/v1',  docs: 'https://docs.nvidia.com/nim', oaiCompat: true },
  { id: 'lambda',       name: 'Lambda Labs',          cat: 'cloud',   prefix: '',          base: 'https://api.lambdalabs.com/v1',        docs: 'https://docs.lambdalabs.com', oaiCompat: true },
  { id: 'runpod',       name: 'RunPod',               cat: 'cloud',   prefix: '',          base: 'https://api.runpod.ai/v2',             docs: 'https://docs.runpod.io' },
  { id: 'modal',        name: 'Modal',                cat: 'cloud',   prefix: '',          base: '',                                     docs: 'https://modal.com/docs' },
  { id: 'aws',          name: 'AWS (IAM)',            cat: 'cloud',   prefix: 'AKIA',      base: 'https://sts.amazonaws.com',            docs: 'https://docs.aws.amazon.com/IAM' },

  // --- dev / infra ---
  { id: 'github',       name: 'GitHub',               cat: 'dev',     prefix: 'ghp_',      base: 'https://api.github.com',               docs: 'https://docs.github.com/rest' },

  // --- embeddings / rerank / search ---
  { id: 'voyage',       name: 'Voyage AI',            cat: 'embed',   prefix: 'pa-',       base: 'https://api.voyageai.com/v1',          docs: 'https://docs.voyageai.com' },
  { id: 'jina',         name: 'Jina AI',              cat: 'embed',   prefix: 'jina_',     base: 'https://api.jina.ai/v1',               docs: 'https://jina.ai' },

  // --- image / video / audio ---
  { id: 'fal',          name: 'fal.ai',               cat: 'media',   prefix: '',          base: 'https://fal.run',                      docs: 'https://fal.ai/docs' },
  { id: 'replicate',    name: 'Replicate',            cat: 'media',   prefix: 'r8_',       base: 'https://api.replicate.com/v1',         docs: 'https://replicate.com/docs' },
  { id: 'huggingface',  name: 'Hugging Face',         cat: 'media',   prefix: 'hf_',       base: 'https://api-inference.huggingface.co', docs: 'https://huggingface.co/docs' },
  { id: 'stability',    name: 'Stability AI',         cat: 'media',   prefix: 'sk-',       base: 'https://api.stability.ai',             docs: 'https://platform.stability.ai' },
  { id: 'recraft',      name: 'Recraft',              cat: 'media',   prefix: '',          base: 'https://external.api.recraft.ai',      docs: 'https://www.recraft.ai/docs' },
  { id: 'ideogram',     name: 'Ideogram',             cat: 'media',   prefix: '',          base: 'https://api.ideogram.ai',              docs: 'https://developer.ideogram.ai' },
  { id: 'luma',         name: 'Luma (Dream Machine)', cat: 'media',   prefix: 'luma-',     base: 'https://api.lumalabs.ai',              docs: 'https://docs.lumalabs.ai' },
  { id: 'runway',       name: 'Runway',               cat: 'media',   prefix: 'key_',      base: 'https://api.runwayml.com',             docs: 'https://docs.runwayml.com' },
  { id: 'elevenlabs',   name: 'ElevenLabs',           cat: 'audio',   prefix: 'sk_',       base: 'https://api.elevenlabs.io',            docs: 'https://elevenlabs.io/docs' },
  { id: 'deepgram',     name: 'Deepgram',             cat: 'audio',   prefix: '',          base: 'https://api.deepgram.com',             docs: 'https://developers.deepgram.com' },
  { id: 'assemblyai',   name: 'AssemblyAI',           cat: 'audio',   prefix: '',          base: 'https://api.assemblyai.com',           docs: 'https://www.assemblyai.com/docs' },
  { id: 'cartesia',     name: 'Cartesia',             cat: 'audio',   prefix: 'sk_car_',   base: 'https://api.cartesia.ai',              docs: 'https://docs.cartesia.ai' },
  { id: 'hume',         name: 'Hume AI',              cat: 'audio',   prefix: '',          base: 'https://api.hume.ai',                  docs: 'https://dev.hume.ai' },
  { id: 'lmnt',         name: 'LMNT',                 cat: 'audio',   prefix: '',          base: 'https://api.lmnt.com',                 docs: 'https://docs.lmnt.com' },
];

// id -> provider, for O(1) lookup/validation
export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function isKnownProvider(id) {
  return PROVIDER_BY_ID.has(id);
}
