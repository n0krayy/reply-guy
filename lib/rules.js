/**
 * Reply Guy — Style rule engine
 *
 * Everything that enforces the hard requirements lives here:
 *   1. no emoji
 *   2. original structure / must not smell like AI
 *   3. slang is required
 *   4. a reply stays short — it is a comment, not an essay
 *
 * The prompt builder (lib/prompt.js) consumes the same tables so the model is
 * told the rules, and this module re-checks the output afterwards. Prompt-only
 * enforcement is unreliable across models; the validator is the actual gate.
 */

import { REPLY_LENGTH, REPLY_WORDS } from './constants.js';

// ─── 1. Emoji ────────────────────────────────────────────────────────────────
// Covers pictographs, emoticons, dingbats, transport, flags, keycap sequences,
// variation selectors and ZWJ sequences.
const EMOJI_RE = new RegExp(
  '[' +
    '\\u{1F300}-\\u{1FAFF}' + // pictographs & symbols
    '\\u{1F000}-\\u{1F2FF}' + // mahjong / dominoes / enclosed
    '\\u{2600}-\\u{27BF}'  + // misc symbols + dingbats
    '\\u{2190}-\\u{21FF}'  + // arrows (commonly used as decoration)
    '\\u{2B00}-\\u{2BFF}'  + // misc symbols and arrows
    '\\u{FE00}-\\u{FE0F}'  + // variation selectors
    '\\u{1F1E6}-\\u{1F1FF}' + // regional indicators (flags)
    '\\u{200D}'            + // zero-width joiner
    '\\u{20E3}'            + // keycap
    '\\u{2122}\\u{2139}\\u{24C2}\\u{3030}\\u{303D}\\u{3297}\\u{3299}' +
  ']',
  'u'
);

// Symbols that are technically in the emoji blocks but read as punctuation in
// some languages. Keep the rule strict — the user asked for zero emoji — but
// strip CJK fullwidth punctuation from the check since it lives elsewhere.
export function findEmoji(text) {
  const hits = new Set();
  for (const ch of text) if (EMOJI_RE.test(ch)) hits.add(ch);
  return [...hits];
}

// ─── 2. AI smell ─────────────────────────────────────────────────────────────
// Phrases that reliably betray LLM output. Grouped so the prompt can quote them
// back to the model as a "never write this" list.

export const BANNED_OPENERS = {
  'en-US': [
    "in today's fast-paced world", 'in the ever-evolving landscape',
    'as an ai', "i'd be happy to", 'let me break it down', 'here\u2019s the thing',
    "it's important to note that", 'in conclusion', 'delve into',
    'navigate the complexities', 'at the end of the day',
    'this is a game-changer', 'let that sink in', 'buckle up',
  ],
  'id-ID': [
    'dalam dunia yang serba cepat ini', 'di era digital yang terus berkembang',
    'sebagai ai', 'perlu diketahui bahwa', 'pada akhirnya',
    'mari kita bahas bersama', 'tak dapat dipungkiri', 'pada dasarnya',
    'di sisi lain', 'secara keseluruhan', 'jadi intinya begini',
    'penting untuk dicatat', 'sebagai kesimpulan', 'yuk simak',
  ],
  // Note: bare Chinese connectors like 首先/其次/最后 are omitted — they are
  // ordinary words in conversational writing and produce false positives.
  // Only multi-word formulaic openers are listed.
  'zh-CN': [
    '在这个快节奏的时代', '在这个不断发展的', '作为一个ai',
    '不得不说', '值得一提的是', '总而言之', '综上所述',
    '让我们一起来看', '毫无疑问', '众所周知', '需要指出的是',
    '综上所述', '由此可见', '不言而喻', '在这个时代',
  ],
};

export const BANNED_UNIVERSAL = [
  'as an ai language model',
  'i hope this helps',
  'feel free to ask',
  'let me know if you',
  'in summary',
  'to sum up',
  'furthermore',
  'moreover',
  'delve',
  'tapestry',
  'testament to',
  'revolutionize',
  'game-changer', 'game changer',
  'unlock the power',
  'elevate your',
  'seamless',
  'cutting-edge',
  'robust solution',
  'leverage',
  'synergy',
  'holistic',
  'navigate',
  'landscape of',
  'realm of',
  'underscores',
  'pivotal',
  'myriad',
  'plethora',
];

// Em-dash overuse is the single most cited "written by ChatGPT" tell.
const EM_DASH_RE = /\s\u2014\s|\u2014/g;

// The classic "It's not X, it's Y" / "Not only X but Y" construction.
const PARALLELISM_RES = [
  /\bit'?s not (just )?[^.,!?]{2,40},? it'?s\b/i,
  /\bnot only\b[^.,!?]{2,60}\bbut also\b/i,
  /\bbukan (hanya |sekadar )?[^.,!?]{2,40},? (tapi|melainkan)\b/i,
  /不是[^。！？]{2,30}而是/,
  /不仅[^。！？]{2,30}而且/,
];

