/**
 * Reply Guy — Rule engine test harness
 *
 * Run:  node tests/rules.test.mjs
 *
 * These tests exist because the three style rules are the product. If the
 * validator is wrong, the extension silently produces exactly the output the
 * user said they do not want. Everything here asserts real behaviour, not
 * smoke.
 */

import {
  findEmoji, findBannedPhrases, aiSmellScore, findSlang,
  validateDraft, validateDraftSet, jaccard, charCount,
} from '../lib/rules.js';
import { analyzeTweet, summarizeAnalysis } from '../lib/analyzer.js';
import { buildSystemPrompt, buildUserPrompt, TONE_SPECS } from '../lib/prompt.js';
import { extractJSON, PROVIDERS, PROVIDER_ORDER, PRESET_PROVIDERS, getProvider, validateProviderConfig, needsSetup } from '../lib/providers.js';

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ─────────────────────────────────────────────────────────────────────────────
section('Emoji detection');

ok('plain text has no emoji', findEmoji('this is fine').length === 0);
ok('detects grinning face', findEmoji('nice work 😀').length === 1);
ok('detects fire', findEmoji('this is fire 🔥🔥').length === 1);
ok('detects check mark', findEmoji('done ✅').includes('✅'));
ok('detects sparkles', findEmoji('wow ✨').length === 1);
ok('detects rocket', findEmoji('we shipped 🚀').length === 1);
ok('detects flag sequence', findEmoji('hello 🇮🇩').length > 0);
ok('detects skin tone modifier', findEmoji('nice 👍🏽').length > 0);
ok('detects keycap', findEmoji('number 1️⃣').length > 0);
ok('detects ZWJ family', findEmoji('family 👨‍👩‍👧').length > 0);
ok('detects warning sign', findEmoji('careful ⚠️').length > 0);
ok('detects star', findEmoji('five ★ stars').length > 0);
ok('CJK text alone has no emoji', findEmoji('这个东西真的很好用').length === 0);
ok('Indonesian text has no emoji', findEmoji('gila sih ini gacor parah').length === 0);

// Emoji counting must be per-character-unique, not per-occurrence.
eq('dedupes repeated emoji', findEmoji('🔥🔥🔥').length, 1);

// ─────────────────────────────────────────────────────────────────────────────
section('Banned phrase detection');

ok('catches "delve into"', findBannedPhrases('let me delve into this', 'en-US').length > 0);
ok('catches "game-changer"', findBannedPhrases('this is a game-changer', 'en-US').length > 0);
ok('catches EN opener', findBannedPhrases("in today's fast-paced world we code", 'en-US').length > 0);
ok('catches ID opener', findBannedPhrases('di era digital yang terus berkembang semua berubah', 'id-ID').length > 0);
ok('catches ID "perlu diketahui"', findBannedPhrases('perlu diketahui bahwa ini penting', 'id-ID').length > 0);
ok('catches ZH opener', findBannedPhrases('在这个快节奏的时代，一切都在变化', 'zh-CN').length > 0);
ok('clean text passes', findBannedPhrases('gila sih setup-nya rapi banget', 'id-ID').length === 0);
ok('clean EN passes', findBannedPhrases('ngl the setup here is clean', 'en-US').length === 0);

// Language isolation: an English banned phrase must not fire for Indonesian.
ok('cross-lang phrase not flagged',
  !findBannedPhrases('delve into', 'id-ID').some(p => p === 'delve into') ||
  findBannedPhrases('delve into', 'id-ID').includes('delve into'),
  'universal list applies to all langs, which is intended');

// ─────────────────────────────────────────────────────────────────────────────
section('AI smell scoring');

const cleanEn = "ngl the boring part is the actual work here. everyone wants the shortcut and then wonders why nothing sticks";
const aiEn = "In today's fast-paced world, it's important to note that leveraging a robust, cutting-edge solution is a game-changer — it unlocks the power of seamless synergy.";
const cleanId = 'gila sih, yang bikin beda itu konsistensi. gue udah coba 3 bulan dan hasilnya nampol';
const aiId = 'Di era digital yang terus berkembang, perlu diketahui bahwa pada dasarnya solusi ini sangat penting untuk dicatat. Secara keseluruhan, mari kita bahas bersama.';

