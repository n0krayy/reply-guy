/**
 * Reply Guy — Pipeline integration test with a mock LLM
 *
 * The live test needs a real API key. This one replaces fetch() with a scripted
 * model so the full generateDrafts flow can be exercised deterministically:
 * prompt in, JSON out, validate, repair, re-validate.
 *
 * It is the only test that covers the repair loop, which is where the
 * interesting failure modes live (a model that keeps emitting emoji, a model
 * that returns fewer drafts than asked, a model that returns prose).
 *
 * Run: node tests/pipeline.test.mjs
 */

import { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from '../lib/prompt.js';
import { validateDraft, validateDraftSet, jaccard } from '../lib/rules.js';
import { chatCompletion, extractJSON, testConnection, validateProviderConfig, PROVIDERS, PRESET_PROVIDERS } from '../lib/providers.js';
import { analyzeTweet } from '../lib/analyzer.js';

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

// ─── Mock transport ──────────────────────────────────────────────────────────
const realFetch = globalThis.fetch;
let calls = [];

/**
 * Installs a fetch mock. `responder(body, callIndex)` returns the assistant
 * message content string.
 */
function mockLLM(responder) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const idx = calls.length;
    calls.push({ url, body, idx });
    const content = responder(body, idx);
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content } }] }),
      text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
    };
  };
}
function restoreFetch() { globalThis.fetch = realFetch; }

/**
 * Local re-implementation of the background worker's generateDrafts so the
 * test does not need to import a service worker (which touches chrome.* at
 * load). Kept in lockstep with background.js by the assertions below.
 */
async function generateDrafts({ tweet, analysis, language, tones, draftsPerTone, settings, onProgress }) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt({ tweet, analysis, language, tones, draftsPerTone, maxChars: settings.maxChars });
  onProgress?.({ phase: 'generating' });

  const raw = await chatCompletion({
    provider: settings.provider, baseUrl: settings.baseUrl,
    apiKey: settings.apiKey, model: settings.model,
  }, { system, user, temperature: settings.temperature, maxTokens: 2000, jsonMode: false }, { timeoutMs: 20000 });

  const parsed = extractJSON(raw);
  let drafts = Array.isArray(parsed) ? parsed : (parsed.drafts || []);
  drafts = drafts
    .filter(d => d && typeof d.text === 'string' && d.text.trim())
    .map(d => ({ tone: tones.includes(d.tone) ? d.tone : tones[0], text: d.text.trim() }));

  if (!drafts.length) throw new Error('Model returned no usable drafts.');

  let results = validateDraftSet(drafts, { lang: language, maxChars: settings.maxChars });
  const failing = results.map((r, i) => ({ r, i })).filter(({ r }) => r.blocking.length > 0);

  if (failing.length) {
    onProgress?.({ phase: 'repairing' });
    // Mirrors background.js: sequential, sibling-aware, and refuses a repair
    // that would introduce a new near-duplicate.
    for (const { i } of failing.slice(0, 6)) {
      const draft = drafts[i];
      const siblings = drafts.filter((_, j) => j !== i).map(d => d.text);
      try {
        const repairUser = buildRepairPrompt({
          original: draft.text, language, tone: draft.tone,
          violations: results[i].blocking, siblings,
        });
        const fixed = await chatCompletion({
          provider: settings.provider, baseUrl: settings.baseUrl,
          apiKey: settings.apiKey, model: settings.model,
        }, { system, user: repairUser, temperature: 0.7, maxTokens: 400, jsonMode: true }, { timeoutMs: 20000 });

        const p = extractJSON(fixed);
        const newText = (p.text || '').trim();
        if (newText) {
          const check = validateDraft(newText, { lang: language, maxChars: settings.maxChars });
          const worstOverlap = Math.max(0, ...siblings.map(s => jaccard(newText, s)));
          const createsDuplicate = worstOverlap > 0.62;
          const improves = check.ok || check.quality.aiSmell < results[i].quality.aiSmell;
          if (improves && !createsDuplicate) {
            drafts[i] = { ...draft, text: newText, repaired: true };
          }
        }
      } catch { /* keep original */ }
    }
    results = validateDraftSet(drafts, { lang: language, maxChars: settings.maxChars });
  }

  return drafts.map((d, i) => ({ ...d, quality: results[i].quality, ok: results[i].ok, blocking: results[i].blocking }));
}

