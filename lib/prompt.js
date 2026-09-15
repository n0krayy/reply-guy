/**
 * Reply Guy — Prompt builder
 *
 * The system prompt is where the three hard rules are stated. lib/rules.js
 * re-checks the output; this file makes the model actually try to comply.
 *
 * Key design decisions:
 *  - Rules are stated as constraints with concrete BAD/GOOD examples. Models
 *    follow examples far better than they follow abstractions.
 *  - The slang bank is injected verbatim per language. "Use slang" alone
 *    produces generic output; a word list anchors it.
 *  - Tone is defined by what it does, not by adjectives. "Friendly" is
 *    meaningless to a model; "warm but not effusive, no compliments about the
 *    person" is actionable.
 *  - Output is JSON so tone-per-draft mapping is unambiguous.
 */

import { SLANG_BANK, BANNED_UNIVERSAL } from './rules.js';
import { summarizeAnalysis } from './analyzer.js';

// ─── Tone definitions ────────────────────────────────────────────────────────
export const TONE_SPECS = {
  friendly: {
    label: 'Friendly',
    do: [
      'Sound like a person who already knows the poster, not a stranger being polite.',
      'Warm and casual. Acknowledge the effort or the specific point they made.',
      'Agree or add. Never be effusive.',
    ],
    dont: [
      'Do not say "Great post", "Love this", "So true", "Couldn\'t agree more" or any version of them.',
      'Do not compliment the person. Compliment the specific thing they said.',
      'Do not use exclamation marks more than once per draft.',
    ],
    length: 'short',
    example: 'ngl the framing here is clean. most people overthink the setup and miss that the boring part is the actual work',
  },
  playful: {
    label: 'Playful',
    do: [
      'Be funny in a dry, observational way. Understatement over punchlines.',
      'Roast the situation, never the person.',
      'Confident and loose. Sentence fragments are fine.',
    ],
    dont: [
      'No dad jokes, no puns that need explaining, no setup-then-punchline structure.',
      'No emoji, no "haha" as a standalone sentence unless it is genuinely how you would text.',
      'Do not be mean. Teasing > insulting.',
    ],
    length: 'short',
    example: 'this is the kind of tweet that makes me open a spreadsheet at 2am and i hate that you are right',
  },
  formal: {
    label: 'Formal',
    do: [
      'Precise and measured. Full sentences, correct grammar.',
      'Still conversational — this is a comment, not a report. No headings, no bullets.',
      'State one clear position and one supporting reason.',
    ],
    dont: [
      'Do not write "Furthermore", "Moreover", "In conclusion", "I would like to add".',
      'Do not use passive voice unless it is the natural choice.',
      'Do not be stiff. Formal does not mean bloodless.',
      'Do not abandon slang entirely — one light marker keeps it human. See the slang policy.',
    ],
    length: 'medium',
    example: 'Setuju sama intinya. Satu catatan, model yang lebih kecil kadang lebih stabil buat task spesifik karena varians outputnya lebih rendah',
  },
  softselling: {
    label: 'Soft Selling',
    do: [
      'Lead with a genuinely useful observation that stands on its own without any pitch.',
      'If a product or service is relevant, reference it as a passing personal experience, never as a recommendation to the reader.',
      'The reply must be valuable even if the reader ignores every hint at what you do.',
    ],
    dont: [
      'No links, no "DM me", no "check my profile", no pricing, no call to action.',
      'Never use the words: offer, solution, service, package, book a call, free trial, limited spots.',
      'Do not pivot mid-reply. The pitch, if any, is the last clause and it is soft.',
      'Do not make the reply about you. Maximum one first-person reference.',
    ],
    length: 'medium',
    example: 'the part people skip is the boring part. i tested this on maybe 40 accounts last month and the wins all came from fixing the obvious thing first, took about a week of manual work before anything else mattered',
  },
  edukatif: {
    label: 'Edukatif',
    do: [
      'Teach exactly one concrete thing the reader can use today.',
      'Use a specific number, tool name, or step. Specificity is the whole point.',
      'Frame as "here is the mechanism" not "here is my opinion".',
    ],
    dont: [
      'No lectures. Maximum three sentences.',
      'Do not define basic terms the audience obviously knows.',
      'No "it depends", no hedging into uselessness.',
      'Do not list more than two items — this is a comment, not a thread.',
    ],
    length: 'medium',
    example: 'tricknya, cek dulu apakah limit orderbook renggang di jam itu. kalo spread lebih dari 0.5% mending tunggu sesi US buka, slippage-nya bisa makan setengah edge lu',
  },
};

