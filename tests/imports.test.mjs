/**
 * Reply Guy — Runtime import smoke test
 *
 * The manifest test only checks that files exist. This one actually imports the
 * module graph the popup uses, with a chrome.* stub, so a bad export name or a
 * circular import fails here instead of in the browser.
 *
 * Run: node tests/imports.test.mjs
 */

import { pathToFileURL } from 'node:url';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}
function eq(name, a, b) {
  ok(name, JSON.stringify(a) === JSON.stringify(b),
    `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

// ─── Minimal chrome stub, enough to let the modules evaluate ─────────────────
// utils/storage.js is a classic script, not a module; popup.js references the
// global it defines, so we set it up before importing.
globalThis.chrome = {
  storage: { local: { get: (k, cb) => cb({}), set: (o, cb) => cb && cb(), remove: (k, cb) => cb && cb() } },
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { if (cb) cb({ ok: false }); return Promise.resolve(); },
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    getManifest: () => ({ version: '1.0.0' }),
  },
  tabs: {
    query: () => Promise.resolve([]),
    get: () => Promise.resolve({}),
    sendMessage: () => Promise.resolve({ ok: true }),
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
  },
  alarms: { onAlarm: { addListener: () => {} }, create: () => {}, clear: () => {} },
  action: { onClicked: { addListener: () => {} } },
  scripting: { executeScript: () => Promise.resolve() },
  sidePanel: { open: () => Promise.resolve() },
  permissions: {
    contains: () => Promise.resolve(false),
    request: () => Promise.resolve(true),
  },
};

globalThis.Storage = {
  getSettings: async () => ({}),
  saveSettings: async () => {},
  getDrafts: async () => [],
  clearDrafts: async () => {},
  getTheme: async () => 'dark',
  saveTheme: async () => {},
  get: async () => null,
  set: async () => {},
  remove: async () => {},
};

globalThis.document = {
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {},
  documentElement: { setAttribute: () => {}, getAttribute: () => 'dark' },
  createElement: () => ({ click: () => {}, style: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } }),
  body: { appendChild: () => {}, removeChild: () => {} },
};
globalThis.window = { getSelection: () => null };
// `navigator` is a read-only getter on the Node 22 global object.
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
  writable: true,
});

async function tryImport(label, relPath) {
  try {
    const mod = await import(pathToFileURL(join(ROOT, relPath)).href);
    ok(`imports cleanly: ${relPath}`, true);
    return mod;
  } catch (err) {
    ok(`imports cleanly: ${relPath}`, false, `${err.message}`);
    return null;
  }
}

// ─── lib modules ─────────────────────────────────────────────────────────────
const constants = await tryImport('constants', 'lib/constants.js');
const rules = await tryImport('rules', 'lib/rules.js');
const analyzer = await tryImport('analyzer', 'lib/analyzer.js');
const prompt = await tryImport('prompt', 'lib/prompt.js');
const providers = await tryImport('providers', 'lib/providers.js');

// ─── Verify the exports the consumers depend on ──────────────────────────────
if (constants) {
  ok('constants exports LANGUAGES', Array.isArray(constants.LANGUAGES));
  ok('constants has exactly 3 languages', constants.LANGUAGES.length === 3,
    JSON.stringify(constants.LANGUAGES.map(l => l.id)));
  ok('constants exports TONES', Array.isArray(constants.TONES));
  ok('constants has exactly 5 tones', constants.TONES.length === 5,
    JSON.stringify(constants.TONES.map(t => t.id)));
  ok('constants exports DEFAULTS', !!constants.DEFAULTS);
  ok('TWEET_QUERY_IDS is non-empty', constants.TWEET_QUERY_IDS.length > 0);

  // The user's exact spec.
  const langIds = constants.LANGUAGES.map(l => l.id);
  ok('language american english present', langIds.includes('en-US'));
  ok('language indonesia present', langIds.includes('id-ID'));
  ok('language mandarin simplified present', langIds.includes('zh-CN'));

  const toneIds = constants.TONES.map(t => t.id);
  for (const t of ['friendly', 'playful', 'formal', 'softselling', 'edukatif']) {
    ok(`tone ${t} present`, toneIds.includes(t));
  }
}

if (rules) {
  for (const name of ['findEmoji', 'findBannedPhrases', 'aiSmellScore', 'findSlang',
    'validateDraft', 'validateDraftSet', 'jaccard', 'charCount', 'SLANG_BANK']) {
    ok(`rules exports ${name}`, rules[name] !== undefined);
  }
  // Slang banks must be non-trivial for all three languages.
  for (const lang of ['en-US', 'id-ID', 'zh-CN']) {
    ok(`slang bank populated for ${lang}`,
      Array.isArray(rules.SLANG_BANK[lang]) && rules.SLANG_BANK[lang].length >= 20,
      `${rules.SLANG_BANK[lang]?.length} entries`);
  }
}

if (analyzer) {
  ok('analyzer exports analyzeTweet', typeof analyzer.analyzeTweet === 'function');
  ok('analyzer exports summarizeAnalysis', typeof analyzer.summarizeAnalysis === 'function');
}

if (prompt) {
  for (const name of ['buildSystemPrompt', 'buildUserPrompt', 'buildRepairPrompt', 'TONE_SPECS']) {
    ok(`prompt exports ${name}`, prompt[name] !== undefined);
  }
  ok('TONE_SPECS covers all 5 tones', Object.keys(prompt.TONE_SPECS).length === 5,
    JSON.stringify(Object.keys(prompt.TONE_SPECS)));
}

if (providers) {
  for (const name of ['PROVIDERS', 'PROVIDER_ORDER', 'PRESET_PROVIDERS', 'getProvider',
    'validateProviderConfig', 'needsSetup', 'extractJSON', 'chatCompletion',
    'testConnection', 'listModels', 'retryDelay']) {
    ok(`providers exports ${name}`, providers[name] !== undefined);
  }

  // The two-option setup the user asked for.
  eq('exactly five preset providers',
    providers.PRESET_PROVIDERS, ['deepseek', 'kimi', 'glm', 'gemini', 'chatgpt']);
  ok('custom provider registered', !!providers.PROVIDERS.custom);
  ok('no leftover vendor ids',
    !providers.PROVIDERS.openrouter && !providers.PROVIDERS.groq &&
    !providers.PROVIDERS.google && !providers.PROVIDERS.openai &&
    !providers.PROVIDERS.local,
    Object.keys(providers.PROVIDERS).join(','));
}

// ─── Cross-module contract: prompt + rules agree on tone ids ─────────────────
if (constants && prompt) {
  const constantsTones = constants.TONES.map(t => t.id).sort();
  const promptTones = Object.keys(prompt.TONE_SPECS).sort();
  ok('tone ids match between constants and prompt',
    JSON.stringify(constantsTones) === JSON.stringify(promptTones),
    `constants=${constantsTones} prompt=${promptTones}`);
}

// ─── The popup's import specifiers must be resolvable ────────────────────────
// popup.js imports from '../lib/...' — confirm each target exports what it needs.
if (constants && rules && providers) {
  ok('popup can reach LANGUAGES via constants', constants.LANGUAGES.length === 3);
  ok('popup can reach TONES via constants', constants.TONES.length === 5);
  ok('popup can reach DEFAULTS via constants', !!constants.DEFAULTS);
  ok('popup can reach PROVIDERS via providers', !!providers.PROVIDERS);
  ok('popup can reach PROVIDER_ORDER via providers', Array.isArray(providers.PROVIDER_ORDER));
  ok('popup can reach getProvider via providers', typeof providers.getProvider === 'function');
  ok('popup can reach validateProviderConfig via providers',
    typeof providers.validateProviderConfig === 'function');
  ok('popup can reach validateDraftSet via rules', typeof rules.validateDraftSet === 'function');
}

// ─── Background's imports ────────────────────────────────────────────────────
if (constants && prompt && rules && analyzer && providers) {
  ok('background can build system prompt', typeof prompt.buildSystemPrompt === 'function');
  ok('background can build user prompt', typeof prompt.buildUserPrompt === 'function');
  ok('background can build repair prompt', typeof prompt.buildRepairPrompt === 'function');
  ok('background can validate draft sets', typeof rules.validateDraftSet === 'function');
  ok('background can validate single drafts', typeof rules.validateDraft === 'function');
  ok('background can analyze tweets', typeof analyzer.analyzeTweet === 'function');
  ok('background can call chatCompletion', typeof providers.chatCompletion === 'function');
  ok('background can test a connection', typeof providers.testConnection === 'function');
  ok('background can validate provider config', typeof providers.validateProviderConfig === 'function');
  ok('background can extract json', typeof providers.extractJSON === 'function');
  ok('background can list models', typeof providers.listModels === 'function');
  ok('background can read provider config', typeof providers.getProvider === 'function');
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  x ' + f);
}
process.exit(fail === 0 ? 0 : 1);