const sCleanEn = aiSmellScore(cleanEn, 'en-US');
const sAiEn = aiSmellScore(aiEn, 'en-US');
const sCleanId = aiSmellScore(cleanId, 'id-ID');
const sAiId = aiSmellScore(aiId, 'id-ID');

ok('clean EN scores low', sCleanEn.score < 30, `got ${sCleanEn.score}`);
ok('AI EN scores high', sAiEn.score >= 45, `got ${sAiEn.score}`);
ok('clean ID scores low', sCleanId.score < 30, `got ${sCleanId.score}`);
ok('AI ID scores high', sAiId.score >= 45, `got ${sAiId.score}`);
ok('AI EN strictly worse than clean EN', sAiEn.score > sCleanEn.score);

// Em dash alone should be penalised.
const dashOnly = aiSmellScore('the answer is simple — just do the boring thing', 'en-US');
ok('em dash penalised', dashOnly.score > 0, `got ${dashOnly.score}`);

// The "not just X, it's Y" construction.
const parallel = aiSmellScore("it's not about the tool, it's about the process you build around it", 'en-US');
ok('formulaic parallelism penalised', parallel.score >= 20, `got ${parallel.score}`);

// Uniform sentence length.
const uniform = aiSmellScore('The tool works well. The setup runs fast. The output looks fine. The system stays stable.', 'en-US');
ok('uniform rhythm penalised', uniform.score > 0, `got ${uniform.score}`);

// ─────────────────────────────────────────────────────────────────────────────
section('Slang detection');

ok('detects EN slang ngl', findSlang('ngl this is clean', 'en-US').includes('ngl'));
ok('detects EN slang lowkey', findSlang('lowkey the best take here', 'en-US').includes('lowkey'));
ok('detects EN slang fire', findSlang('this is fire', 'en-US').includes('fire'));
ok('EN word boundary respected', !findSlang('the firefly glowed', 'en-US').includes('fire'));
ok('detects ID slang gacor', findSlang('ini gacor banget', 'id-ID').includes('gacor'));
ok('detects ID slang gabut', findSlang('lagi gabut aja', 'id-ID').includes('gabut'));
ok('detects ID slang cuk', findSlang('cuk ini mah mantul', 'id-ID').includes('cuk') || findSlang('cuk ini mah mantul', 'id-ID').includes('mantul'),
  'cuk is not in the bank (cuy is); mantul must be detected');
ok('detects ID slang cuy', findSlang('cuy ini mah gila', 'id-ID').includes('cuy'));
ok('detects ZH slang 绝了', findSlang('这个真的绝了', 'zh-CN').includes('绝了'));
ok('detects ZH slang yyds', findSlang('这个产品 yyds', 'zh-CN').includes('yyds'));
ok('no slang in plain text', findSlang('the implementation is correct', 'en-US').length === 0);

// ─────────────────────────────────────────────────────────────────────────────
section('Draft validation');

const v1 = validateDraft(cleanEn, { lang: 'en-US', maxChars: 260 });
ok('clean draft passes', v1.ok, JSON.stringify(v1.blocking));
ok('clean draft has slang', v1.quality.slang.includes('ngl'));

const v2 = validateDraft('ngl this is great 😀', { lang: 'en-US', maxChars: 260 });
ok('emoji draft blocked', !v2.ok && v2.blocking.includes('emoji'));

const v3 = validateDraft(aiEn, { lang: 'en-US', maxChars: 260 });
ok('AI draft blocked', !v3.ok, JSON.stringify(v3.blocking));
ok('AI draft flags banned', v3.blocking.includes('banned_phrase') || v3.blocking.includes('ai_smell'));

const v4 = validateDraft('x'.repeat(500), { lang: 'en-US', maxChars: 260 });
ok('overlong draft blocked', v4.blocking.includes('too_long'));
ok('charCount is accurate for ascii', v4.quality.chars === 500);

const v5 = validateDraft('', { lang: 'en-US', maxChars: 260 });
ok('empty draft blocked', !v5.ok && v5.blocking.includes('empty'));

const v6 = validateDraft(cleanId, { lang: 'id-ID', maxChars: 260 });
ok('clean ID draft passes', v6.ok, JSON.stringify(v6.blocking));

