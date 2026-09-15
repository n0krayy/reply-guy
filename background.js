/**
 * Reply Guy — Background Service Worker
 *
 * Architecture follows the reference repo (kysoog/x-unfollowers):
 *   - auth is scraped from the x.com tab and cached in chrome.storage.local
 *   - all X API calls happen here, never in the popup
 *   - MV3 workers get killed, so any multi-step state lives in storage
 *
 * New in this project:
 *   - tweet fetching through GraphQL with a REST v1.1 fallback
 *   - the generation pipeline (prompt -> LLM -> validate -> repair -> validate)
 *   - a composer-safety gate that refuses inserts outside a status page
 */

import { TWEET_QUERY_IDS, COMPOSE_FEATURE_FLAGS } from './lib/constants.js';
import { buildSystemPrompt, buildUserPrompt, buildRepairPrompt } from './lib/prompt.js';
import { validateDraftSet, validateDraft, jaccard } from './lib/rules.js';
import { analyzeTweet } from './lib/analyzer.js';
import { chatCompletion, extractJSON, getProvider, listModels, validateProviderConfig, testConnection } from './lib/providers.js';

/**
 * Builds the config object passed to the LLM adapter.
 *
 * For the five named providers the base URL and model are taken from the
 * registry, NOT from saved settings. A stale or hand-edited `baseUrl` must
 * never be able to send the user's key to a host they did not choose. Only
 * the `custom` provider honours a user-supplied base URL.
 */
function resolveLLMConfig(settings) {
  const p = getProvider(settings?.provider);
  const isCustom = p.id === 'custom';
  return {
    provider: p.id,
    baseUrl: isCustom ? String(settings?.baseUrl || '').trim() : p.baseUrl,
    model: String(settings?.model || '').trim() || p.defaultModel,
    apiKey: String(settings?.apiKey || '').trim(),
  };
}

/**
 * Strips a base URL down to an origin pattern Chrome understands as a host
 * permission, e.g. "https://card.vantis.sh" -> "https://card.vantis.sh/*".
 *
 * Host permission is REQUESTED from the popup (see popup/popup.js
 * requestHostAccess), because chrome.permissions.request() needs a live user
 * gesture and a message round-trip to this worker would consume it. The worker
 * only reads the current state to produce a clear error when access is missing.
 */
function originPattern(baseUrl) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  return `${u.protocol}//${u.host}/*`;
}

/**
 * Reports whether the extension may reach the given origin, without prompting.
 * Used to fail fast with a useful message instead of an opaque fetch error.
 */
async function checkHostPermission(baseUrl) {
  const pattern = originPattern(baseUrl);
  if (!pattern) return { ok: false, error: 'That base URL is not a valid http(s) URL.' };
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true };
  } catch { /* treated as not held */ }
  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch { /* keep raw */ }
  return {
    ok: false,
    error: `Reply Guy does not have access to ${host} yet. Open the panel and press Save & test to grant it.`,
  };
}

// ─── State ───────────────────────────────────────────────────────────────────
let authTokens = null;
const KEEPALIVE_ALARM = 'reply-guy-keepalive';

// ─── Storage helpers ─────────────────────────────────────────────────────────
function getStored(key, fallback = null) {
  return new Promise(r => chrome.storage.local.get(key, o =>
    r(o[key] !== undefined ? o[key] : fallback)));
}
function setStored(key, value) {
  return new Promise(r => chrome.storage.local.set({ [key]: value }, r));
}

// ─── Misc ────────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomDelay(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function broadcast(msg) { chrome.runtime.sendMessage(msg).catch(() => {}); }

// ─── Auth ────────────────────────────────────────────────────────────────────
async function ensureAuth() {
  if (!authTokens) authTokens = await getStored('authTokens', null);
  if (!authTokens || !authTokens.csrf) {
    throw new Error('Not authenticated. Open x.com in a tab and log in.');
  }
  return authTokens;
}

