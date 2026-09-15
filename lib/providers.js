/**
 * Reply Guy — LLM provider registry
 *
 * Two ways to plug in a model:
 *   1. Pick one of the five named providers and paste its API key.
 *   2. Pick "Custom" and fill in base URL + model (+ key if needed).
 *
 * Every one of the five speaks the OpenAI Chat Completions wire format, so a
 * single adapter covers all of them. Gemini and Kimi are reached through their
 * OpenAI-compatibility endpoints.
 *
 * The service worker imports this file, so keep it dependency-free.
 */

/**
 * The named providers. Order here is the order shown in the UI.
 *
 * `models` is what the dropdown offers. `defaultModel` is preselected.
 * `keyHint` is the prefix shown in the placeholder so users can sanity-check
 * that they pasted the right vendor's key.
 * `docs` is where to go get the key.
 */
export const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHint: 'sk-...',
    keyRequired: true,
    docs: 'https://platform.deepseek.com/api_keys',
    note: 'Cheap and strong at casual/informal writing. Good default.',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/v1',
    defaultModel: 'kimi-k2-0905-preview',
    models: [
      'kimi-k2-0905-preview',
      'kimi-k2-turbo-preview',
      'moonshot-v1-8k',
      'moonshot-v1-32k',
      'moonshot-v1-128k',
    ],
    keyHint: 'sk-...',
    keyRequired: true,
    docs: 'https://platform.moonshot.ai/console/api-keys',
    note: 'Handles Chinese slang and Mandarin tone naturally.',
  },
  glm: {
    id: 'glm',
    label: 'GLM (Zhipu)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-4.5-flash',
    models: ['glm-4.5-flash', 'glm-4.5', 'glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    keyHint: 'xxxxx.xxxxx',
    keyRequired: true,
    docs: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'Key format is id.secret. Free tier available on the flash models.',
  },
  gemini: {
    id: 'gemini',
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.0-flash',
    models: [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
    ],
    keyHint: 'AIza...',
    keyRequired: true,
    docs: 'https://aistudio.google.com/apikey',
    note: 'Free tier is generous. Uses the OpenAI-compatibility endpoint.',
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT (OpenAI)',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini'],
    keyHint: 'sk-...',
    keyRequired: true,
    docs: 'https://platform.openai.com/api-keys',
    note: 'Most consistent at following the no-emoji and slang rules.',
  },
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    defaultModel: '',
    models: [],
    keyHint: 'optional',
    keyRequired: false,
    docs: '',
    note: 'Any endpoint that speaks /chat/completions. OpenRouter, Groq, Together, Ollama, llama.cpp, LM Studio, vLLM.',
  },
};

/** Display order for the UI. */
export const PROVIDER_ORDER = ['deepseek', 'kimi', 'glm', 'gemini', 'chatgpt', 'custom'];

/** The five key-only providers, i.e. everything except custom. */
export const PRESET_PROVIDERS = PROVIDER_ORDER.filter(id => id !== 'custom');

/**
 * Aliases for provider ids that appeared in older settings or in the docs of
 * other tools. Keeps a saved config from silently pointing at the wrong vendor.
 */
const PROVIDER_ALIASES = {
  openai: 'chatgpt',
  google: 'gemini',
  'google-gemini': 'gemini',
  moonshot: 'kimi',
  zhipu: 'glm',
  bigmodel: 'glm',
};

/** Resolves a raw provider id (possibly an alias) to a registry entry. */
export function getProvider(id) {
  const key = PROVIDER_ALIASES[id] || id;
  return PROVIDERS[key] || PROVIDERS.deepseek;
}

/**
 * Validates a settings-shaped object before any network call is made, so the
 * user gets "paste your DeepSeek key" instead of a 401 from the model.
 *
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateProviderConfig(settings) {
  const p = getProvider(settings?.provider);

  if (!p || !PROVIDERS[p.id]) {
    return { ok: false, error: 'Pick an AI provider first.' };
  }

  if (p.id === 'custom') {
    const base = String(settings?.baseUrl || '').trim();
    if (!base) return { ok: false, error: 'Custom provider needs a base URL.' };
    if (!/^https?:\/\//i.test(base)) {
      return { ok: false, error: 'Base URL must start with http:// or https://.' };
    }
    if (!String(settings?.model || '').trim()) {
      return { ok: false, error: 'Custom provider needs a model name.' };
    }
    return { ok: true };
  }

  if (p.keyRequired && !String(settings?.apiKey || '').trim()) {
    return { ok: false, error: `Paste your ${p.label} API key first.` };
  }

  return { ok: true };
}

/**
 * True when the user has not finished setup. Used to gate the main UI behind
 * the setup panel.
 */
export function needsSetup(settings) {
  return !validateProviderConfig(settings).ok;
}

/**
 * Extracts the first balanced JSON object from a model response.
 * Handles markdown fences, leading prose, and trailing commentary.
 */
