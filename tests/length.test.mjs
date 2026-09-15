// The brevity rule.
//
// A reply is a comment under someone else's post. Long replies read as
// generated even when the wording is perfect, which is exactly the failure mode
// this extension exists to avoid. Length is therefore a hard rule with a target,
// not just a 280-character ceiling.
//
// These tests pin the policy itself, the enforcement, and the CJK edge case
// that made an ordinary Chinese draft register as 21 "words".

import { validateDraft, validateDraftSet, charCount, countWords } from '../lib/rules.js';
import { buildUserPrompt, buildRepairPrompt } from '../lib/prompt.js';
import { analyzeTweet } from '../lib/analyzer.js';
import { REPLY_LENGTH, REPLY_WORDS, DEFAULTS } from '../lib/constants.js';

let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const v = (text, lang = 'en-US') => validateDraft(text, { lang, maxChars: REPLY_LENGTH.max });

// ─── The policy is sane and enforced by default ──────────────────────────────
console.log('=== Policy ===');
{
  ok('a target length exists', REPLY_LENGTH.target > 0);
  ok('the target is well under the hard max',
    REPLY_LENGTH.target < REPLY_LENGTH.max,
    `${REPLY_LENGTH.target} vs ${REPLY_LENGTH.max}`);
  ok('the default setting matches the policy ceiling',
    DEFAULTS.maxChars === REPLY_LENGTH.max,
    `settings=${DEFAULTS.maxChars} policy=${REPLY_LENGTH.max}`);
  ok('the ceiling is far below the 280-character platform limit',
    REPLY_LENGTH.max <= 200,
    'matching 280 would defeat the point');
  ok('there is a word ceiling too', REPLY_WORDS.max > 0 && REPLY_WORDS.max <= 40);
}

// ─── Over-long drafts are blocked, not merely noted ──────────────────────────
console.log('\n=== Enforcement ===');
{
  const long = 'This is genuinely one of the most interesting perspectives I have seen on this '
    + 'topic in a while, and I think a lot of people are going to look back on it and realise '
    + 'they were wrong about the whole thing.';
  const r = v(long);
  ok('an over-long English draft is blocked', r.ok === false, JSON.stringify(r.blocking));
  ok('it is blocked for length specifically', r.blocking.includes('too_long'));
  ok('its char count exceeds the ceiling', r.quality.chars > REPLY_LENGTH.max,
    `${r.quality.chars} > ${REPLY_LENGTH.max}`);

  // A rambling draft made of many SHORT words can slip under the char ceiling,
  // so the word count has to catch it independently.
  const manyShortWords = Array.from({ length: 40 }, (_, i) => (i % 3 ? 'so' : 'but')).join(' ');
  const w = v(manyShortWords);
  ok('a many-short-words draft is caught by the word ceiling',
    w.blocking.includes('too_long'),
    `words=${w.quality.words} chars=${w.quality.chars}`);
}

// ─── A good reply passes ─────────────────────────────────────────────────────
console.log('\n=== Short replies still pass ===');
{
  for (const [lang, text] of [
    ['en-US', 'ngl this take is underrated, most people sleep on it'],
    ['id-ID', 'gila sih ini mah underrated bgt, orang pada belom sadar'],
    ['zh-CN', '这个观点其实挺有意思的，大部分人还没反应过来'],
  ]) {
    const r = v(text, lang);
    ok(`a natural short ${lang} reply passes`, r.ok === true,
      `${r.blocking} chars=${r.quality.chars} words=${r.quality.words}`);
  }
}

// ─── A stale stored setting cannot raise the ceiling ─────────────────────────
console.log('\n=== A stale maxChars cannot bypass the rule ===');
{
  // This fixture must be caught by the CHARACTER ceiling and nothing else.
  // The obvious choice — a normal long sentence — also blows the 32-word limit,
  // so the word rule masks the clamp and the test passes even with the clamp
  // deleted. Long words with few tokens isolate the ceiling.
  const longFewWords = 'Extraordinarily underwhelming notwithstanding the fundamentally '
    + 'disproportionate resource allocation, the comprehensively misaligned expectations, '
    + 'and the characteristically unremarkable execution throughout';
  ok('the fixture is over the char ceiling', charCount(longFewWords) > REPLY_LENGTH.max,
    String(charCount(longFewWords)));
  ok('the fixture is UNDER the word ceiling, so only the char rule can catch it',
    countWords(longFewWords) <= REPLY_WORDS.max,
    `words=${countWords(longFewWords)}; an over-word fixture would mask the clamp`);

  // 260 is the value older builds saved. It must not widen the limit.
  const r = validateDraft(longFewWords, { lang: 'en-US', maxChars: 260 });
  ok('maxChars above the policy ceiling is clamped',
    r.blocking.includes('too_long'),
    'a saved 260-char setting would disable the brevity rule');
}

// ─── CJK is weighted, not counted per character ──────────────────────────────
console.log('\n=== CJK weighting ===');
{
  const zh = '说实话这个看法很到位，很多人现在还不愿意承认，但过几年回头看就明白了';
  const cjkChars = (zh.match(/[\u4E00-\u9FFF]/g) || []).length;
  const w = countWords(zh);
  ok('CJK words are not counted one-per-character',
    w < cjkChars,
    `${w} words for ${cjkChars} hanzi; counting each character made ordinary replies trip the ceiling`);
  ok('an ordinary zh-CN reply is not flagged too long',
    v(zh, 'zh-CN').blocking.length === 0,
    JSON.stringify(v(zh, 'zh-CN').blocking));
  ok('charCount still weights CJK at 2 units',
    charCount('中文') === 4, String(charCount('中文')));

  const zhLong = '说实话这个看法真的非常到位，我觉得大部分人都还没有真正意识到问题的严重性，'
    + '等到几年之后回头再看的时候才会发现自己当初的判断完全是错的，这种情况其实在历史上已经反复出现过很多次了';
  ok('a genuinely long zh-CN reply is still blocked',
    v(zhLong, 'zh-CN').blocking.includes('too_long'),
    `chars=${v(zhLong, 'zh-CN').quality.chars}`);
}