function makeHeaders(extra = {}) {
  return {
    'authorization': authTokens.bearer,
    'x-csrf-token': authTokens.csrf,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'content-type': 'application/json',
    'cookie': authTokens.cookie,
    ...extra,
  };
}

class AuthError extends Error {}

// ─── Fetch with bounded backoff ──────────────────────────────────────────────
async function apiFetch(url, options = {}, cfg = {}) {
  const maxRetries = cfg.maxRetries ?? 3;
  const baseMin = cfg.baseMin ?? 5000;
  const baseMax = cfg.baseMax ?? 12000;
  let attempt = 0;

  while (true) {
    let res;
    try {
      res = await fetch(url, { ...options, credentials: 'include' });
    } catch (netErr) {
      if (attempt++ >= maxRetries) throw new Error(`Network error: ${netErr.message}`);
      await sleep(randomDelay(1200, 3000) * attempt);
      continue;
    }

    if (res.status === 429) {
      if (attempt++ >= maxRetries) {
        throw new Error('Rate limited (429). X is throttling. Try again in a few minutes.');
      }
      const wait = randomDelay(baseMin, baseMax) * attempt;
      broadcast({ type: 'RG_RATE_LIMITED', wait });
      await sleep(wait);
      continue;
    }

    return res;
  }
}

// ─── Tweet fetching ──────────────────────────────────────────────────────────
function buildFeaturesParam() {
  const f = {};
  for (const k of COMPOSE_FEATURE_FLAGS) f[k] = true;
  // These must be strings on the wire for X's parser.
  f.rweb_video_hd_enabled = true;
  f.vibe_api_enabled = true;
  f.responsive_web_phoenix_sidebar_navigation_enabled = true;
  f.responsive_web_grok_analyze_post_followups_enabled = false;
  return JSON.stringify(f);
}

function buildFieldToggles() {
  return JSON.stringify({
    withArticleRichContentState: true,
    withArticlePlainText: false,
    withGrokAnalyze: false,
    withDisallowedReplyControls: false,
  });
}

function normalizeTweet(result) {
  if (!result) return null;
  const legacy = result.legacy || result;
  const userResult = result.core?.user_results?.result || legacy.user || {};
  const userLegacy = userResult.legacy || userResult;

  const noteText = result.note_tweet?.note_tweet_results?.result?.text;
  const fullText = noteText || legacy.full_text || legacy.text || '';

  return {
    id: result.rest_id || legacy.id_str || null,
    text: fullText,
    created_at: legacy.created_at || null,
    lang: legacy.lang || null,
    conversation_id: legacy.conversation_id_str || null,
    reply_count: legacy.reply_count || 0,
    in_reply_to_status_id: legacy.in_reply_to_status_id_str || null,
    in_reply_to_screen_name: legacy.in_reply_to_screen_name || null,
    is_retweet: !!(legacy.retweeted_status_result || legacy.retweeted_status_id_str),
    metrics: {
      likes: legacy.favorite_count || 0,
      replies: legacy.reply_count || 0,
      retweets: legacy.retweet_count || 0,
      quotes: legacy.quote_count || 0,
      views: Number(result.views?.count || legacy.ext_views?.count || 0) || 0,
    },
    author: {
      id: userResult.rest_id || userLegacy.id_str || null,
      name: userLegacy.name || '',
      screen_name: userLegacy.screen_name || '',
      followers: userLegacy.followers_count || 0,
      verified: !!(userResult.is_blue_verified || userLegacy.verified),
      description: userLegacy.description || '',
      avatar: (userLegacy.profile_image_url_https || '').replace('_normal', '_200x200'),
    },
    hasMedia: !!(legacy.extended_entities?.media?.length || legacy.entities?.media?.length),
    entities: {
      hashtags: (legacy.entities?.hashtags || []).map(h => h.text),
      mentions: (legacy.entities?.user_mentions || []).map(m => m.screen_name),
      urls: (legacy.entities?.urls || []).map(u => u.expanded_url),
    },
  };
}

