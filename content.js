/**
 * Reply Guy — Content Script
 *
 * Two jobs:
 *  1. Extract X auth tokens + user id from the page and forward them to the
 *     service worker (same approach as the reference repo).
 *  2. Bridge between the extension and the X DOM: read the focused tweet id,
 *     focus the reply composer, and write text into it.
 *
 * The insert path is intentionally the only thing that touches the composer,
 * and it never clicks the post button.
 */

(function () {
  'use strict';

  if (window.__replyGuyInjected) return;
  window.__replyGuyInjected = true;

  // ─── Cookie helpers ─────────────────────────────────────────────────────
  function getCookieRaw(name) {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : null;
  }
  function getCookieDecoded(name) {
    const raw = getCookieRaw(name);
    if (!raw) return null;
    try { return decodeURIComponent(raw); } catch { return raw; }
  }

  // ─── Token extraction ───────────────────────────────────────────────────
  function extractTokens() {
    const csrf = getCookieRaw('ct0');
    if (!csrf) return null;
    return {
      csrf,
      bearer: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
      cookie: document.cookie,
    };
  }

  function extractUserId() {
    const twidRaw = getCookieRaw('twid');
    if (twidRaw) {
      const enc = twidRaw.match(/u%3D(\d+)/i);
      if (enc) return enc[1];
      const dec = twidRaw.match(/u=(\d+)/);
      if (dec) return dec[1];
    }
    const twidDecoded = getCookieDecoded('twid');
    if (twidDecoded) {
      const m = twidDecoded.match(/u=(\d+)/);
      if (m) return m[1];
    }
    const all = document.cookie.match(/twid=u(?:%3D|=)(\d+)/i);
    if (all) return all[1];

    // Fallback: scrape the GraphQL bootstrap payload for the viewer id.
    try {
      const scripts = document.querySelectorAll('script[type="application/json"]');
      for (const script of scripts) {
        const t = script.textContent || '';
        if (t.includes('"rest_id"') || t.includes('"id_str"')) {
          const m = t.match(/"(?:id_str|rest_id)"\s*:\s*"(\d+)"/);
          if (m) return m[1];
        }
      }
    } catch { /* ignore */ }

    return null;
  }

  function sendTokens() {
    const tokens = extractTokens();
    const userId = extractUserId();
    if (tokens && userId) {
      tokens.userId = userId;
      try {
        chrome.runtime.sendMessage({ type: 'AUTH_TOKENS', tokens }, () => {
          void chrome.runtime.lastError; // no receiver yet — fine
        });
      } catch { /* extension reloading */ }
      return true;
    }
    return false;
  }

  if (!sendTokens()) {
    let retries = 0;
    const iv = setInterval(() => {
      retries++;
      if (sendTokens() || retries >= 10) clearInterval(iv);
    }, 2000);
  }
  setInterval(sendTokens, 30000);

  // ─── Tweet id extraction from the DOM/URL ───────────────────────────────
  function tweetIdFromUrl() {
    const m = location.pathname.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * Walks up from the reply button to find the enclosing <article> and pulls
   * the status id out of any link inside it.
   */
  function tweetIdFromArticle(el) {
    const article = el?.closest?.('article');
    if (!article) return null;
    const link = article.querySelector('a[href*="/status/"]');
    if (!link) return null;
    const m = link.getAttribute('href').match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  /**
   * Reads a tweet straight out of the rendered page.
   *
   * This is the primary fetch path. X renders the whole tweet into the DOM
   * before we ever run, so scraping it needs no API call, no query id, and
   * cannot be broken by X rotating its GraphQL hashes or retiring the v1.1
   * REST endpoints. It also cannot rate-limit, because it is not a request.
   *
   * The extension still keeps its network paths as a fallback for tweets that
   * are not currently on screen.
   *
   * @returns {{text: string, author: object, hasMedia: boolean, id: string}|null}
   */
  function scrapeTweetFromDom(tweetId) {
    const articles = [...document.querySelectorAll('article')];

    // Prefer the article that actually contains this status id, so a reply
    // further down the thread never gets mistaken for the target.
    let article = null;
    for (const a of articles) {
      if (tweetIdFromArticle(a) === tweetId) { article = a; break; }
    }
    if (!article && tweetId) return null;
    if (!article) {
      article = document.querySelector('article[tabindex="-1"]') || articles[0] || null;
    }
    if (!article) return null;

    // Tweet body. X marks it data-testid="tweetText"; the lang attribute and
    // nested spans/dividers carry emoji and formatting we want to preserve.
    const textEl = article.querySelector('[data-testid="tweetText"]');
    let text = '';
    if (textEl) {
      text = textEl.innerText || textEl.textContent || '';
    }
    // Photo-only or video-only posts have no tweetText node. Returning them
    // with an empty body would hand the model nothing to react to, so treat
    // them as unscraped and let the caller explain.
    const hasMedia = !!article.querySelector(
      '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]'
    );
    if (!text) return { text: '', hasMedia, id: tweetId, mediaOnly: hasMedia };

    // Quoted tweet: X wraps it in a link container whose inner article holds
    // the quoted body. The `t !== text` check is what stops a post from
    // appearing to quote itself, because the post's own body also lives under
    // a div[role="link"].
    let quoted = null;
    for (const sel of ['[data-testid="quoteTweet"]', 'div[role="link"]']) {
      for (const cand of article.querySelectorAll(sel)) {
        const q = cand.querySelector('[data-testid="tweetText"]');
        if (!q) continue;
        const t = ((q.innerText || q.textContent) || '').trim();
        if (t && t !== text.trim()) { quoted = t; break; }
      }
      if (quoted) break;
    }

    const author = scrapeAuthorFromDom(article);

    return {
      id: tweetId || tweetIdFromArticle(article),
      text: text.trim(),
      hasMedia,
      quoted,
      author,
    };
  }

  /** Pulls handle, display name and avatar out of an article's own header. */
  function scrapeAuthorFromDom(article) {
    const author = {};
    try {
      // The User-Name block sits above the tweet body and holds the handle.
      const block = article.querySelector('[data-testid="User-Name"]');
      const spans = block ? [...block.querySelectorAll('span')] : [];
      for (const s of spans) {
        const t = (s.textContent || '').trim();
        if (!t) continue;
        if (t.startsWith('@') && !author.handle) { author.handle = t; continue; }
        if (!author.name) author.name = t;
      }
      const img = article.querySelector('[data-testid="Tweet-User-Avatar"] img');
      if (img) author.avatar = img.getAttribute('src') || '';
    } catch { /* non-fatal: author context is a nicety, not a requirement */ }
    return author;
  }

  /** Returns the id of the tweet the user is most likely looking at. */
  function resolveTargetTweetId() {
    // 1. An explicitly focused article (keyboard-navigated on the timeline).
    const focused = document.querySelector('article[tabindex="-1"]:focus-within')
      || document.querySelector('article[aria-labelledby]:focus-within');
    if (focused) {
      const id = tweetIdFromArticle(focused);
      if (id) return { id, source: 'focused' };
    }

    // 2. Status page — the opened tweet wins.
    const fromUrl = tweetIdFromUrl();
    if (fromUrl) return { id: fromUrl, source: 'url' };

    // 3. Hovered article.
    const hovered = document.querySelector('article:hover');
    if (hovered) {
      const id = tweetIdFromArticle(hovered);
      if (id) return { id, source: 'hover' };
    }

    // 4. Last interacted article tracked by our own click listener.
    if (window.__replyGuyLastArticle?.isConnected) {
      const id = tweetIdFromArticle(window.__replyGuyLastArticle);
      if (id) return { id, source: 'tracked' };
    }

    // 5. Single visible article.
    const articles = [...document.querySelectorAll('article')].filter(isVisible);
    if (articles.length === 1) {
      const id = tweetIdFromArticle(articles[0]);
      if (id) return { id, source: 'only' };
    }

    return { id: null, source: null };
  }

  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Track the last article the user clicked so timeline replies work even
  // after the focus moves to the extension side panel.
  document.addEventListener('click', (e) => {
    const article = e.target?.closest?.('article');
    if (article) window.__replyGuyLastArticle = article;
  }, true);

  /**
   * Best-effort metadata scrape. The GraphQL fetch in the background worker is
   * the primary source; this fills gaps when the API path fails.
   */
  function scrapeTweetMeta() {
    const { id } = resolveTargetTweetId();
    if (!id) return null;

    let article = null;
    if (location.pathname.includes(`/status/${id}`)) {
      article = document.querySelector('article[data-testid="tweet"]')
        || document.querySelector('article');
    } else {
      const links = document.querySelectorAll(`a[href*="/status/${id}"]`);
      for (const l of links) {
        const a = l.closest('article');
        if (a) { article = a; break; }
      }
    }
    if (!article) return { id, text: null };

    const textEl = article.querySelector('[data-testid="tweetText"]');
    const text = textEl ? textEl.innerText : null;

    let author = null;
    const userEl = article.querySelector('[data-testid="User-Name"]');
    if (userEl) {
      const nameLink = userEl.querySelector('a[href^="/"]');
      const handle = nameLink ? nameLink.getAttribute('href').replace('/', '') : null;
      const spans = [...userEl.querySelectorAll('span')].map(s => s.innerText).filter(Boolean);
      author = { name: spans[0] || handle, screen_name: handle };
    }

    const hasMedia = !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="card.wrapper"]');

    return { id, text, author, hasMedia };
  }

  // ─── Composer bridge ────────────────────────────────────────────────────
  const COMPOSER_SELECTORS = [
    '[data-testid="tweetTextarea_0"]',
    '[data-testid^="tweetTextarea_"]',
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"][data-contents="true"]',
  ];

  function findComposer() {
    for (const sel of COMPOSER_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && isVisible(el)) return el;
    }
    return null;
  }

  const REPLY_BUTTON_SELECTORS = [
    '[data-testid="reply"]',
    '[data-testid="replyButton"]',
    'button[aria-label^="Reply"]',
    'button[aria-label^="Balas"]',
    'button[aria-label^="回复"]',
  ];

  /**
   * Opens the reply composer for the target tweet.
   * Returns true when a composer exists afterwards.
   */
  async function openComposer(tweetId) {
    if (findComposer()) return true;

    let article = null;
    if (tweetId && location.pathname.includes(`/status/${tweetId}`)) {
      article = document.querySelector('article[data-testid="tweet"]') || document.querySelector('article');
    } else if (tweetId) {
      const links = document.querySelectorAll(`a[href*="/status/${tweetId}"]`);
      for (const l of links) {
        const a = l.closest('article');
        if (a) { article = a; break; }
      }
    }
    if (!article) article = document.querySelector('article');

    const scope = article || document;
    let btn = null;
    for (const sel of REPLY_BUTTON_SELECTORS) {
      const cand = scope.querySelector(sel);
      if (cand && isVisible(cand)) { btn = cand; break; }
    }
    if (!btn) return false;

    btn.scrollIntoView({ block: 'center', behavior: 'instant' });
    btn.click();

    // Poll for the composer instead of a fixed sleep.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 120));
      if (findComposer()) return true;
    }
    return false;
  }

  /**
   * Writes `text` into the composer.
   *
   * X's DraftJS-based editor ignores `innerText = ...` and a raw `input` event.
   * The reliable path is to focus the node, select all, and use
   * `document.execCommand('insertText', ...)` which fires the events DraftJS
   * actually listens to. A clipboard paste is the fallback (X supports
   * paste-to-link and paste-to-media, so this is a supported input path).
   */
  async function insertIntoComposer(text, { replace = true } = {}) {
    const el = findComposer();
    if (!el) return { ok: false, error: 'Composer not found. Open the reply box first.' };

    el.focus();
    // Place the caret.
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      const range = document.createRange();
      range.selectNodeContents(el);
      if (!replace) range.collapse(false);
      sel.addRange(range);
    }

    // Small settle delay — X re-renders the composer on focus.
    await new Promise(r => setTimeout(r, 80));

    let inserted = false;
    try {
      inserted = document.execCommand('insertText', false, text);
    } catch { inserted = false; }

    if (!inserted) {
      try {
        const dt = new DataTransfer();
        dt.setData('text/plain', text);
        const paste = new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true,
        });
        el.dispatchEvent(paste);
        inserted = true;
      } catch { inserted = false; }
    }

    // Last resort: direct content mutation. Works on some X builds.
    if (!inserted) {
      try {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
        inserted = true;
      } catch { inserted = false; }
    }

    if (!inserted) return { ok: false, error: 'All insert methods failed. Copy the draft manually.' };

    return { ok: true, chars: text.length };
  }

  // ─── Message router ─────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'REQUEST_TOKENS') {
      const tokens = extractTokens();
      const userId = extractUserId();
      if (tokens && userId) {
        tokens.userId = userId;
        sendResponse({ ok: true, tokens });
      } else {
        sendResponse({ ok: false, error: 'Not logged in or tokens not found' });
      }
      return;
    }

    if (msg.type === 'GET_TARGET_TWEET') {
      const target = resolveTargetTweetId();
      const meta = target.id ? scrapeTweetMeta() : null;
      sendResponse({ ok: !!target.id, ...target, meta });
      return;
    }

    // Primary tweet fetch: read it off the page. No API call, no query id, so
    // it keeps working when X rotates GraphQL hashes or retires v1.1 REST.
    if (msg.type === 'SCRAPE_TWEET') {
      let tweet = null;
      try {
        tweet = scrapeTweetFromDom(msg.tweetId);
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
        return;
      }
      if (!tweet) { sendResponse({ ok: false, error: 'not-on-page' }); return; }
      // A post with media but no text has nothing for the model to analyze.
      if (!tweet.text) {
        sendResponse({
          ok: false,
          error: 'media-only',
          message: 'That post is media with no text. Reply Guy needs text to analyze.',
        });
        return;
      }
      sendResponse({ ok: true, tweet });
      return;
    }

    if (msg.type === 'OPEN_COMPOSER') {
      openComposer(msg.tweetId)
        .then(ok => sendResponse({ ok }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // async
    }

    if (msg.type === 'INSERT_REPLY') {
      insertIntoComposer(msg.text, { replace: msg.replace !== false })
        .then(sendResponse)
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // async
    }

    if (msg.type === 'PING') {
      sendResponse({ ok: true, hasComposer: !!findComposer(), url: location.href });
      return;
    }
  });

  console.log('[Reply Guy] content script ready');
})();
