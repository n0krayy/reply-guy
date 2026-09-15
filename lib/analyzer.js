/**
 * Reply Guy — Offline tweet analyzer
 *
 * Deliberately heuristic. No network, no model. It exists so the prompt has
 * structured signal even when the LLM call is only borderline coherent, and so
 * the UI can show something useful instantly.
 *
 * Output shape:
 * {
 *   topic:      string,        // short label
 *   topics:     string[],      // keyword clusters present
 *   intent:     string,        // claim | question | announcement | hot_take | promo | story | shitpost
 *   sentiment:  { label, score, intensity },
 *   isQuestion: boolean,
 *   hooks:      string[],      // fragments worth replying to
 *   quotables:  string[],      // substrings safe to echo back
 *   entities:   { hashtags, mentions, cashtags, links, numbers },
 *   language:   string,        // best-guess BCP-47 of the tweet
 *   stats:      { chars, words, lines, hasMedia },
 *   replyAngles: string[],     // concrete angles a reply can take
 * }
 */

// ─── Stopword tables (used for topic extraction) ─────────────────────────────
const STOP = {
  en: new Set(('a an the and or but if then than that this these those is are was were be been being am ' +
    'do does did doing have has had having i you he she it we they me him her us them my your his its our their ' +
    'to of in on at by for with from about into over after before between out up down off again further once ' +
    'here there when where why how all any both each few more most other some such no nor not only own same so ' +
    'too very can will just should now would could get got make made really much many also like dont don t s re ve ll').split(/\s+/)),
  id: new Set(('yang di ke dari untuk pada dengan dan atau tapi tetapi kalau jika karena sebab agar supaya ' +
    'ini itu ada adalah ialah akan sudah telah belum masih bisa dapat harus perlu juga saja hanya ' +
    'saya aku kamu kau dia ia kami kita mereka gue gw lu lo anda nya ku mu ' +
    'tidak gak nggak bukan jangan belum udah sudah ' +
    'apa siapa mana kapan dimana bagaimana kenapa mengapa ' +
    'di ke dari pada untuk dengan yang sangat banget bgt ' +
    'lebih paling bisa akan sedang telah').split(/\s+/)),
  zh: new Set('的 了 是 在 我 有 和 就 不 人 都 一 一个 上 也 很 到 说 要 去 你 会 着 没有 看 好 自己 这 那 他 她 它 们 与 及 或 但 而 因为 所以 如果 虽然 但是 可以 需要 应该 可能 已经 正在 还是 就是 什么 怎么 为什么 哪个'.split(/\s+/)),
};

// Lexicons for intent detection, per language.
const INTENT_LEX = {
  question: {
    en: [/\?/, /^(how|what|why|when|where|which|who|should i|is it|are there|anyone)\b/i, /\bthoughts\?/i, /\b(help|advice)\b/i],
    id: [/\?/, /\b(apa|siapa|mana|kapan|kenapa|gimana|bagaimana|kok|apakah)\b/i, /\bmenurut\b/i],
    zh: [/[？?]/, /(吗|呢|怎么|为什么|如何|哪个|是不是|有没有)/],
  },
  promo: {
    en: [/\b(launch|launching|launched|pre-?order|waitlist|beta|sign ?up|dm me|link in bio|available now|drop(ping)? (soon|today)|free trial|discount|promo)\b/i],
    id: [/\b(launching|rilis|presale|pre-?order|daftar|link di bio|dm aja|gratis|diskon|promo|open (order|po))\b/i],
    zh: [/(上线|发布|预售|预约|报名|免费|折扣|优惠|扫码|私信)/],
  },
  announcement: {
    en: [/\b(announc|introduc|releas|update|shipping|we just|i just (shipped|built|finished|dropped))\b/i],
    id: [/\b(mengumumkan|meluncurkan|merilis|update|baru saja)\b/i],
    zh: [/(宣布|发布|推出|上线|刚刚)/],
  },
  hotTake: {
    en: [/\b(unpopular opinion|hot take|change my mind|overrated|underrated|nobody talks about|stop (doing|using)|is dead|is over)\b/i],
    id: [/\b(unpopular opinion|hot take|overrated|underrated|sebenernya|faktanya|yang bener|stop)\b/i],
    zh: [/(说实话|说句实话|不吹不黑|冷知识|其实)/],
  },
  story: {
    en: [/\b(yesterday|last (week|month|year)|i remember|back in|story time|when i was|so i)\b/i],
    id: [/\b(kemarin|minggu lalu|bulan lalu|tahun lalu|waktu itu|ceritanya|jadi gini)\b/i],
    zh: [/(昨天|上周|上个月|去年|当时|记得|故事)/],
  },
};