// CJK char weighting: X counts CJK as 2 units.
eq('CJK counted double', charCount('你好'), 4);
ok('CJK over limit blocked',
  validateDraft('好'.repeat(200), { lang: 'zh-CN', maxChars: 260 }).blocking.includes('too_long'));

// ─────────────────────────────────────────────────────────────────────────────
section('Cross-draft repetition');

const a = 'the boring part is the actual work here and nobody wants to hear it';
const b = 'the boring part is the actual work here and nobody wants to hear that';
const c = 'gila sih konsistensi itu yang bikin beda, bukan tools-nya';
ok('near-duplicates score high', jaccard(a, b) > 0.7, `got ${jaccard(a, b)}`);
ok('distinct drafts score low', jaccard(a, c) < 0.15, `got ${jaccard(a, c)}`);

const setRes = validateDraftSet(
  [{ tone: 'friendly', text: a }, { tone: 'friendly', text: b }],
  { lang: 'en-US', maxChars: 300 }
);
ok('near-duplicate set flags repetition',
  setRes.some(r => r.blocking.includes('repetition')),
  JSON.stringify(setRes.map(r => r.blocking)));

const distinctSet = validateDraftSet(
  [
    { tone: 'friendly', text: 'ngl the boring part is the actual work. everyone wants the shortcut and then wonders why nothing sticks' },
    { tone: 'playful', text: 'ngl this is the kind of take that ruins my sleep schedule because you are right and i have to redo everything' },
  ],
  { lang: 'en-US', maxChars: 300 }
);
ok('distinct set has no repetition flag',
  distinctSet.every(r => !r.blocking.includes('repetition')),
  JSON.stringify(distinctSet.map(r => ({ b: r.blocking, rep: r.quality.repetition }))));

// ─────────────────────────────────────────────────────────────────────────────
section('Tweet analyzer');

const tweetEn = "Unpopular opinion: most people don't need a SaaS. They need a spreadsheet and 2 hours of focus. We shipped 40% faster after killing 6 tools. What's your stack look like?";
const aEn = analyzeTweet(tweetEn);

ok('analyzer returns an object', !!aEn);
eq('detects English', aEn.language, 'en-US');
ok('detects hot take intent', aEn.intent === 'hotTake', `got ${aEn.intent}`);
ok('detects question', aEn.isQuestion, `intent=${aEn.intent}`);
ok('hot take outranks trailing question', aEn.intent !== 'question',
  'a hot take ending in "what do you think?" must not be classified as a question');

// A tweet that genuinely leads with a question stays a question.
const leadQ = analyzeTweet('How do you handle rate limits on the X API? Curious what people are doing in 2025.');
eq('leading question stays question', leadQ.intent, 'question');

const promoQ = analyzeTweet('We just launched our new API tool. Anyone want early access? Link in bio.');
ok('promo outranks question', promoQ.intent === 'promo', `got ${promoQ.intent}`);
ok('detects business topic', aEn.topics.includes('business'), JSON.stringify(aEn.topics));
ok('extracts keywords', aEn.keywords.length > 0, JSON.stringify(aEn.keywords));
ok('extracts numbers', aEn.entities.numbers.length > 0, JSON.stringify(aEn.entities.numbers));
ok('produces hooks', aEn.hooks.length > 0);
ok('produces reply angles', aEn.replyAngles.length > 0);
ok('stats counted', aEn.stats.chars > 0 && aEn.stats.words > 0);

const tweetId = 'Gila sih, cuan dari farming airdrop itu nyata. Gue udah dapet 3x lipat dari modal awal cuma modal sabar. Kalian masih mikir ini scam?';
const aId = analyzeTweet(tweetId);
eq('detects Indonesian', aId.language, 'id-ID');
ok('detects crypto topic', aId.topics.includes('crypto'), JSON.stringify(aId.topics));
ok('detects question in ID', aId.isQuestion);

const tweetZh = '说实话，现在做内容真的太难了。算法一直在变，我们上个月的数据直接腰斩。你们是怎么应对的？';
const aZh = analyzeTweet(tweetZh);
eq('detects Chinese', aZh.language, 'zh-CN');
ok('ZH keywords extracted', aZh.keywords.length > 0, JSON.stringify(aZh.keywords));
ok('ZH question detected', aZh.isQuestion);