// ─── Language policy ─────────────────────────────────────────────────────────
const LANG_POLICY = {
  'en-US': {
    name: 'American English',
    rules: [
      'Write in natural American English as typed by a native speaker on X.',
      'Use contractions everywhere: it\'s, don\'t, that\'s, you\'re, gonna, wanna, kinda.',
      'Prefer short sentences. Start sentences with "and", "but", "so" when it flows.',
      'Lowercase the start of sentences when the tone is casual — this is normal on X.',
      'Never write British spellings: use color, behavior, realize, analyze, organization.',
      'Avoid words that only exist in corporate or academic English.',
    ],
  },
  'id-ID': {
    name: 'Bahasa Indonesia',
    rules: [
      'Write in casual Bahasa Indonesia as used by Jakartans on X (bahasa gaul / sehari-hari).',
      'Use "gue/lu" or "aku/kamu" depending on which fits the tone — pick one and stay consistent within a draft.',
      'Use shortened forms: gak, udah, banget (bgt), aja, kayak, ngga, dah, nih, tuh, sih, dong.',
      'Avoid formal/bureaucratic Indonesian: do not write "adalah", "merupakan", "tersebut", "oleh karena itu", "sehingga".',
      'Avoid textbook Indonesian. If it sounds like a school essay, rewrite it.',
      'Do not translate English slang literally. Use Indonesian equivalents or leave the English term if that is what people actually say.',
      'The "Formal" tone means polite but still natural Indonesian (bisa, tidak, tetapi) — not official-letter Indonesian.',
    ],
  },
  'zh-CN': {
    name: '简体中文 (Simplified Mandarin)',
    rules: [
      'Write in colloquial Simplified Chinese as typed on Weibo or Xiaohongshu.',
      'Use 口语 (spoken register), not 书面语 (written/formal register).',
      'Use 短句. Break long ideas into separate sentences.',
      'Use simplified characters only. Never traditional.',
      'Do not use 书面连接词: 因此、然而、除此之外、综上所述、值得注意的是.',
      'Avoid 成语 stacking. One 成语 maximum, and only if it is genuinely how someone would talk.',
      'Avoid Mainland official-media phrasing (官方腔).',
      'The "Formal" tone means 礼貌自然, not 公文.',
    ],
  },
};

function slangPolicy(lang) {
  const bank = SLANG_BANK[lang] || [];
  const sample = bank.slice(0, 28).join(', ');
  let note = '';
  if (lang === 'en-US') note = 'Use 1-2 markers max per draft. More than two reads as trying too hard.';
  if (lang === 'id-ID') note = 'Pakai 1-3 penanda per draft. Kalau lebih dari 3 kesannya dipaksa.';
  if (lang === 'zh-CN') note = '一篇最多用 1-2 个,多了显得刻意。';

  return [
    'SLANG POLICY:',
    '- Every draft must contain at least one slang marker from the bank below.',
    `- Bank: ${sample}`,
    '- Use the marker where it is natural. Never insert slang as decoration.',
    `- ${note}`,
    '- Do not invent slang that is not in the bank unless you are certain it is current in that language.',
  ].join('\n');
}

// ─── System prompt ───────────────────────────────────────────────────────────
export function buildSystemPrompt() {
  return [
    'You write replies to posts on X (Twitter). You are not an assistant and you do not explain yourself.',
    'You produce short comments that a real person would type from their phone.',
    '',
    'ABSOLUTE RULES — violating any of these makes the output unusable:',
    '1. NO EMOJI. Not one. No emoticons like :) or ;), no kaomoji, no arrows used as decoration, no unicode symbols like ✦ ★ → ✅.',
    '2. NO AI TELLS. Never use these words or constructions:',
    `   ${BANNED_UNIVERSAL.slice(0, 22).join(', ')}.`,
    '   Never use an em dash (—). Use a comma, a period, or restructure.',
    '   Never use "It\'s not just X, it\'s Y" or "Not only X but also Y".',
    '   Never produce a list of exactly three short parallel clauses.',
    '   Vary sentence length. Uniform rhythm is the loudest giveaway.',
    '3. SLANG IS MANDATORY. See the slang policy in the request.',
    '4. ORIGINAL STRUCTURE. Do not restate the tweet. Do not open with agreement filler. Do not summarise.',
    '',
    'STYLE:',
    '- Write like someone typing fast who is not trying to impress anyone.',
    '- Imperfect is better than polished. A slightly awkward but human line beats a smooth generic one.',
    '- Contractions, fragments, lowercase starts, and trailing off are all allowed and encouraged where the tone permits.',
    '- Never address the reader as "you all", "folks", "everyone", or "guys".',
    '- Never end with a question just to farm engagement unless the tone is a genuine question.',
    '',
    'OUTPUT FORMAT:',
    'Return raw JSON only. No markdown fences, no commentary.',
    '{"drafts":[{"tone":"<tone id>","text":"<reply>"}]}',
    'One object per requested tone per requested count. Do not merge tones.',
  ].join('\n');
}