// Soft-sentiment lexicon. Scored then normalised.
const SENTIMENT = {
  pos: {
    en: ['love', 'great', 'awesome', 'amazing', 'best', 'win', 'wins', 'winning', 'profit', 'bullish', 'pumped', 'excited', 'happy', 'proud', 'works', 'working', 'shipped', 'shipping', 'beautiful', 'incredible', 'thank', 'grateful', 'fire', 'goated'],
    id: ['cinta', 'bagus', 'keren', 'mantap', 'terbaik', 'menang', 'cuan', 'untung', 'bullish', 'semangat', 'senang', 'bangga', 'jalan', 'rilis', 'indah', 'luar biasa', 'makasih', 'syukur', 'gacor', 'mantul'],
    zh: ['喜欢', '爱', '棒', '厉害', '最好', '赢', '赚', '涨', '兴奋', '开心', '骄傲', '成功', '发布', '漂亮', '感谢', '牛', '绝了', '顶'],
  },
  neg: {
    en: ['hate', 'worst', 'bad', 'terrible', 'awful', 'lose', 'losing', 'loss', 'bearish', 'dump', 'rug', 'scam', 'broken', 'fails', 'failed', 'fail', 'angry', 'tired', 'annoying', 'disappointed', 'ugly', 'crash', 'rekt'],
    id: ['benci', 'terburuk', 'jelek', 'buruk', 'rugi', 'bearish', 'dump', 'rug', 'scam', 'rusak', 'gagal', 'marah', 'capek', 'nyebelin', 'kecewa', 'jelek', 'boncos', 'nyangkut'],
    zh: ['讨厌', '最差', '差', '糟', '亏', '跌', '跑路', '骗', '坏', '失败', '生气', '累', '烦', '失望', '崩', '套牢'],
  },
};