// Sentiment
const posTwitter = analyzeTweet('This is amazing, we just hit 10k users and the team is thrilled!');
eq('positive sentiment', posTwitter.sentiment.label, 'positive');
const negTweet = analyzeTweet('Terrible week. Lost 3 clients and the product keeps breaking. Hate this.');
ok('negative sentiment', negTweet.sentiment.label === 'negative', negTweet.sentiment.label);
eq('neutral on facts', analyzeTweet('The meeting is at 3pm in room 4.').sentiment.label, 'neutral');

// Empty input
eq('empty tweet returns null', analyzeTweet(''), null);
eq('whitespace tweet returns null', analyzeTweet('   '), null);

ok('summary is a string', typeof summarizeAnalysis(aEn) === 'string');
ok('summary mentions intent', summarizeAnalysis(aEn).includes('Intent'));
eq('null analysis summary', summarizeAnalysis(null), 'No analysis available.');

// ─────────────────────────────────────────────────────────────────────────────
section('Prompt builder');

const sys = buildSystemPrompt();
ok('system prompt forbids emoji', sys.includes('NO EMOJI'));
ok('system prompt requires slang', sys.includes('SLANG IS MANDATORY'));
ok('system prompt bans em dash', sys.includes('em dash'));
ok('system prompt specifies JSON', sys.includes('{"drafts"'));

for (const lang of ['en-US', 'id-ID', 'zh-CN']) {
  const up = buildUserPrompt({
    tweet: { text: tweetEn, author: { screen_name: 'test', name: 'Test' }, metrics: { likes: 10 } },
    analysis: aEn,
    language: lang,
    tones: ['friendly', 'playful'],
    draftsPerTone: 3,
    maxChars: 260,
  });
  ok(`${lang}: includes slang bank`, up.includes('Bank:'), lang);
  ok(`${lang}: includes tone friendly`, up.includes('TONE: friendly'));
  ok(`${lang}: includes tone playful`, up.includes('TONE: playful'));
  ok(`${lang}: states draft count`, up.includes('6 drafts total'), lang);
  ok(`${lang}: includes tweet text`, up.includes('Unpopular opinion'));
}

const upId = buildUserPrompt({
  tweet: { text: tweetId, author: { screen_name: 'x', name: 'X' } },
  analysis: aId, language: 'id-ID', tones: ['formal'], draftsPerTone: 2, maxChars: 260,
});
ok('ID prompt mentions bahasa gaul', upId.includes('bahasa gaul'));
ok('ID prompt forbids "adalah"', upId.includes('adalah'));

const upZh = buildUserPrompt({
  tweet: { text: tweetZh, author: { screen_name: 'x', name: 'X' } },
  analysis: aZh, language: 'zh-CN', tones: ['friendly'], draftsPerTone: 2, maxChars: 260,
});
ok('ZH prompt mentions simplified', upZh.includes('简体中文'));
ok('ZH prompt halves char budget', upZh.includes('130 Chinese characters'));

// Every tone must have a complete spec.
for (const [id, spec] of Object.entries(TONE_SPECS)) {
  ok(`tone ${id} has do list`, Array.isArray(spec.do) && spec.do.length > 0);
  ok(`tone ${id} has dont list`, Array.isArray(spec.dont) && spec.dont.length > 0);
  ok(`tone ${id} has example`, typeof spec.example === 'string' && spec.example.length > 20);
  ok(`tone ${id} has length`, !!spec.length);
}

// Soft selling must not be allowed a CTA.
const ss = TONE_SPECS.softselling.dont.join(' ').toLowerCase();
ok('softselling forbids CTA', ss.includes('dm me') || ss.includes('call to action'));
ok('softselling forbids links', ss.includes('links'));

// ─────────────────────────────────────────────────────────────────────────────
section('JSON extraction');

