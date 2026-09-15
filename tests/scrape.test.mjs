// Tests the DOM scraper in content.js against fixtures shaped like real X markup.
//
// Why this file exists: both of the extension's network paths for reading a
// tweet can rot. GraphQL query ids get rotated by X, and the v1.1 REST surface
// has been largely retired, so a hard-coded fetch returns 404 no matter how
// correct the rest of the code is. Scraping the rendered page has no such
// dependency, which makes it the path worth pinning down with tests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── A minimal DOM good enough to run content.js ─────────────────────────────
// content.js is a content script: it runs against window/document and talks to
// chrome.*. We give it just enough of both to load and drive scrapeTweetFromDom
// directly, via the message router, which is how production reaches it.

/**
 * Text access mirroring the browser: textContent concatenates descendants,
 * innerText is what a user would read. The test's own text lives in `_text`,
 * so a leaf with no children reads back exactly its own string and cannot
 * absorb its siblings'. Getting this wrong made tweet bodies pick up the
 * author's name.
 */
class El {
  constructor(tag, attrs = {}, children = [], text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.children = children;
    this._text = text;
    this.parent = null;
    for (const c of children) c.parent = this;
  }

  get textContent() { return collectText(this); }
  get innerText() { return collectText(this); }

  matches(sel) { return matchesSelector(this, sel); }