// ─── Drift is signed, so the UI can tell short from long ─────────────────────
console.log('\n=== Length drift ===');
{
  const short_ = v('ngl underrated');
  const long_ = v('This is genuinely one of the most interesting perspectives I have seen on this topic in a while, and I think a lot of people are going to look back on it.');
  ok('a short draft reports negative drift', short_.quality.lengthDrift < 0,
    String(short_.quality.lengthDrift));
  ok('a long draft reports positive drift', long_.quality.lengthDrift > 0,
    String(long_.quality.lengthDrift));
  ok('drift is a finite number, never NaN',
    Number.isFinite(short_.quality.lengthDrift) && Number.isFinite(long_.quality.lengthDrift));
}

// ─── Verbosity costs on the AI-smell score ───────────────────────────────────
console.log('\n=== Verbosity reads as AI ===');
{
  // Two drafts, same register, one twice the length. The long one must score
  // worse so "Quality first" sorting pushes the tight drafts to the top.
  const tight = v('ngl this is underrated, most people sleep on it');
  const verbose = v('Honestly speaking, this is a perspective that I think is quite underrated, and I believe most people are sleeping on it in a way that will become obvious to everyone later');
  ok('a verbose draft scores worse than a tight one',
    verbose.quality.aiSmell > tight.quality.aiSmell,
    `verbose=${verbose.quality.aiSmell} tight=${tight.quality.aiSmell}`);
  ok('the verbosity reason is recorded',
    verbose.quality.reasons.some(r => /verbose/i.test(r)),
    JSON.stringify(verbose.quality.reasons));
}

// ─── The prompt asks for brevity ─────────────────────────────────────────────
console.log('\n=== The prompt states the rule ===');
{
  // Use the real analyzer: a hand-rolled stub misses fields summarizeAnalysis
  // depends on, which would break the prompt builder for the wrong reason.
  const realAnalysis = analyzeTweet('Hot take: most productivity advice is just procrastination in a nice font.');
  const p = buildUserPrompt({
    tweet: { text: 'hot take', author: { screen_name: 'x', name: 'X' } },
    analysis: realAnalysis,
    language: 'en-US', tones: ['friendly'], draftsPerTone: 2, maxChars: REPLY_LENGTH.max,
  });
  ok('the prompt states the target length', p.includes(String(REPLY_LENGTH.target)));
  ok('the prompt states the hard maximum', p.includes(String(REPLY_LENGTH.max)));
  ok('the prompt has a dedicated brevity section', /BREVITY/.test(p));
  ok('the prompt says not to summarise the post back',
    /summari[sz]e the post/i.test(p),
    'restating the post is a classic long-reply failure');
  ok('the prompt forbids a closing line', /closing line/i.test(p));
  ok('the ZH prompt uses the halved budget',
    buildUserPrompt({
      tweet: { text: 't', author: {} },
      analysis: realAnalysis,
      language: 'zh-CN', tones: ['friendly'], draftsPerTone: 1, maxChars: REPLY_LENGTH.max,
    }).includes('90 Chinese characters'));

  const repair = buildRepairPrompt({
    original: 'x', language: 'en-US', tone: 'friendly',
    violations: ['too_long'], siblings: [],
  });
  ok('the repair prompt knows how to fix too_long',
    /too long/i.test(repair) && repair.includes(String(REPLY_LENGTH.max)));
  ok('the repair prompt says to cut a clause, not trim words',
    /delete a whole clause|drop the closing/i.test(repair),
    '"shorten it" alone produces the same length back');
}

// ─── Short replies are never punished ────────────────────────────────────────
// The first cut of this rule blocked anything under 25 characters and 5 words.
// Every one of these is something a person would actually type.
console.log('\n=== Short human replies pass ===');
{
  for (const [text, lang] of [
    ['facts', 'en-US'],
    ['fr this is it', 'en-US'],
    ['nah this is wrong', 'en-US'],
    ['setuju bgt', 'id-ID'],
    ['gila sih ini', 'id-ID'],
    ['确实是这样', 'zh-CN'],
    ['这个观点很到位', 'zh-CN'],
  ]) {
    const r = v(text, lang);
    ok(`"${text}" is allowed`, r.ok === true,
      `${JSON.stringify(r.blocking)} words=${r.quality.words}`);
  }
  ok('there is no minimum-length rule at all',
    REPLY_LENGTH.min === undefined && REPLY_WORDS.min === undefined,
    'a floor would reject exactly the short output we want');
}

// ─── The set-level pass keeps the rule ───────────────────────────────────────
console.log('\n=== Set validation ===');
{
  const drafts = [
    { tone: 'friendly', text: 'ngl underrated take imo' },
    { tone: 'playful', text: 'This is genuinely one of the most interesting perspectives I have seen on this topic in a while, and I think a lot of people are going to look back on it and realise they were wrong.' },
  ];
  const res = validateDraftSet(drafts, { lang: 'en-US', maxChars: REPLY_LENGTH.max });
  ok('the short draft passes in a set', res[0].ok === true, JSON.stringify(res[0].blocking));
  ok('the long draft fails in a set', res[1].blocking.includes('too_long'),
    JSON.stringify(res[1].blocking));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  x ${f}`);
}
process.exit(fail ? 1 : 0);