/** Primary path: GraphQL TweetResultByRestId, trying known query ids. */
async function fetchTweetGraphQL(tweetId) {
  await ensureAuth();
  const features = encodeURIComponent(buildFeaturesParam());
  const fieldToggles = encodeURIComponent(buildFieldToggles());
  const variables = encodeURIComponent(JSON.stringify({
    tweetId,
    withCommunity: false,
    includePromotedContent: false,
    withVoice: false,
  }));

  const errors = [];
  for (const qid of TWEET_QUERY_IDS) {
    const url = `https://x.com/i/api/graphql/${qid}/TweetResultByRestId`
      + `?variables=${variables}&features=${features}&fieldToggles=${fieldToggles}`;
    try {
      const res = await apiFetch(url, { headers: makeHeaders() });
      if (res.status === 404 || res.status === 400) {
        errors.push(`${qid}: ${res.status}`);
        continue; // stale query id, try the next
      }
      if (res.status === 401 || res.status === 403) throw new AuthError('X auth expired. Refresh x.com.');
      if (!res.ok) { errors.push(`${qid}: ${res.status}`); continue; }

      const json = await res.json();
      const result = json?.data?.tweetResult?.result;
      if (!result) { errors.push(`${qid}: empty result`); continue; }

      // Tombstones: deleted, suspended, protected, withheld.
      if (result.__typename === 'TweetTombstone' || result.tombstone) {
        throw new Error('That tweet is unavailable (deleted, protected, or withheld).');
      }
      const unwrapped = result.tweet || result;
      const normalized = normalizeTweet(unwrapped);
      if (normalized?.text) return normalized;
      errors.push(`${qid}: no text`);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      errors.push(`${qid}: ${err.message}`);
      await sleep(randomDelay(300, 800));
    }
  }
  throw new Error(`GraphQL tweet fetch failed (${errors.slice(0, 2).join('; ')})`);
}

/** Fallback: REST v1.1 show.json — stable endpoint, less rich data. */
async function fetchTweetREST(tweetId) {
  await ensureAuth();
  const params = new URLSearchParams({
    id: tweetId,
    tweet_mode: 'extended',
    include_entities: 'true',
    include_ext_alt_text: 'true',
  });
  const url = `https://x.com/i/api/1.1/statuses/show.json?${params}`;
  const res = await apiFetch(url, { headers: makeHeaders() });
  if (res.status === 401 || res.status === 403) throw new AuthError('X auth expired. Refresh x.com.');
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`REST tweet fetch failed: ${res.status} ${t.slice(0, 160)}`);
  }
  const json = await res.json();
  // Shape it like a GraphQL result so normalizeTweet can handle both.
  return normalizeTweet({
    rest_id: json.id_str,
    legacy: json,
    core: { user_results: { result: { rest_id: json.user?.id_str, legacy: json.user } } },
    views: { count: json.views?.count },
  });
}

/** Optional context: the author's recent tweets, so replies can reference history. */
async function fetchAuthorContext(authorId, excludeTweetId) {
  if (!authorId) return [];
  await ensureAuth();
  const params = new URLSearchParams({
    user_id: authorId,
    count: '6',
    include_rts: 'false',
    exclude_replies: 'true',
    tweet_mode: 'extended',
  });
  const url = `https://x.com/i/api/1.1/statuses/user_timeline.json?${params}`;
  const res = await apiFetch(url, { headers: makeHeaders() });
  if (!res.ok) return [];
  const tweets = await res.json().catch(() => []);
  if (!Array.isArray(tweets)) return [];
  return tweets
    .filter(t => t.id_str !== excludeTweetId)
    .slice(0, 4)
    .map(t => (t.full_text || t.text || '').slice(0, 240));
}