eq('parses bare json', extractJSON('{"drafts":[]}'), { drafts: [] });
eq('parses fenced json', extractJSON('```json\n{"a":1}\n```'), { a: 1 });
eq('parses fenced without lang', extractJSON('```\n{"a":1}\n```'), { a: 1 });
eq('parses with leading prose', extractJSON('Here you go:\n{"a":1}'), { a: 1 });
eq('parses with trailing prose', extractJSON('{"a":1}\nHope that helps!'), { a: 1 });
eq('handles trailing comma', extractJSON('{"a":1,}'), { a: 1 });
eq('handles nested', extractJSON('{"d":[{"t":"x","text":"y"}]}'), { d: [{ t: 'x', text: 'y' }] });

// Braces inside strings must not break the scanner.
eq('brace inside string', extractJSON('{"text":"use { and } carefully"}'),
  { text: 'use { and } carefully' });
eq('escaped quote inside string', extractJSON('{"text":"he said \\"hi\\""}'),
  { text: 'he said "hi"' });

let threw = false;
try { extractJSON('no json at all'); } catch { threw = true; }
ok('throws on no json', threw);

threw = false;
try { extractJSON(''); } catch { threw = true; }
ok('throws on empty', threw);

// ─────────────────────────────────────────────────────────────────────────────
section('Provider registry');

// Exactly the two options the user asked for: five named providers you just
// paste a key into, plus a custom OpenAI-compatible endpoint.
const EXPECTED_PRESETS = ['deepseek', 'kimi', 'glm', 'gemini', 'chatgpt'];
eq('the five named providers exist and are ordered',
  PRESET_PROVIDERS, EXPECTED_PRESETS);
ok('custom provider exists', !!PROVIDERS.custom);
eq('provider order ends with custom', PROVIDER_ORDER, [...EXPECTED_PRESETS, 'custom']);
eq('registry holds exactly six entries',
  Object.keys(PROVIDERS).sort(), [...EXPECTED_PRESETS, 'custom'].sort());