// ─── User prompt ─────────────────────────────────────────────────────────────
export function buildUserPrompt({ tweet, analysis, language, tones, draftsPerTone, maxChars }) {
  const lp = LANG_POLICY[language] || LANG_POLICY['en-US'];

  const toneBlocks = tones.map((id) => {
    const spec = TONE_SPECS[id];
    if (!spec) return '';
    return [
      `TONE: ${id} (${spec.label})`,
      '  DO:',
      ...spec.do.map(d => `    - ${d}`),
      '  DO NOT:',
      ...spec.dont.map(d => `    - ${d}`),
      `  Length: ${spec.length}`,
      `  Style reference (do not copy, match the register): "${spec.example}"`,
    ].join('\n');
  }).filter(Boolean).join('\n\n');

  const charNote = language === 'zh-CN'
    ? `Maximum ${Math.floor(maxChars / 2)} Chinese characters per draft (X weights CJK at 2 units each).`
    : `Maximum ${maxChars} characters per draft. Aim for 100-200. Shorter usually wins.`;

  return [
    'LANGUAGE: ' + lp.name,
    ...lp.rules.map(r => '- ' + r),
    '',
    slangPolicy(language),
    '',
    '=== THE POST YOU ARE REPLYING TO ===',
    `@${tweet.author?.screen_name || 'unknown'} — ${tweet.author?.name || 'unknown'}`,
    '"""',
    tweet.text,
    '"""',
    tweet.metrics ? `Engagement: ${tweet.metrics.likes || 0} likes, ${tweet.metrics.replies || 0} replies, ${tweet.metrics.views || 0} views` : '',
    '',
    '=== ANALYSIS (use as signal, do not repeat it verbatim) ===',
    summarizeAnalysis(analysis),
    '',
    '=== TONES TO PRODUCE ===',
    toneBlocks,
    '',
    '=== CONSTRAINTS ===',
    `- Produce ${draftsPerTone} distinct drafts for EACH tone listed above. That is ${draftsPerTone * tones.length} drafts total.`,
    '- Drafts within the same tone must take clearly different angles. Do not reword the same sentence.',
    '- ' + charNote,
    '- No emoji. No em dash. No banned words. Slang in every draft.',
    '- Do not use hashtags or @mentions unless the post you are replying to used them.',
    '',
    'Return the JSON now.',
  ].filter(Boolean).join('\n');
}

/**
 * Appended when a draft fails validation and we retry just that one.
 *
 * `siblings` is the list of other drafts already in the set. Without it, two
 * near-duplicate drafts repaired independently tend to converge on the same
 * replacement, which recreates the repetition the repair was meant to fix.
 * Passing them as an explicit blocklist is what breaks that loop.
 */
export function buildRepairPrompt({ original, language, tone, violations, siblings = [] }) {
  const fixes = [];
  if (violations.includes('emoji')) fixes.push('- Remove every emoji and unicode symbol. Replace with words or nothing.');
  if (violations.includes('banned_phrase')) fixes.push('- Remove the banned AI-sounding phrases.');
  if (violations.includes('ai_smell')) fixes.push('- Rewrite from scratch. It reads like generated text. Vary sentence length, drop the balanced structure, make it messier and more specific.');
  if (violations.includes('too_long')) fixes.push('- Cut it down. Drop the weakest clause entirely.');
  if (violations.includes('repetition')) fixes.push('- This is too similar to another draft. Take a completely different angle with different vocabulary.');
  if (violations.includes('empty')) fixes.push('- Produce a real reply.');

  const bank = (SLANG_BANK[language] || []).slice(0, 20).join(', ');

  const lines = [
    `Rewrite this ${tone} reply in ${language}. It violated these rules:`,
    ...fixes,
    '',
    'Original:',
    '"""',
    original,
    '"""',
  ];

  if (siblings.length) {
    lines.push(
      '',
      'These replies already exist in the same set. Your rewrite must NOT be a variation of any of them:',
      ...siblings.map((s, i) => `  ${i + 1}. "${String(s).slice(0, 200)}"`)
    );
  }

  lines.push(
    '',
    `Keep the same overall angle and meaning but fix the violations. Keep at least one slang marker from: ${bank}`,
    'Return raw JSON only: {"text":"<rewritten reply>"}'
  );

  return lines.join('\n');
}