export function extractJSON(raw) {
  if (!raw) throw new Error('Empty model response');
  let s = String(raw).trim();

  // Strip markdown fences.
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  // Fast path.
  try { return JSON.parse(s); } catch { /* fall through */ }

  // Scan for the first balanced {...} accounting for strings and escapes.
  const start = s.indexOf('{');
  if (start === -1) throw new Error('No JSON object in response');

  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        try { return JSON.parse(candidate); }
        catch (e) {
          // Common LLM sin: trailing commas.
          const cleaned = candidate.replace(/,\s*([}\]])/g, '$1');
          try { return JSON.parse(cleaned); } catch { throw new Error('Malformed JSON from model'); }
        }
      }
    }
  }
  throw new Error('Unterminated JSON from model');
}

/**
 * One chat completion. Returns the message content string.
 *
 * @param {object} cfg  { baseUrl, apiKey, model, provider }
 * @param {object} req  { system, user, temperature, maxTokens, jsonMode }
 */
export async function chatCompletion(cfg, req, { timeoutMs = 60000 } = {}) {
  const provider = getProvider(cfg.provider);
  const base = (cfg.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('No base URL configured. Open Settings.');

  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
  if (provider.extraHeaders) Object.assign(headers, provider.extraHeaders());

  const body = {
    model: cfg.model || provider.defaultModel,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    temperature: req.temperature ?? 0.95,
    max_tokens: req.maxTokens ?? 1400,
  };

  // Only the vendors documented to honour it get the flag. Sending it to an
  // endpoint that does not implement it returns a 400.
  if (req.jsonMode && cfg.provider === 'chatgpt') {
    body.response_format = { type: 'json_object' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
    let host = base;
    try { host = new URL(base).host; } catch { /* keep raw base */ }
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Could not reach ${host} (${cause}). Check the base URL.`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || detail;
    } catch { /* keep raw */ }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Auth failed (${res.status}). Check your API key. ${detail}`);
    }
    if (res.status === 402) {
      throw new Error(`Out of credit (402). Top up your account. ${detail}`);
    }
    if (res.status === 404) {
      throw new Error(`Model or endpoint not found (404). Check that the model name exists for this provider. ${detail}`);
    }
    if (res.status === 429) {
      throw new Error(`Rate limited (429). Wait a moment or switch to a cheaper model. ${detail}`);
    }
    throw new Error(`API error ${res.status}: ${detail}`);
  }

  const json = await res.json();
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  if (!content) throw new Error('Model returned no content');
  return content;
}

/**
 * Cheap credential check. Sends a tiny request so the user finds out
 * immediately whether the key works, instead of after they wrote a tweet.
 */
export async function testConnection(cfg, { timeoutMs = 20000 } = {}) {
  const check = validateProviderConfig(cfg);
  if (!check.ok) throw new Error(check.error);

  const provider = getProvider(cfg.provider);
  const base = (cfg.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let response;
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: cfg.model || provider.defaultModel,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        max_tokens: 5,
        temperature: 0,
      }),
    });
    clearTimeout(timer);
    response = res;
  } catch (err) {
    clearTimeout(timer);
    // Only transport failures land here. HTTP errors are classified below so a
    // 401 is never reported as "could not reach the host".
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${timeoutMs / 1000}s. Check that the base URL is reachable.`);
    }
    let host = base;
    try { host = new URL(base).host; } catch { /* keep raw base */ }
    const cause = err.cause?.code || err.cause?.message || err.message;
    throw new Error(`Could not reach ${host} (${cause}). Check the base URL and that the server is running.`);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message || j?.message || detail;
    } catch { /* keep raw */ }
    if (response.status === 401 || response.status === 403) throw new Error(`Key rejected (${response.status}). ${detail}`);
    if (response.status === 402) throw new Error(`No credit on this account (402). ${detail}`);
    if (response.status === 404) throw new Error(`Model "${cfg.model}" not found for this provider. ${detail}`);
    if (response.status === 429) throw new Error(`Rate limited right now (429). The key works, try again shortly. ${detail}`);
    throw new Error(`HTTP ${response.status}: ${detail}`);
  }

  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content;
  return {
    ok: true,
    model: cfg.model || provider.defaultModel,
    sample: String(content || '').slice(0, 40),
  };
}

/**
 * Delay for retry attempt N. Jittered exponential backoff, capped at 15s.
 */
export function retryDelay(attempt, baseMs = 800) {
  const exp = Math.min(baseMs * Math.pow(2, attempt), 15000);
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/**
 * Lists models from an OpenAI-compatible /models endpoint.
 * Best-effort: many providers block or omit it.
 */
export async function listModels(cfg, { timeoutMs = 15000 } = {}) {
  const provider = getProvider(cfg.provider);
  const base = (cfg.baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('No base URL configured');

  const headers = {};
  if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const ids = (json?.data || []).map(m => m.id).filter(Boolean);
    return ids.sort();
  } catch (err) {
    clearTimeout(timer);
    throw new Error(`Could not list models: ${err.message}`);
  }
}