async function fetchTweet(tweetId, opts = {}) {
  // Cache first.
  const cached = await getStored('tweetCache', {});
  const hit = cached[tweetId];
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return hit.data;

  let tweet = null;
  let source = 'graphql';
  try {
    tweet = await fetchTweetGraphQL(tweetId);
  } catch (err) {
    if (err instanceof AuthError) throw err;
    console.warn('[Reply Guy] GraphQL failed, falling back to REST:', err.message);
    tweet = await fetchTweetREST(tweetId);
    source = 'rest';
  }
  if (!tweet) throw new Error('Tweet not found');

  if (opts.withAuthorContext && tweet.author?.id) {
    try {
      tweet.author.recentTweets = await fetchAuthorContext(tweet.author.id, tweet.id);
    } catch { /* optional */ }
  }

  tweet._source = source;
  const cache = await getStored('tweetCache', {});
  cache[tweetId] = { at: Date.now(), data: tweet };
  const keys = Object.keys(cache);
  if (keys.length > 80) {
    keys.sort((a, b) => cache[a].at - cache[b].at);
    for (const k of keys.slice(0, keys.length - 80)) delete cache[k];
  }
  await setStored('tweetCache', cache);
  return tweet;
}

// ─── Generation pipeline ─────────────────────────────────────────────────────
/**
 * Calls the LLM and returns raw drafts, then runs them through the validator.
 * Drafts that violate a blocking rule get one repair pass. Anything still
 * failing is kept but flagged, so the user sees ground truth rather than
 * silently-bad output.
 */
async function generateDrafts({ tweet, analysis, language, tones, draftsPerTone, settings, onProgress }) {
  const system = buildSystemPrompt();
  const user = buildUserPrompt({
    tweet, analysis, language, tones, draftsPerTone, maxChars: settings.maxChars,
  });

  onProgress?.({ phase: 'generating', message: 'Writing drafts...' });

  const raw = await chatCompletion(resolveLLMConfig(settings), {
    system, user,
    temperature: settings.temperature,
    maxTokens: Math.min(4000, 260 * draftsPerTone * tones.length + 400),
    jsonMode: true,
  }, { timeoutMs: 90000 });

  const parsed = extractJSON(raw);
  let drafts = Array.isArray(parsed) ? parsed : (parsed.drafts || []);
  drafts = drafts
    .filter(d => d && typeof d.text === 'string' && d.text.trim())
    .map(d => ({ tone: tones.includes(d.tone) ? d.tone : tones[0], text: d.text.trim() }));

  if (!drafts.length) throw new Error('Model returned no usable drafts. Try a different model.');

  // ── Validate as a set (cross-draft repetition is a set-level property) ──
  onProgress?.({ phase: 'validating', message: 'Checking style rules...' });
  let results = validateDraftSet(drafts, { lang: language, maxChars: settings.maxChars });

  // ── One repair pass for the failures ──
  const failing = results
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.blocking.length > 0);

  if (failing.length) {
    onProgress?.({ phase: 'repairing', message: `Fixing ${failing.length} draft(s)...` });
    // Cap the repair budget so a stubborn model cannot burn the whole run.
    //
    // Sequential, not parallel: each repair sees the drafts already fixed in
    // this loop. Two near-duplicate drafts repaired independently tend to
    // converge on the same replacement, which recreates the exact repetition
    // problem the repair was supposed to solve.
    for (const { i } of failing.slice(0, 6)) {
      const draft = drafts[i];
      const siblings = drafts.filter((_, j) => j !== i).map(d => d.text);
      try {
        const repairUser = buildRepairPrompt({
          original: draft.text,
          language,
          tone: draft.tone,
          violations: results[i].blocking,
          siblings,
        });
        const fixed = await chatCompletion(resolveLLMConfig(settings), {
          system,
          user: repairUser,
          temperature: Math.max(0.4, settings.temperature - 0.25),
          maxTokens: 400,
          jsonMode: true,
        }, { timeoutMs: 45000 });

        const p = extractJSON(fixed);
        const newText = (p.text || '').trim();
        if (newText) {
          const check = validateDraft(newText, { lang: language, maxChars: settings.maxChars });

          // Accept the rewrite only if it is actually better AND does not
          // introduce a new near-duplicate against its siblings.
          const worstOverlap = Math.max(
            0,
            ...siblings.map(s => jaccard(newText, s))
          );
          const createsDuplicate = worstOverlap > 0.62;

          const improves = check.ok || check.quality.aiSmell < results[i].quality.aiSmell;
          if (improves && !createsDuplicate) {
            drafts[i] = { ...draft, text: newText, repaired: true };
          }
        }
      } catch (err) {
        console.warn('[Reply Guy] Repair failed for draft', i, err.message);
      }
    }
    results = validateDraftSet(drafts, { lang: language, maxChars: settings.maxChars });
  }

  return drafts.map((d, i) => ({
    ...d,
    quality: results[i].quality,
    ok: results[i].ok,
    blocking: results[i].blocking,
  }));
}