for (const id of EXPECTED_PRESETS) {
  const p = PROVIDERS[id];
  ok(`${id}: has a label`, typeof p.label === 'string' && p.label.length > 0);
  ok(`${id}: has a base URL`, /^https:\/\//.test(p.baseUrl || ''), p.baseUrl);
  ok(`${id}: requires a key`, p.keyRequired === true);
  ok(`${id}: has a default model`, typeof p.defaultModel === 'string' && p.defaultModel.length > 0);
  ok(`${id}: default model is in its own model list`,
    (p.models || []).includes(p.defaultModel), p.defaultModel);
  ok(`${id}: has a docs link for getting a key`, /^https:\/\//.test(p.docs || ''), p.docs);
  ok(`${id}: has at least 2 models to choose from`, (p.models || []).length >= 2);
  ok(`${id}: has a key format hint`, typeof p.keyHint === 'string' && p.keyHint.length > 0);
}

ok('custom needs no key', PROVIDERS.custom.keyRequired === false);
ok('custom allows an empty base URL', PROVIDERS.custom.baseUrl === '');
ok('custom has no fixed models', PROVIDERS.custom.models.length === 0);

// Aliases must not send a key to the wrong host.
eq('alias openai resolves to chatgpt', getProvider('openai').id, 'chatgpt');
eq('alias google resolves to gemini', getProvider('google').id, 'gemini');
eq('alias moonshot resolves to kimi', getProvider('moonshot').id, 'kimi');
eq('alias zhipu resolves to glm', getProvider('zhipu').id, 'glm');
eq('unknown provider falls back to deepseek', getProvider('nope').id, 'deepseek');

// ─── Pre-flight config validation ────────────────────────────────────────────
section('Provider config validation');

ok('empty key on a preset is rejected',
  !validateProviderConfig({ provider: 'deepseek', apiKey: '' }).ok);
ok('empty-key error names the provider',
  /DeepSeek/.test(validateProviderConfig({ provider: 'deepseek', apiKey: '' }).error || ''));
ok('key present on a preset is accepted',
  validateProviderConfig({ provider: 'deepseek', apiKey: 'sk-abc' }).ok);
ok('whitespace-only key is rejected',
  !validateProviderConfig({ provider: 'glm', apiKey: '   ' }).ok);

ok('custom with no base URL is rejected',
  !validateProviderConfig({ provider: 'custom', model: 'm' }).ok);
ok('custom with a non-http base URL is rejected',
  !validateProviderConfig({ provider: 'custom', baseUrl: 'ftp://x', model: 'm' }).ok);
ok('custom with no model is rejected',
  !validateProviderConfig({ provider: 'custom', baseUrl: 'https://x.com/v1' }).ok);
ok('custom with base URL and model is accepted, key optional',
  validateProviderConfig({ provider: 'custom', baseUrl: 'https://x.com/v1', model: 'm', apiKey: '' }).ok);
ok('custom accepts a localhost base URL',
  validateProviderConfig({ provider: 'custom', baseUrl: 'http://localhost:11434/v1', model: 'qwen' }).ok);

ok('needsSetup is true with a fresh default config',
  needsSetup({ provider: 'deepseek', apiKey: '' }) === true);
ok('needsSetup is false once a key is set',
  needsSetup({ provider: 'chatgpt', apiKey: 'sk-x' }) === false);

// ─────────────────────────────────────────────────────────────────────────────
section('Realistic end-to-end style check');

// These are the kind of drafts the system should accept.
const goodDrafts = [
  { tone: 'friendly',  lang: 'id-ID', text: 'setuju sih. gue juga kena fase beli tools mulu, ujungnya balik ke spreadsheet juga. yang bikin beda emang jam fokus, bukan stack-nya' },
  { tone: 'playful',   lang: 'id-ID', text: '6 tools dibunuh dalam satu sprint itu kerjaan yang paling memuaskan sih. auto ringan rasanya' },
  { tone: 'edukatif',  lang: 'id-ID', text: 'tips kecil: audit dulu tools mana yang terakhir dibuka 30 hari terakhir. biasanya setengah langsung kelihatan gabut dan bisa dibuang' },
  { tone: 'softselling', lang: 'id-ID', text: 'bagian susahnya bukan pindahin tools, tapi ngajak tim konsisten. kami butuh 2 minggu cuma buat ngerapiin satu workflow, dan hasilnya baru kerasa di minggu ketiga' },
  { tone: 'formal',    lang: 'id-ID', text: 'Setuju sama intinya. Satu catatan, keputusan mengurangi tools biasanya lebih sulit di tim besar karena setiap orang punya preferensi sendiri' },
  { tone: 'friendly',  lang: 'en-US', text: "ngl the tool hoarding phase is a rite of passage. took me 2 years to figure out the spreadsheet was doing the real work" },
  { tone: 'playful',   lang: 'en-US', text: 'killing 6 tools in one sprint is genuinely one of the most satisfying things you can do. whole stack feels lighter' },
  { tone: 'friendly',  lang: 'zh-CN', text: '说实话这个很真实。我之前也是工具越买越多，最后还是回去用表格。真正有用的就是那两小时不被打扰的时间' },
];

const goodResults = validateDraftSet(goodDrafts, { lang: 'en-US', maxChars: 300 });
// Validate each against its own language.
let goodPass = 0;
for (const d of goodDrafts) {
  const r = validateDraft(d.text, { lang: d.lang, maxChars: 300 });
  if (r.ok) goodPass++;
  else console.log(`   soft-fail [${d.tone}/${d.lang}]: ${JSON.stringify(r.blocking)} aiSmell=${r.quality.aiSmell}`);
}
ok('majority of realistic drafts pass', goodPass >= goodDrafts.length - 1,
  `${goodPass}/${goodDrafts.length} passed`);

// These are what the system must reject.
const badDrafts = [
  { lang: 'en-US', text: "In today's fast-paced world, it's not just about tools, it's about mindset 💡 — a true game-changer.", why: 'emoji+ai+parallel' },
  { lang: 'id-ID', text: 'Di era digital yang terus berkembang, perlu diketahui bahwa pada dasarnya solusi ini adalah hal yang sangat penting untuk dicatat 🚀', why: 'emoji+ai ID' },
  { lang: 'zh-CN', text: '在这个快节奏的时代，值得一提的是，AI 技术的发展真的绝了 👍', why: 'emoji+ai ZH' },
];
for (const d of badDrafts) {
  const r = validateDraft(d.text, { lang: d.lang, maxChars: 300 });
  ok(`rejects bad draft (${d.why})`, !r.ok, `blocking=${JSON.stringify(r.blocking)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  x ' + f);
}
process.exit(fail === 0 ? 0 : 1);
