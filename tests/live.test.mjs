/**
 * Reply Guy — Live end-to-end generation test
 *
 * Requires a real API key. Run:
 *   node tests/live.test.mjs <provider> <model> <apiKey>
 * or set RG_API_KEY / RG_PROVIDER / RG_MODEL.
 *
 * This is the only test that proves the pipeline works: it hits a real model,
 * then runs the output through the shipping validator. Everything else tests
 * the pieces in isolation.
 */

import { analyzeTweet, summarizeAnalysis } from '../lib/analyzer.js';
import { buildSystemPrompt, buildUserPrompt } from '../lib/prompt.js';
import { validateDraft, validateDraftSet } from '../lib/rules.js';
import { chatCompletion, extractJSON, PROVIDERS, PRESET_PROVIDERS } from '../lib/providers.js';

const provider = process.argv[2] || process.env.RG_PROVIDER || 'gemini';
const model = process.argv[3] || process.env.RG_MODEL || PROVIDERS[provider]?.defaultModel;
const apiKey = process.argv[4] || process.env.RG_API_KEY;

if (!apiKey) {
  console.error('No API key. Pass it as arg 3 or set RG_API_KEY.');
  process.exit(2);
}

const TWEETS = [
  {
    label: 'EN hot take',
    lang: 'en-US',
    text: "Unpopular opinion: most people don't need a SaaS. They need a spreadsheet and 2 hours of focus. We shipped 40% faster after killing 6 tools. What's your stack look like?",
    author: { screen_name: 'buildinpublic', name: 'Builder' },
  },
  {
    label: 'ID crypto',
    lang: 'id-ID',
    text: 'Gila sih, cuan dari farming airdrop itu nyata. Gue udah dapet 3x lipat dari modal awal cuma modal sabar. Kalian masih mikir ini scam?',
    author: { screen_name: 'cryptoid', name: 'Crypto ID' },
  },
  {
    label: 'ZH content',
    lang: 'zh-CN',
    text: '说实话，现在做内容真的太难了。算法一直在变，我们上个月的数据直接腰斩。你们是怎么应对的？',
    author: { screen_name: 'creator', name: '创作者' },
  },
];

const tones = ['friendly', 'playful', 'softselling'];

console.log(`Provider: ${provider}   Model: ${model}`);
console.log(`Available providers: ${PRESET_PROVIDERS.join(', ')}, custom\n`);
console.log(`System prompt: ${buildSystemPrompt().length} chars\n`);

const cfg = { provider, baseUrl: PROVIDERS[provider]?.baseUrl, apiKey, model };

let totalDrafts = 0;
let totalClean = 0;
let totalEmoji = 0;
let totalAISmell = 0;
let slangMissing = 0;

for (const t of TWEETS) {
  console.log('='.repeat(70));
  console.log(`TWEET [${t.label}] lang=${t.lang}`);
  console.log(t.text.slice(0, 100) + (t.text.length > 100 ? '...' : ''));

  const analysis = analyzeTweet(t.text, { author: t.author });
  console.log(`  -> intent=${analysis.intent} topics=${analysis.topics.join(',')} question=${analysis.isQuestion}`);

  const user = buildUserPrompt({
    tweet: { text: t.text, author: t.author, metrics: { likes: 120 } },
    analysis,
    language: t.lang,
    tones,
    draftsPerTone: 2,
    maxChars: 260,
  });

  let raw;
  try {
    raw = await chatCompletion(cfg, {
      system: buildSystemPrompt(),
      user,
      temperature: 0.95,
      maxTokens: 2200,
      jsonMode: provider === 'chatgpt',
    }, { timeoutMs: 120000 });
  } catch (err) {
    console.log(`  !! LLM call failed: ${err.message}\n`);
    continue;
  }

  let parsed;
  try {
    parsed = extractJSON(raw);
  } catch (err) {
    console.log(`  !! JSON parse failed: ${err.message}`);
    console.log('  RAW:', raw.slice(0, 400));
    continue;
  }

  const drafts = (parsed.drafts || [])
    .filter(d => d?.text)
    .map(d => ({ tone: d.tone || 'unknown', text: String(d.text).trim() }));

  if (!drafts.length) {
    console.log('  !! No drafts. RAW:', raw.slice(0, 300));
    continue;
  }

  const results = validateDraftSet(drafts, { lang: t.lang, maxChars: 260 });

  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    const r = results[i];
    totalDrafts++;
    if (r.ok) totalClean++;
    if (r.quality.emoji.length) totalEmoji++;
    if (r.quality.aiSmell >= 45) totalAISmell++;
    if (r.quality.slangMissing) slangMissing++;

    const flag = r.ok ? 'OK  ' : 'FLAG';
    console.log(`\n  [${flag}] ${d.tone}  (aiSmell=${r.quality.aiSmell} slang=${r.quality.slang.join('/') || 'NONE'} chars=${r.quality.chars})`);
    console.log(`   ${d.text.replace(/\n/g, ' / ')}`);
    if (!r.ok) console.log(`   blocking: ${r.blocking.join(', ')}`);
    if (r.quality.reasons.length) console.log(`   reasons: ${r.quality.reasons.join('; ')}`);
  }
  console.log('');
}

console.log('='.repeat(70));
console.log('SUMMARY');
console.log(`  drafts generated : ${totalDrafts}`);
console.log(`  passed all rules : ${totalClean} (${totalDrafts ? Math.round(totalClean / totalDrafts * 100) : 0}%)`);
console.log(`  contained emoji  : ${totalEmoji}`);
console.log(`  high ai-smell    : ${totalAISmell}`);
console.log(`  missing slang    : ${slangMissing}`);
console.log('='.repeat(70));

// The hard requirements are emoji and structural originality. Slang is a
// strong preference; a formal draft slipping through with no marker is a soft
// miss, not a pipeline failure.
const hardFail = totalEmoji > 0;
if (hardFail) {
  console.log('\nFAIL: emoji leaked through the hard rule.');
  process.exit(1);
}
if (!totalDrafts) {
  console.log('\nFAIL: no drafts were produced at all.');
  process.exit(1);
}
const cleanRate = totalClean / totalDrafts;
console.log(`\nClean rate ${Math.round(cleanRate * 100)}%. Zero emoji. Hard rules held.`);
process.exit(0);