// ─── Composer safety gate ────────────────────────────────────────────────────
/**
 * Hard guarantee that this extension never posts and never writes into a
 * context that is not a reply. Enforced here, not in the UI, so a UI bug
 * cannot bypass it.
 */
async function assertComposerContext(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('Target tab is gone. Reopen x.com and try again.');
  }
  const url = tab.url || '';
  if (!/^https:\/\/(x|twitter)\.com\//.test(url)) {
    throw new Error('Target tab is not on x.com.');
  }

  // Only a post detail view has a reply composer. /compose/post is a
  // standalone composer with no reply target, so it is excluded — inserting
  // there would be writing a new post, not a reply.
  if (!/\/status\/\d+/.test(url)) {
    throw new Error(
      'Refusing to insert: this tab is not on a post detail view. Open the post, then press Insert again.'
    );
  }

  return tab;
}

// ─── Message router ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'AUTH_TOKENS') {
    authTokens = msg.tokens;
    setStored('authTokens', msg.tokens).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'GET_AUTH_STATUS') {
    (async () => {
      if (!authTokens) authTokens = await getStored('authTokens', null);
      sendResponse({ authenticated: !!authTokens, userId: authTokens?.userId || null });
    })();
    return true;
  }

  if (msg.type === 'FETCH_TWEET') {
    (async () => {
      try {
        const tweet = await fetchTweet(msg.tweetId, { withAuthorContext: msg.withAuthorContext });
        sendResponse({ ok: true, tweet });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'ANALYZE_TWEET') {
    (async () => {
      try {
        let tweet = msg.tweet;
        if (!tweet) tweet = await fetchTweet(msg.tweetId, { withAuthorContext: false });
        const analysis = analyzeTweet(tweet.text, {
          hasMedia: tweet.hasMedia,
          author: tweet.author,
        });
        sendResponse({ ok: true, tweet, analysis });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GENERATE_DRAFTS') {
    (async () => {
      try {
        const settings = msg.settings;
        // Fail before spending a network round-trip. This produces "Paste your
        // DeepSeek API key first" rather than a raw 401 from the vendor.
        const check = validateProviderConfig(settings);
        if (!check.ok) throw new Error(check.error);

        const drafts = await generateDrafts({
          tweet: msg.tweet,
          analysis: msg.analysis,
          language: msg.language,
          tones: msg.tones,
          draftsPerTone: msg.draftsPerTone || 3,
          settings,
          onProgress: (p) => broadcast({ type: 'RG_PROGRESS', ...p }),
        });

        // Persist for the history view.
        const history = await getStored('draftHistory', []);
        const entries = drafts.map(d => ({
          id: `${msg.tweet.id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          tweetId: msg.tweet.id,
          tweetText: msg.tweet.text.slice(0, 200),
          author: msg.tweet.author?.screen_name,
          language: msg.language,
          tone: d.tone,
          text: d.text,
          quality: d.quality,
          at: Date.now(),
        }));
        await setStored('draftHistory', [...entries, ...history].slice(0, 300));

        const usage = await getStored('usage', null);
        const today = new Date().toISOString().slice(0, 10);
        const u = (!usage || usage.date !== today) ? { date: today, calls: 0 } : usage;
        u.calls += 1;
        await setStored('usage', u);

        sendResponse({ ok: true, drafts });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'INSERT_REPLY') {
    (async () => {
      try {
        const tabId = msg.tabId ?? sender.tab?.id;
        if (!tabId) throw new Error('No target tab.');

        await assertComposerContext(tabId);

        // Ensure the composer is open.
        const opened = await chrome.tabs.sendMessage(tabId, {
          type: 'OPEN_COMPOSER', tweetId: msg.tweetId,
        });
        if (!opened?.ok) {
          throw new Error('Could not open the reply box. Open it manually on the post, then press Insert again.');
        }

        const result = await chrome.tabs.sendMessage(tabId, {
          type: 'INSERT_REPLY', text: msg.text, replace: true,
        });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_TARGET_TWEET') {
    (async () => {
      try {
        const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        // Prefer the active tab, then any tab on a status page.
        const active = tabs.find(t => t.active) || tabs.find(t => /\/status\/\d+/.test(t.url || '')) || tabs[0];
        if (!active) { sendResponse({ ok: false, error: 'No x.com tab open.' }); return; }
        const res = await chrome.tabs.sendMessage(active.id, { type: 'GET_TARGET_TWEET' });
        sendResponse({ ...res, tabId: active.id, tabUrl: active.url });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'TEST_PROVIDER') {
    (async () => {
      try {
        const cfg = resolveLLMConfig(msg.settings);
        const out = await testConnection(cfg, { timeoutMs: 20000 });
        sendResponse({ ok: true, ...out });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'LIST_MODELS') {
    (async () => {
      try {
        const cfg = resolveLLMConfig(msg.settings);
        // Read-only check. The popup already requested access on the click.
        const perm = await checkHostPermission(cfg.baseUrl);
        if (!perm.ok) { sendResponse({ ok: false, error: perm.error }); return; }
        const models = await listModels(cfg, { timeoutMs: 15000 });
        sendResponse({ ok: true, models });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  // Reports whether access exists. Deliberately does NOT request it: a
  // permission prompt raised from the worker has no user gesture behind it and
  // Chrome rejects it. The popup requests, this reports.
  if (msg.type === 'CHECK_HOST_PERMISSION') {
    (async () => {
      try {
        const cfg = resolveLLMConfig(msg.settings);
        const perm = await checkHostPermission(cfg.baseUrl);
        sendResponse(perm.ok ? { ok: true } : { ok: false, error: perm.error });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'GET_USAGE') {
    (async () => {
      const u = await getStored('usage', null);
      const today = new Date().toISOString().slice(0, 10);
      sendResponse({ ok: true, usage: (!u || u.date !== today) ? { date: today, calls: 0 } : u });
    })();
    return true;
  }
});

// ─── Keepalive + resume ──────────────────────────────────────────────────────
// Generation is a single request/response, so nothing needs resuming. The
// alarm exists purely to keep the worker warm while the side panel is open so
// the first Analyze press does not pay a cold-start penalty.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    getStored('authTokens', null).then(t => { if (t) authTokens = t; });
  }
});

// ─── Injection into already-open tabs on install/update ──────────────────────
async function injectIntoExistingTabs() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    } catch (e) {
      console.warn(`[Reply Guy] Could not inject into tab ${tab.id}:`, e.message);
    }
  }
}
chrome.runtime.onInstalled.addListener(() => injectIntoExistingTabs());
injectIntoExistingTabs();

// ─── Side panel on icon click ────────────────────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (e) {
    console.warn('[Reply Guy] sidePanel.open failed:', e.message);
  }
});

// Warm up.
ensureAuth().catch(() => {});