// Topic keyword clusters — a tiny hand-built taxonomy beats a bad ML model here.
const TOPIC_CLUSTERS = [
  { label: 'crypto',       terms: ['crypto', 'bitcoin', 'btc', 'eth', 'ethereum', 'solana', 'sol', 'defi', 'web3', 'nft', 'airdrop', 'token', 'wallet', 'blockchain', 'onchain', 'on-chain', 'staking', 'yield', 'kripto', 'koin', 'dompet'] },
  { label: 'trading',      terms: ['trade', 'trading', 'chart', 'ta', 'bullish', 'bearish', 'long', 'short', 'leverage', 'position', 'entry', 'tp', 'sl', 'candle', 'support', 'resistance', 'saham', 'trading', 'cuan', 'profit', 'loss'] },
  { label: 'ai',           terms: ['ai', 'llm', 'gpt', 'claude', 'gemini', 'model', 'agent', 'agents', 'prompt', 'rag', 'inference', 'training', 'neural', 'diffusion', '人工智能', '模型', '智能体'] },
  { label: 'dev',          terms: ['code', 'coding', 'developer', 'dev', 'javascript', 'python', 'rust', 'typescript', 'react', 'api', 'bug', 'refactor', 'deploy', 'database', 'repo', 'github', 'compiler', 'koding', 'ngoding'] },
  { label: 'security',     terms: ['security', 'hack', 'hacker', 'exploit', 'vuln', 'vulnerability', 'cve', 'bug bounty', 'pentest', 'malware', 'phishing', 'ransomware', 'keamanan', 'peretasan'] },
  { label: 'marketing',    terms: ['marketing', 'growth', 'funnel', 'audience', 'engagement', 'conversion', 'ctr', 'copywriting', 'branding', 'seo', 'ads', 'campaign', 'pemasaran', 'jualan', 'iklan'] },
  { label: 'business',     terms: ['startup', 'founder', 'saas', 'mrr', 'arr', 'revenue', 'churn', 'product', 'launch', 'pricing', 'customer', 'b2b', 'bisnis', 'usaha', 'pendapatan', 'pelanggan'] },
  { label: 'content',      terms: ['content', 'creator', 'youtube', 'tiktok', 'instagram', 'threads', 'newsletter', 'podcast', 'writing', 'blog', 'video', 'konten', 'kreator'] },
  { label: 'career',       terms: ['job', 'career', 'hiring', 'interview', 'resume', 'salary', 'internship', 'layoff', 'remote', 'freelance', 'kerja', 'karier', 'gaji', 'lowongan'] },
  { label: 'health',       terms: ['workout', 'gym', 'run', 'running', 'sleep', 'diet', 'health', 'mental', 'fitness', 'protein', 'olahraga', 'kesehatan', 'tidur'] },
  { label: 'politics',     terms: ['politics', 'election', 'government', 'policy', 'senate', 'vote', 'law', 'regulation', 'politik', 'pemerintah', 'undang-undang'] },
  { label: 'sports',       terms: ['football', 'soccer', 'nba', 'nfl', 'match', 'game', 'score', 'team', 'league', 'bola', 'pertandingan', 'tim'] },
  { label: 'food',         terms: ['food', 'cook', 'recipe', 'coffee', 'restaurant', 'eat', 'meal', 'makanan', 'masak', 'kopi', 'resep'] },
  { label: 'travel',       terms: ['travel', 'flight', 'trip', 'hotel', 'visa', 'airport', 'vacation', 'liburan', 'jalan-jalan', 'tiket'] },
  { label: 'life',         terms: ['life', 'mindset', 'habit', 'discipline', 'focus', 'motivation', 'happiness', 'hidup', 'kebiasaan', 'disiplin', 'semangat'] },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────
function detectLanguage(text) {
  const cjk = (text.match(/[\u4E00-\u9FFF]/g) || []).length;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk > 0 && cjk * 6 > latin) return 'zh-CN';

  const words = (text.toLowerCase().match(/[a-z']+/g) || []);
  const idMarkers = new Set(['yang', 'dan', 'nggak', 'gak', 'udah', 'banget', 'bgt', 'saya', 'kamu', 'itu', 'ini', 'untuk', 'dengan', 'tidak', 'bisa', 'juga', 'dari', 'akan', 'kalau', 'karena', 'aja', 'gimana', 'kok', 'sih', 'nya', 'dong', 'deh', 'cuy', 'bang']);
  const enMarkers = new Set(['the', 'and', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'that', 'this', 'it', 'you', 'for', 'with', 'on', 'have', 'has', 'not', 'but', 'they', 'we', 'what', 'how']);
  let id = 0, en = 0;
  for (const w of words) {
    if (idMarkers.has(w)) id++;
    if (enMarkers.has(w)) en++;
  }
  if (id > en) return 'id-ID';
  return 'en-US';
}

function words(text) {
  return (text.toLowerCase().match(/[a-z\u00C0-\u024F']+/g) || []);
}

function stopSet(lang) {
  if (lang === 'id-ID') return STOP.id;
  if (lang === 'zh-CN') return STOP.zh;
  return STOP.en;
}

function extractKeywords(text, lang, limit = 8) {
  const stop = stopSet(lang);
  const freq = new Map();

  if (lang === 'zh-CN') {
    // Crude bigram extraction over CJK runs.
    const runs = text.match(/[\u4E00-\u9FFF]{2,}/g) || [];
    for (const run of runs) {
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 2);
        if (STOP.zh.has(bg)) continue;
        freq.set(bg, (freq.get(bg) || 0) + 1);
      }
    }
  } else {
    for (const w of words(text)) {
      if (w.length < 3) continue;
      if (stop.has(w)) continue;
      if (/^\d+$/.test(w)) continue;
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }

  // Score = frequency, tie-broken by length (longer = more specific).
  return [...freq.entries()]
    .map(([w, c]) => ({ word: w, count: c, score: c * 10 + Math.min(w.length, 12) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(e => e.word);
}

function extractEntities(text) {
  const uniq = (arr) => [...new Set(arr)];
  return {
    hashtags: uniq(text.match(/#[\p{L}\p{N}_]+/gu) || []),
    mentions: uniq(text.match(/@[A-Za-z0-9_]{1,15}/g) || []),
    cashtags: uniq(text.match(/\$[A-Za-z]{1,10}\b/g) || []),
    links: uniq(text.match(/https?:\/\/[^\s]+/g) || []),
    numbers: uniq((text.match(/\b\d[\d,.]*%?\b/g) || [])).slice(0, 8),
  };
}

function detectIntent(text, lang) {
  const langKey = lang === 'id-ID' ? 'id' : (lang === 'zh-CN' ? 'zh' : 'en');
  const matched = [];
  for (const key of Object.keys(INTENT_LEX)) {
    const res = INTENT_LEX[key][langKey] || [];
    for (const re of res) {
      if (re.test(text)) { matched.push(key); break; }
    }
  }

  // Priority matters. A tweet that states a strong opinion and then asks for
  // replies is a hot take, not a question — replying to it as a question
  // produces a flat answer instead of a stance. Same for promos that end in a
  // question. An explicit leading interrogative is the only thing that
  // promotes 'question' above those.
  const trimmed = text.trim();
  const opensWithQuestion =
    /^\s*(how|what|why|when|where|which|who|should i|is it|are there|anyone|any\b)/i.test(trimmed) ||
    /^\s*(apa|siapa|mana|kapan|kenapa|gimana|bagaimana|kok|apakah)\b/i.test(trimmed) ||
    /^\s*(怎么|为什么|如何|哪个|是不是|有没有|什么)/.test(trimmed);

  const PRIORITY = ['hotTake', 'promo', 'announcement', 'story', 'question'];

  if (matched.includes('question')) {
    if (opensWithQuestion) return { intent: 'question', matched };
    const stronger = PRIORITY.find(k => k !== 'question' && matched.includes(k));
    if (stronger) return { intent: stronger, matched };
    return { intent: 'question', matched };
  }
  if (matched.length) return { intent: matched[0], matched };

  // Short tweets with no terminal punctuation read as shitposts.
  if (text.length < 90 && !/[.!?。！？]$/.test(trimmed)) return { intent: 'shitpost', matched: [] };
  return { intent: 'claim', matched: [] };
}

function scoreSentiment(text, lang) {
  const langKey = lang === 'id-ID' ? 'id' : (lang === 'zh-CN' ? 'zh' : 'en');
  const lower = text.toLowerCase();
  let pos = 0, neg = 0;

  if (lang === 'zh-CN') {
    for (const w of SENTIMENT.pos.zh) if (text.includes(w)) pos++;
    for (const w of SENTIMENT.neg.zh) if (text.includes(w)) neg++;
  } else {
    for (const w of SENTIMENT.pos[langKey]) {
      if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) pos++;
    }
    for (const w of SENTIMENT.neg[langKey]) {
      if (new RegExp(`\\b${w}\\b`, 'i').test(lower)) neg++;
    }
  }

  // Punctuation intensity signals.
  const bangs = (text.match(/!/g) || []).length;
  const caps = (text.match(/[A-Z]{4,}/g) || []).length;
  const intensity = Math.min(3, Math.floor((bangs + caps) / 2));

  const total = pos + neg;
  let label = 'neutral';
  if (total > 0) label = pos > neg ? 'positive' : (neg > pos ? 'negative' : 'mixed');

  const score = total === 0 ? 0 : (pos - neg) / total;
  return { label, score: Number(score.toFixed(2)), intensity, pos, neg };
}

function detectTopics(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const cluster of TOPIC_CLUSTERS) {
    let hits = 0;
    for (const t of cluster.terms) {
      if (t.length <= 3) {
        if (new RegExp(`(^|[^a-z])${t}([^a-z]|$)`, 'i').test(lower)) hits++;
      } else if (lower.includes(t) || text.includes(t)) {
        hits++;
      }
    }
    if (hits > 0) found.push({ label: cluster.label, hits });
  }
  found.sort((a, b) => b.hits - a.hits);
  return found.map(f => f.label);
}

function extractHooks(text) {
  // Split into sentences (Latin + CJK terminators), keep the punchiest ones.
  const parts = text
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 12);

  const scored = parts.map(s => {
    let s2 = 0;
    if (/\d/.test(s)) s2 += 2;                        // numbers are concrete
    if (/\?|？/.test(s)) s2 += 2;                     // questions invite replies
    if (/(i |my |we |our |saya |aku |gue |kami |我|我们)/i.test(s)) s2 += 1; // personal stake
    if (s.length < 160) s2 += 1;                      // quotable length
    if (/\b(never|always|nobody|everyone|stop|must|harus|jangan|永远|必须)\b/i.test(s)) s2 += 1;
    return { s, score: s2 };
  });

  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(x => x.s);
}

function buildReplyAngles({ intent, sentiment, topics, hooks, isQuestion }) {
  const angles = [];

  if (isQuestion) {
    angles.push('Answer the question directly in the first clause, then add one supporting detail.');
    angles.push('If the question is opinion-based, give a clear pick and one reason.');
  }
  if (intent === 'hotTake') {
    angles.push('Either agree and sharpen their point, or disagree with one specific, respectful counter.');
  }
  if (intent === 'promo' || intent === 'announcement') {
    angles.push('React with a specific detail you noticed, not generic congratulations.');
  }
  if (intent === 'story') {
    angles.push('Share a one-line parallel from your own experience, then stop.');
  }
  if (intent === 'shitpost') {
    angles.push('Match the energy, do not explain the joke.');
  }
  if (sentiment.label === 'negative') {
    angles.push('Acknowledge the frustration first, then offer the smallest useful thing.');
  }
  if (sentiment.label === 'positive') {
    angles.push('Amplify with a concrete addition rather than plain praise.');
  }
  if (topics.includes('crypto') || topics.includes('trading')) {
    angles.push('Ask about the specific setup, timeframe, or thesis. Avoid price predictions.');
  }
  if (topics.includes('ai') || topics.includes('dev')) {
    angles.push('Add a practical implementation detail or a caveat from real use.');
  }
  if (topics.includes('business') || topics.includes('marketing')) {
    angles.push('Reference a number, a metric, or a concrete tactic.');
  }
  if (hooks.length) {
    angles.push(`Build on this fragment: "${hooks[0].slice(0, 110)}"`);
  }
  angles.push('Do not restate the tweet back to them. Assume they know what they wrote.');

  return [...new Set(angles)];
}

// ─── Main ────────────────────────────────────────────────────────────────────
export function analyzeTweet(text, meta = {}) {
  const body = (text || '').trim();
  if (!body) {
    return null;
  }

  const language = detectLanguage(body);
  const keywords = extractKeywords(body, language);
  const topics = detectTopics(body);
  const entities = extractEntities(body);
  const { intent, matched } = detectIntent(body, language);
  const sentiment = scoreSentiment(body, language);
  const hooks = extractHooks(body);
  const isQuestion = /[?？]/.test(body) ||
    (INTENT_LEX.question[language === 'id-ID' ? 'id' : (language === 'zh-CN' ? 'zh' : 'en')] || [])
      .some(re => re.test(body));

  const replyAngles = buildReplyAngles({ intent, sentiment, topics, hooks, isQuestion });

  return {
    text: body,
    topic: topics[0] || keywords[0] || 'general',
    topics,
    keywords,
    intent,
    intentSignals: matched,
    sentiment,
    isQuestion,
    hooks,
    quotables: hooks.slice(0, 2),
    entities,
    language,
    stats: {
      chars: body.length,
      words: words(body).length + (body.match(/[\u4E00-\u9FFF]/g) || []).length,
      lines: body.split('\n').length,
      hasMedia: !!meta.hasMedia,
    },
    replyAngles,
    author: meta.author || null,
    fetchedAt: Date.now(),
  };
}

/**
 * Compact text block that the prompt builder embeds. Kept short — analysis is
 * signal, not a payload.
 */
export function summarizeAnalysis(a) {
  if (!a) return 'No analysis available.';
  const lines = [
    `Detected language: ${a.language}`,
    `Intent: ${a.intent}${a.intentSignals.length ? ` (signals: ${a.intentSignals.join(', ')})` : ''}`,
    `Sentiment: ${a.sentiment.label} (score ${a.sentiment.score}, intensity ${a.sentiment.intensity}/3)`,
    `Topics: ${a.topics.length ? a.topics.join(', ') : a.topic}`,
    `Keywords: ${a.keywords.slice(0, 6).join(', ') || 'none'}`,
  ];
  if (a.entities.hashtags.length) lines.push(`Hashtags: ${a.entities.hashtags.join(' ')}`);
  if (a.entities.mentions.length) lines.push(`Mentions: ${a.entities.mentions.join(' ')}`);
  if (a.entities.cashtags.length) lines.push(`Cashtags: ${a.entities.cashtags.join(' ')}`);
  if (a.hooks.length) lines.push(`Reply-able fragments: ${a.hooks.map(h => `"${h.slice(0, 120)}"`).join(' | ')}`);
  lines.push(`Reply angles: ${a.replyAngles.join(' ')}`);
  if (a.author) lines.push(`Author: @${a.author.screen_name} (${a.author.name})`);
  return lines.join('\n');
}