  querySelector(sel) {
    const parts = sel.split(/\s+(?![^\[]*\])/).filter(Boolean);
    if (parts.length > 1) {
      // Descendant combinator: find the ancestor, then search inside it.
      for (const c of this.querySelectorAll(parts[0])) {
        const d = c.querySelector(parts.slice(1).join(' '));
        if (d) return d;
      }
      return null;
    }
    for (const c of this.children) {
      if (c.matches(sel)) return c;
      const d = c.querySelector(sel);
      if (d) return d;
    }
    return null;
  }

  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const c of n.children) {
        if (c.matches(sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }

  closest(sel) {
    let n = this;
    while (n) {
      if (n.matches(sel)) return n;
      n = n.parent;
    }
    return null;
  }

  getAttribute(n) { return this.attrs[n] ?? null; }
}

function collectText(el) {
  // Read the backing field directly. Reading el.textContent here would recurse
  // forever, because textContent is defined in terms of this function.
  let out = el._text || '';
  for (const c of el.children) out += collectText(c);
  return out;
}

/**
 * Supports the handful of selector forms content.js actually uses:
 *   tag, .class, [attr], [attr="v"], [attr*="v"], tag[attr="v"], tag[attr*="v"]
 *
 * Earlier this only handled the attribute form when the attribute was the
 * ENTIRE selector, so `a[href*="/status/"]` — the one selector the scraper
 * leans on most — never matched, and every scrape test failed for a reason
 * that had nothing to do with the code under test.
 */
function matchesSelector(el, sel) {
  return sel.split(',').some(part => {
    const s = part.trim();
    let rest = s;
    let tag = null;

    // Optional leading tag name.
    const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
    if (tagMatch) {
      tag = tagMatch[1].toUpperCase();
      rest = rest.slice(tagMatch[1].length);
    }

    // Optional class.
    const classMatch = rest.match(/\.([\w-]+)/);
    const cls = classMatch ? classMatch[1] : null;

    // All attribute predicates, each of which must hold.
    //
    // `op` must default to null only when the group did not participate. A
    // plain `=` captures as an EMPTY STRING, and `'' || null` is null, which
    // silently downgraded every [attr="v"] to a presence-only check — so
    // [data-testid="tweetText"] matched any element carrying that attribute.
    const preds = [...s.matchAll(/\[([\w-]+)(?:([*^$]?)=("[^"]*"|[^\]]+))?\]/g)]
      .map(m => ({
        name: m[1],
        op: m[2] === undefined ? null : (m[2] === '' ? '=' : m[2]),
        val: (m[3] || '').replace(/^"|"$/g, ''),
      }));

    if (tag && el.tagName !== tag) return false;
    if (cls && !String(el.attrs?.class || '').split(/\s+/).includes(cls)) return false;

    for (const p of preds) {
      const actual = el.getAttribute(p.name);
      if (actual === null || actual === undefined) return false;
      const a = String(actual);
      if (!p.op) continue;                        // [attr] presence only
      if (p.op === '=' && a !== p.val) return false;
      if (p.op === '*' && !a.includes(p.val)) return false;
      if (p.op === '^' && !a.startsWith(p.val)) return false;
      if (p.op === '$' && !a.endsWith(p.val)) return false;
    }

    return true;
  });
}

// ─── chrome.* stub that captures the message router ──────────────────────────
let router = null;
const makeChrome = () => ({
  runtime: {
    onMessage: { addListener: (fn) => { router = fn; } },
    sendMessage: () => {},
    lastError: null,
  },
  storage: { local: { get: (d, cb) => cb(d || {}), set: (_o, cb) => cb && cb() } },
});

function loadContentScript(doc) {
  const src = readFileSync(join(ROOT, 'content.js'), 'utf8');
  const listeners = {};
  const win = {
    addEventListener: (n, fn) => { listeners[n] = fn; },
    removeEventListener: () => {},
    location: doc.location,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
  };
  const ctx = {
    document: doc,
    window: win,
    chrome: makeChrome(),
    location: doc.location,
    navigator: { userAgent: 'test' },
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    console: { warn() {}, log() {}, error() {} },
    CSS: { escape: (s) => s },
    Event: class {}, KeyboardEvent: class {}, MouseEvent: class {},
    getComputedStyle: win.getComputedStyle,
  };
  const keys = Object.keys(ctx);
  const fn = new Function(...keys, src + '\n;return null;');
  fn(...keys.map(k => ctx[k]));
  return { router, win };
}

function ask(msg) {
  return new Promise(resolve => {
    const done = router(msg, {}, resolve);
    if (done !== true) resolve(undefined);
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function userName(handle, name, avatar = 'https://pbs.twimg.com/a.jpg') {
  return new El('div', { 'data-testid': 'User-Name' }, [
    new El('div', { 'data-testid': 'Tweet-User-Avatar' }, [
      new El('img', { src: avatar }),
    ]),
    new El('span', {}, [], name),
    new El('span', {}, [], handle),
  ]);
}

function article({ id, text, handle = '@someone', name = 'Some One', media = false, quote = null }) {
  const kids = [
    new El('a', { href: `/someone/status/${id}` }, [], ''),
    userName(handle, name),
  ];
  // X wraps the body in a link container. This matters: a quote lookup that
  // walks div[role="link"] can otherwise match the post's OWN body.
  if (text) {
    kids.push(new El('div', { role: 'link' }, [
      new El('div', { 'data-testid': 'tweetText' }, [], text),
    ]));
  }
  if (media) kids.push(new El('div', { 'data-testid': 'tweetPhoto' }, [], ''));
  if (quote) {
    // Mirrors real X markup: the quoted post lives inside a link container.
    kids.push(new El('div', { role: 'link' }, [
      new El('div', { 'data-testid': 'quoteTweet' }, [
        new El('div', { 'data-testid': 'tweetText' }, [], quote),
      ]),
    ]));
  }
  return new El('article', {}, kids);
}

function docWith(articles, pathname = '/someone/status/123') {
  const root = new El('body', {}, articles);
  return {
    location: { pathname, href: `https://x.com${pathname}`, hostname: 'x.com' },
    body: root,
    documentElement: root,
    cookie: 'ct0=abc; twid=u%3D999',
    querySelector: sel => root.querySelector(sel),
    querySelectorAll: sel => root.querySelectorAll(sel),
    addEventListener: () => {},
    getElementById: () => null,
    createElement: (t) => new El(t),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('=== DOM scrape: the path that cannot be broken by API changes ===');
{
  const doc = docWith([article({ id: '123', text: 'hot take incoming', handle: '@krayy', name: 'Krayy' })]);
  loadContentScript(doc);

  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '123' });
  ok('scrape succeeds', res?.ok === true, JSON.stringify(res));
  ok('body text is read', res?.tweet?.text === 'hot take incoming', res?.tweet?.text);
  ok('handle is read from User-Name', res?.tweet?.author?.handle === '@krayy', res?.tweet?.author?.handle);
  ok('display name is read', res?.tweet?.author?.name === 'Krayy', res?.tweet?.author?.name);
  ok('avatar is read', /pbs\.twimg/.test(res?.tweet?.author?.avatar || ''), res?.tweet?.author?.avatar);
}

console.log('\n=== Media-only posts are rejected with a reason ===');
{
  const doc = docWith([article({ id: '500', text: '', media: true })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '500' });
  ok('media-only post is not passed off as a usable scrape',
    res?.ok === false, JSON.stringify(res));
  ok('media-only post explains why',
    res?.error === 'media-only' && /media/.test(res?.message || ''), JSON.stringify(res));
}

console.log('\n=== Quoted tweet is captured ===');
{
  const doc = docWith([article({ id: '777', text: 'look at this', quote: 'the quoted take' })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '777' });
  ok('quote text is captured', res?.tweet?.quoted === 'the quoted take', res?.tweet?.quoted);
}

console.log('\n=== The right article is picked out of a thread ===');
{
  // A timeline with several posts. Asking for the third must not return the
  // first, which is the classic off-by-one in DOM scraping.
  const doc = docWith([
    article({ id: '111', text: 'first post', handle: '@a' }),
    article({ id: '222', text: 'second post', handle: '@b' }),
    article({ id: '333', text: 'third post', handle: '@c' }),
  ]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '333' });
  ok('targets the requested article, not the first on screen',
    res?.tweet?.text === 'third post', res?.tweet?.text);
  ok('targets the right author too',
    res?.tweet?.author?.handle === '@c', res?.tweet?.author?.handle);
}

console.log('\n=== A tweet that is not on the page fails cleanly ===');
{
  const doc = docWith([article({ id: '111', text: 'only post' })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '999' });
  ok('reports not-on-page rather than returning the wrong tweet',
    res?.ok === false && res.error === 'not-on-page', JSON.stringify(res));
}

console.log('\n=== A post cannot appear to quote itself ===');
{
  // Every article contains a div[role="link"] wrapper around its own body in
  // real markup, so a naive quote lookup can resolve to the post's own text
  // and report it as a quote. Assert that never happens.
  const doc = docWith([article({ id: '999', text: 'just my own thought' })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '999' });
  ok('a post with no quote reports no quote',
    res?.tweet?.quoted === null || res?.tweet?.quoted === undefined,
    JSON.stringify(res?.tweet?.quoted));
  ok('its own text is not duplicated into quoted',
    res?.tweet?.quoted !== res?.tweet?.text, JSON.stringify(res?.tweet));
}

console.log('\n=== Whitespace around a body is trimmed ===');
{
  // X's innerText regularly carries leading/trailing newlines. Untrimmed text
  // skews the analysis and shows up as stray blank lines in the prompt.
  const doc = docWith([article({ id: '321', text: '\n  spaced out take  \n' })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '321' });
  ok('leading and trailing whitespace is trimmed',
    res?.tweet?.text === 'spaced out take', JSON.stringify(res?.tweet?.text));
}

console.log('\n=== Multi-line and unicode bodies survive ===');
{
  const body = 'line one\nline two — with an em dash\n第三次 中文';
  const doc = docWith([article({ id: '888', text: body })]);
  loadContentScript(doc);
  const res = await ask({ type: 'SCRAPE_TWEET', tweetId: '888' });
  ok('newlines and unicode are preserved verbatim',
    res?.tweet?.text === body, JSON.stringify(res?.tweet?.text));
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  x ${f}`);
}

// content.js registers setInterval at top level (token refresh), which keeps the
// Node event loop alive forever. Nothing else is pending by this point.
process.exit(fail ? 1 : 0);