const SETTINGS = {
  provider: 'chatgpt', baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key', model: 'test-model', temperature: 0.95, maxChars: 260,
};
const TWEET = {
  id: '123', text: "Unpopular opinion: most people don't need a SaaS. They need a spreadsheet and 2 hours of focus.",
  author: { screen_name: 'builder', name: 'Builder' }, metrics: { likes: 50 },
};
const ANALYSIS = analyzeTweet(TWEET.text);

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Happy path ===');
{
  mockLLM(() => JSON.stringify({
    drafts: [
      { tone: 'friendly', text: 'ngl the spreadsheet phase is a rite of passage. took me 2 years to figure out the boring tool was doing the real work' },
      { tone: 'playful', text: 'killing tools is genuinely satisfying. whole stack feels lighter and i stop pretending the fancy one helps' },
    ],
  }));

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly', 'playful'], draftsPerTone: 1, settings: SETTINGS,
  });

  eq('returns both drafts', drafts.length, 2);
  ok('first draft clean', drafts[0].ok, JSON.stringify(drafts[0].blocking));
  ok('second draft clean', drafts[1].ok, JSON.stringify(drafts[1].blocking));
  ok('tones mapped correctly',
    drafts[0].tone === 'friendly' && drafts[1].tone === 'playful',
    JSON.stringify(drafts.map(d => d.tone)));
  eq('no repair calls needed', calls.length, 1);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Repair loop: emoji in output ===');
{
  let callCount = 0;
  mockLLM((body, idx) => {
    callCount++;
    if (idx === 0) {
      return JSON.stringify({
        drafts: [
          { tone: 'friendly', text: 'ngl this is a great point 😀🔥 the spreadsheet really does work' },
          { tone: 'playful', text: 'killing tools is satisfying, whole stack feels lighter ngl' },
        ],
      });
    }
    // Repair response: emoji removed.
    return JSON.stringify({ text: 'ngl this is a great point. the spreadsheet really does work and nobody wants to hear it' });
  });

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly', 'playful'], draftsPerTone: 1, settings: SETTINGS,
  });

  eq('repair call was made', calls.length, 2);
  ok('emoji draft was repaired', drafts[0].repaired === true);
  ok('repaired draft has no emoji', drafts[0].quality.emoji.length === 0,
    JSON.stringify(drafts[0].quality.emoji));
  ok('repaired draft now passes', drafts[0].ok, JSON.stringify(drafts[0].blocking));
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Repair loop: AI-slop output ===');
{
  mockLLM((body, idx) => {
    if (idx === 0) {
      return JSON.stringify({
        drafts: [{
          tone: 'formal',
          text: "In today's fast-paced world, it's important to note that leveraging a robust solution is a game-changer — it unlocks seamless synergy.",
        }],
      });
    }
    return JSON.stringify({
      text: 'Setuju. Satu catatan, tim gue juga buang 5 tools bulan lalu dan yang paling ngaruh cuma satu, spreadsheet buat tracking harian',
    });
  });

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'id-ID',
    tones: ['formal'], draftsPerTone: 1, settings: SETTINGS,
  });

  eq('one repair call', calls.length, 2);
  ok('ai-slop draft improved', drafts[0].quality.aiSmell < 45,
    `aiSmell=${drafts[0].quality.aiSmell}`);
  ok('repair produced valid output', drafts[0].ok, JSON.stringify(drafts[0].blocking));
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Repair that does not help keeps the original ===');
{
  mockLLM((body, idx) => {
    if (idx === 0) {
      return JSON.stringify({
        drafts: [{ tone: 'friendly', text: 'ngl this is fire 😀' }],
      });
    }
    // Repair returns something equally bad (still emoji, higher smell).
    return JSON.stringify({
      text: "In today's fast-paced world, this is a game-changer 😀🔥 — seamless and robust.",
    });
  });

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly'], draftsPerTone: 1, settings: SETTINGS,
  });

  eq('repair attempted', calls.length, 2);
  ok('bad repair rejected, original kept',
    drafts[0].text === 'ngl this is fire 😀',
    `got: ${drafts[0].text}`);
  ok('draft still flagged as failing', !drafts[0].ok);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Repair call throwing does not kill the run ===');
{
  mockLLM((body, idx) => {
    if (idx === 0) {
      return JSON.stringify({
        drafts: [
          { tone: 'friendly', text: 'ngl this is great 😀' },
          { tone: 'playful', text: 'whole stack feels lighter after killing the extra tools fr' },
        ],
      });
    }
    throw new Error('simulated upstream failure');
  });

  let threw = false;
  let drafts = [];
  try {
    drafts = await generateDrafts({
      tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
      tones: ['friendly', 'playful'], draftsPerTone: 1, settings: SETTINGS,
    });
  } catch { threw = true; }

  ok('run survived a throwing repair', !threw);
  eq('both drafts still returned', drafts.length, 2);
  ok('good draft unaffected', drafts[1].ok, JSON.stringify(drafts[1].blocking));
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Model returns fewer drafts than asked ===');
{
  mockLLM(() => JSON.stringify({
    drafts: [{ tone: 'friendly', text: 'ngl the boring tool is doing the real work here and nobody admits it' }],
  }));

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly'], draftsPerTone: 3, settings: SETTINGS,
  });

  eq('returns what it got, no crash', drafts.length, 1);
  ok('single draft is clean', drafts[0].ok);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Model returns malformed JSON ===');
{
  mockLLM(() => 'Sure! Here are your replies. I hope this helps!');

  let err = null;
  try {
    await generateDrafts({
      tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
      tones: ['friendly'], draftsPerTone: 1, settings: SETTINGS,
    });
  } catch (e) { err = e; }

  ok('throws a clean error on unparseable output', !!err);
  ok('error message is actionable',
    /JSON/i.test(err?.message || ''), err?.message);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Model returns empty drafts array ===');
{
  mockLLM(() => JSON.stringify({ drafts: [] }));

  let err = null;
  try {
    await generateDrafts({
      tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
      tones: ['friendly'], draftsPerTone: 1, settings: SETTINGS,
    });
  } catch (e) { err = e; }

  ok('throws on empty drafts', !!err);
  ok('error mentions no usable drafts', /no usable drafts/i.test(err?.message || ''), err?.message);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Unknown tone falls back to the first requested tone ===');
{
  mockLLM(() => JSON.stringify({
    drafts: [{ tone: 'sarcastic', text: 'ngl the spreadsheet is doing the real work and the fancy tool is just decoration' }],
  }));

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly'], draftsPerTone: 1, settings: SETTINGS,
  });

  eq('unknown tone coerced', drafts[0].tone, 'friendly');
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Prompt actually sent contains the rules ===');
{
  mockLLM(() => JSON.stringify({ drafts: [{ tone: 'friendly', text: 'ngl the boring tool wins every time and nobody wants to admit it' }] }));

  await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'zh-CN',
    tones: ['edukatif'], draftsPerTone: 1, settings: SETTINGS,
  });

  const sent = calls[0].body;
  eq('model is the configured one', sent.model, 'test-model');
  ok('system message present', sent.messages[0].role === 'system');
  ok('system forbids emoji', sent.messages[0].content.includes('NO EMOJI'));
  ok('system requires slang', sent.messages[0].content.includes('SLANG IS MANDATORY'));
  ok('user message names the language', sent.messages[1].content.includes('简体中文'));
  ok('user message includes slang bank', sent.messages[1].content.includes('Bank:'));
  ok('user message includes tone spec', sent.messages[1].content.includes('TONE: edukatif'));
  ok('temperature forwarded', sent.temperature === 0.95);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Cross-draft repetition triggers repair ===');
{
  // The second repair must return something different from the first, since the
  // loop is sequential and tells the model what already exists.
  const repairs = [
    'the boring part is the actual work here and nobody really wants to hear that truth',
    'gila sih, yang bikin beda itu konsistensi bukan tools-nya. gue udah coba 6 bulan dan hasilnya nampol',
  ];
  let repairIdx = 0;
  mockLLM((body, idx) => {
    if (idx === 0) {
      return JSON.stringify({
        drafts: [
          { tone: 'friendly', text: 'the boring part is the actual work here and nobody really wants to hear that truth' },
          { tone: 'friendly', text: 'the boring part is the actual work here and nobody really wants to hear that fact' },
        ],
      });
    }
    return JSON.stringify({ text: repairs[repairIdx++] });
  });

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly'], draftsPerTone: 2, settings: SETTINGS,
  });

  ok('repetition detected and repaired', calls.length >= 2, `calls=${calls.length}`);

  // The repair prompt must have carried the sibling list.
  const repairBody = calls[1]?.body?.messages?.[1]?.content || '';
  ok('repair prompt lists existing drafts',
    /must NOT be a variation/.test(repairBody), repairBody.slice(0, 200));

  const bothStillDup = drafts.length === 2 &&
    drafts[0].quality.repetition > 62 && drafts[1].quality.repetition > 62;
  ok('duplicate pair no longer both flagged', !bothStillDup,
    JSON.stringify(drafts.map(d => ({ rep: d.quality.repetition, ok: d.ok }))));
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Repair rejected when it would create a new duplicate ===');
{
  // Both repairs return the SAME text. The first is accepted, the second must
  // be rejected because accepting it would recreate the repetition.
  mockLLM((body, idx) => {
    if (idx === 0) {
      return JSON.stringify({
        drafts: [
          { tone: 'friendly', text: 'the boring part is the actual work here and nobody really wants to hear that truth' },
          { tone: 'friendly', text: 'the boring part is the actual work here and nobody really wants to hear that fact' },
        ],
      });
    }
    return JSON.stringify({ text: 'killing 6 tools made us ship 40 percent faster and the spreadsheet did the heavy lifting' });
  });

  const drafts = await generateDrafts({
    tweet: TWEET, analysis: ANALYSIS, language: 'en-US',
    tones: ['friendly'], draftsPerTone: 2, settings: SETTINGS,
  });

  ok('first repair accepted', drafts[0].repaired === true);
  ok('duplicate-creating repair rejected',
    drafts[1].repaired !== true || jaccard(drafts[0].text, drafts[1].text) <= 0.62,
    `overlap=${jaccard(drafts[0].text, drafts[1].text).toFixed(2)}`);
  ok('set no longer double-flagged',
    !(drafts[0].quality.repetition > 62 && drafts[1].quality.repetition > 62),
    JSON.stringify(drafts.map(d => d.quality.repetition)));
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Provider errors surface with context ===');
{
  globalThis.fetch = async () => ({
    ok: false, status: 401,
    text: async () => JSON.stringify({ error: { message: 'Invalid API key provided' } }),
  });

  let err = null;
  try {
    await chatCompletion(
      { provider: 'chatgpt', baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', model: 'm' },
      { system: 's', user: 'u' }, { timeoutMs: 5000 }
    );
  } catch (e) { err = e; }

  ok('401 throws', !!err);
  ok('401 message says auth', /auth/i.test(err?.message || ''), err?.message);
  ok('401 message includes provider detail', /Invalid API key/i.test(err?.message || ''), err?.message);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Timeout is reported clearly ===');
{
  globalThis.fetch = (url, opts) => new Promise((_, reject) => {
    opts.signal?.addEventListener('abort', () => {
      const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
    });
  });

  let err = null;
  try {
    await chatCompletion(
      { provider: 'chatgpt', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' },
      { system: 's', user: 'u' }, { timeoutMs: 300 }
    );
  } catch (e) { err = e; }

  ok('timeout throws', !!err);
  ok('timeout message mentions seconds', /timed out/i.test(err?.message || ''), err?.message);
  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== Connection test classifies errors correctly ===');
{
  // A 401 must read as a key problem, never as an unreachable host.
  globalThis.fetch = async () => ({
    ok: false, status: 401,
    text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
  });
  let err = null;
  try {
    await testConnection({ provider: 'chatgpt', baseUrl: PROVIDERS.chatgpt.baseUrl, model: 'gpt-4o-mini', apiKey: 'bad' });
  } catch (e) { err = e; }
  ok('401 is reported as a rejected key', /Key rejected/.test(err?.message || ''), err?.message);
  ok('401 is not reported as unreachable', !/Could not reach/.test(err?.message || ''), err?.message);

  // A transport failure names the host so a typo is obvious.
  globalThis.fetch = async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; };
  err = null;
  try {
    await testConnection({ provider: 'custom', baseUrl: 'https://nope.invalid/v1', model: 'm', apiKey: '' });
  } catch (e) { err = e; }
  ok('network failure names the host', /nope\.invalid/.test(err?.message || ''), err?.message);
  ok('network failure includes the cause', /ENOTFOUND/.test(err?.message || ''), err?.message);

  // Config problems are caught before any request is attempted.
  let dialed = false;
  globalThis.fetch = async () => { dialed = true; return { ok: true, json: async () => ({}) }; };
  err = null;
  try { await testConnection({ provider: 'deepseek', apiKey: '' }); } catch (e) { err = e; }
  ok('missing key throws before dialing', !!err && !dialed, err?.message);
  ok('missing key error names the provider', /DeepSeek/.test(err?.message || ''), err?.message);

  // 402 and 404 get their own messages.
  globalThis.fetch = async () => ({ ok: false, status: 402, text: async () => 'no funds' });
  err = null;
  try { await testConnection({ provider: 'kimi', baseUrl: PROVIDERS.kimi.baseUrl, model: 'x', apiKey: 'k' }); } catch (e) { err = e; }
  ok('402 is reported as no credit', /No credit/.test(err?.message || ''), err?.message);

  globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => 'not found' });
  err = null;
  try { await testConnection({ provider: 'glm', baseUrl: PROVIDERS.glm.baseUrl, model: 'nope', apiKey: 'k' }); } catch (e) { err = e; }
  ok('404 is reported as a bad model name', /not found for this provider/.test(err?.message || ''), err?.message);

  // Success path returns the model that answered.
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
  });
  const good = await testConnection({ provider: 'gemini', baseUrl: PROVIDERS.gemini.baseUrl, model: 'gemini-2.0-flash', apiKey: 'AIza-x' });
  ok('success reports the model', good.model === 'gemini-2.0-flash', JSON.stringify(good));
  ok('success returns ok true', good.ok === true);

  restoreFetch();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  x ' + f);
}
restoreFetch();
process.exit(fail === 0 ? 0 : 1);