// Formulaic tricolon: three parallel short clauses separated by commas.
function hasTricolon(text) {
  const clauses = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  if (clauses.length < 3) return false;
  const lens = clauses.slice(0, 3).map(c => c.split(/\s+/).length);
  return lens.every(l => l > 0 && l <= 4) && new Set(lens).size <= 2 && clauses.length === 3;
}

export function findBannedPhrases(text, lang) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const phrase of BANNED_UNIVERSAL) {
    if (lower.includes(phrase)) hits.push(phrase);
  }
  const langList = BANNED_OPENERS[lang] || [];
  for (const phrase of langList) {
    if (lower.includes(phrase)) hits.push(phrase);
  }
  return hits;
}

/**
 * Heuristic 0-100 "how much does this read like an LLM wrote it".
 * Not a classifier — just the sum of the tells that are cheap to detect.
 */
export function aiSmellScore(text, lang) {
  let score = 0;
  const reasons = [];

  const banned = findBannedPhrases(text, lang);
  if (banned.length) {
    score += Math.min(60, banned.length * 22);
    reasons.push(`banned: ${banned.slice(0, 3).join(', ')}`);
  }

  const emDashes = (text.match(EM_DASH_RE) || []).length;
  if (emDashes > 0) {
    score += Math.min(24, emDashes * 12);
    reasons.push(`em-dash x${emDashes}`);
  }

  for (const re of PARALLELISM_RES) {
    if (re.test(text)) {
      score += 20;
      reasons.push('formulaic parallelism');
      break;
    }
  }

  if (hasTricolon(text)) {
    score += 14;
    reasons.push('tricolon list');
  }

  // Perfectly even sentence lengths read as generated.
  const sents = text.split(/[.!?。！？]+/).map(s => s.trim()).filter(Boolean);
  if (sents.length >= 2) {
    const lens = sents.map(s => s.split(/\s+/).length);
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const varc = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    if (mean > 6 && Math.sqrt(varc) < 1.6) {
      score += 12;
      reasons.push('uniform sentence length');
    }
  }

  // Hedging stacks.
  const hedges = (text.match(/\b(may|might|could possibly|it depends|generally speaking|tends to)\b/gi) || []).length;
  if (hedges >= 3) { score += 10; reasons.push('hedge stacking'); }

  // Every sentence starting with a capital + never a lowercase opener is fine
  // for English; instead penalise total absence of contractions in EN.
  if (lang === 'en-US' && text.length > 60) {
    const contractions = (text.match(/\b\w+'(s|t|re|ll|ve|d|m)\b/gi) || []).length;
    if (contractions === 0) { score += 8; reasons.push('no contractions'); }
  }

  // Verbosity. A reply that runs long is one of the most reliable tells that a
  // machine wrote it, so it has to cost on the score even when it stays under
  // the hard ceiling. Scaled by how far past the target it goes.
  const len = charCount(text);
  if (len > REPLY_LENGTH.target * 1.25) {
    const over = len / REPLY_LENGTH.target;
    const penalty = over > 2 ? 30 : over > 1.6 ? 18 : 8;
    score += penalty;
    reasons.push(`verbose for a reply (${len} chars, target ${REPLY_LENGTH.target})`);
  }

  return { score: Math.min(100, score), reasons };
}

// ─── 3. Slang ────────────────────────────────────────────────────────────────
// Required by the user. The prompt hands the model this word bank; the
// validator checks that at least one marker survived.

export const SLANG_BANK = {
  'en-US': [
    'ngl', 'fr', 'lowkey', 'highkey', 'no cap', 'vibe', 'vibes', 'mid',
    'fire', 'gassed', 'hyped', 'peak', 'sick', 'insane', 'wild', 'crazy',
    'bet', 'ate', 'ate that', 'cooked', 'rent free', 'hit different',
    'main character', 'iykyk', 'real', 'fax', 'bro', 'dude', 'yall',
    'kinda', 'gonna', 'wanna', 'ballin', 'slaps', 'goated', 'clapped',
    'ratio', 'square up', 'deadass', 'big brain', 'brain rot', 'cope',
  ],
  'id-ID': [
    'gabut', 'gacor', 'anjir', 'cuy', 'bro', 'bgt', 'banget', 'sih',
    'ngga', 'gak', 'udah', 'kayak', 'kaya gitu', 'receh', 'ngeri',
    'auto', 'fix', 'parah', 'gilak', 'sultan', 'cuan', 'boncos',
    'mantul', 'kepo', 'mager', 'santuy', 'cringe', 'sepoi', 'wkwk',
    'hehe', 'jir', 'dah', 'lah', 'dong', 'nih', 'tuh', 'gas', 'gaskan',
    'nampol', 'kece', 'joss', 'gokil', 'nyesel', 'worth it banget',
  ],
  'zh-CN': [
    '绝了', '牛', '太牛了', '离谱', '笑死', '有点东西', '搞定了',
    '真的服', '爆炸', '上头', '破防', '绷不住了', 'yyds', 'emmm',
    '哈哈', '香', '真香', '摆烂', '内卷', '别卷了', '整活',
    '拿捏', '心动', 'nice', '稳', '可以可以', '这不就来了',
    '很顶', '顶', '搞起来', '冲', 'punchline',
  ],
};

export function findSlang(text, lang) {
  const lower = text.toLowerCase();
  const bank = SLANG_BANK[lang] || [];
  const hits = [];
  for (const word of bank) {
    const w = word.toLowerCase();
    if (/[a-z]/.test(w)) {
      // Latin slang needs word boundaries, otherwise "fire" matches "firefly".
      const re = new RegExp(`(^|[^a-z])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
      if (re.test(lower)) hits.push(word);
    } else if (text.includes(word)) {
      // CJK has no word boundaries — substring is the right check.
      hits.push(word);
    }
  }
  return hits;
}

// ─── Location / length sanity ────────────────────────────────────────────────
export function charCount(text) {
  // X counts CJK as 2 units; approximate with code-point length for Latin.
  let n = 0;
  for (const ch of text) n += /[\u3000-\u9FFF\uFF00-\uFFEF]/.test(ch) ? 2 : 1;
  return n;
}

/**
 * Word count for length purposes.
 *
 * For space-delimited scripts this is just the token count. For Chinese it is
 * deliberately the CHARACTER count divided by two, not the number of characters:
 * treating every hanzi as a word made an ordinary 22-character reply register
 * as 21 "words" and trip the ceiling, which is why a perfectly good zh-CN draft
 * was being flagged too_long while its AI-smell score was 0. X already weights
 * CJK at 2 units, so the same weighting keeps the two rules consistent.
 */
export function countWords(text) {
  const latin = (text.match(/[A-Za-z0-9']+/g) || []).length;
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  if (!cjk) return latin;
  return latin + Math.ceil(cjk / 2);
}

// ─── Repetition across drafts ────────────────────────────────────────────────
export function jaccard(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').split(/\s+/).filter(Boolean);
  const A = new Set(norm(a));
  const B = new Set(norm(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// ─── Master validator ────────────────────────────────────────────────────────
/**
 * @param {string} text  draft body
 * @param {{lang:string, maxChars:number}} opts
 * @returns {{ok:boolean, blocking:string[], quality:object}}
 */
export function validateDraft(text, { lang, maxChars = REPLY_LENGTH.max }) {
  const clean = (text || '').trim();
  const blocking = [];
  // Never let a stale stored setting raise the ceiling above the reply policy.
  // A saved maxChars of 260 predates this rule and would otherwise make every
  // long draft pass.
  const ceiling = Math.min(maxChars, REPLY_LENGTH.max);

  if (!clean) {
    return {
      ok: false,
      blocking: ['empty'],
      quality: { emoji: [], banned: [], aiSmell: 100, slang: [], repetition: 0, chars: 0, words: 0, reasons: ['empty output'] },
    };
  }

  const emoji = findEmoji(clean);
  if (emoji.length) blocking.push('emoji');

  const banned = findBannedPhrases(clean, lang);
  if (banned.length) blocking.push('banned_phrase');

  const { score, reasons } = aiSmellScore(clean, lang);
  if (score >= 45) blocking.push('ai_smell');

  const slang = findSlang(clean, lang);
  // Slang is a soft requirement — flagging it without blocking avoids
  // rejecting otherwise-good formal/edukatif drafts outright.
  const slangMissing = slang.length === 0;

  const chars = charCount(clean);
  if (chars > ceiling) blocking.push('too_long');

  // Reply shape. Length is graded rather than merely capped, because a comment
  // that runs long reads as machine-written even when every other rule passes.
  const words = countWords(clean);
  if (words > REPLY_WORDS.max && !blocking.includes('too_long')) {
    blocking.push('too_long');
  }
  // Deliberately NO minimum-length rule.
  //
  // "fr this is it", "facts", "setuju bgt" and "确实是这样" are all real replies
  // that real people type. Blocking them would reject exactly the short,
  // human-sounding output this extension exists to produce, and push the model
  // toward padding drafts back out. Short is the goal here, not a defect.

  return {
    ok: blocking.length === 0,
    blocking,
    quality: {
      emoji,
      banned,
      aiSmell: score,
      slang,
      slangMissing,
      repetition: 0, // filled in by the caller across the whole draft set
      chars,
      words,
      // Signed distance from the target length, as a percentage. Negative means
      // shorter than the target, positive means longer. Used by the length
      // badge, which needs to distinguish "could say a bit more" from
      // "this is an essay".
      lengthDrift: Math.round((chars - REPLY_LENGTH.target) / REPLY_LENGTH.target * 100),
      reasons,
    },
  };
}

/**
 * Runs validateDraft over a set plus cross-draft repetition scoring.
 */
export function validateDraftSet(drafts, { lang, maxChars }) {
  const results = drafts.map(d => validateDraft(d.text, { lang, maxChars }));
  for (let i = 0; i < results.length; i++) {
    let worst = 0;
    for (let j = 0; j < results.length; j++) {
      if (i === j) continue;
      worst = Math.max(worst, jaccard(drafts[i].text, drafts[j].text));
    }
    results[i].quality.repetition = Math.round(worst * 100);
    if (worst > 0.62 && !results[i].blocking.includes('repetition')) {
      results[i].blocking.push('repetition');
      results[i].ok = false;
    }
  }
  return results;
}
