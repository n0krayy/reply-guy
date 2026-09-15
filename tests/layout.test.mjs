// Checks the panel layout rules that caused the scroll to stop dead.
//
// The bug: at >=621px the stylesheet made body a fixed-height flex column and
// gave #sectionDrafts `flex: 1; overflow: hidden`, while .draft-list kept its
// own 340px scroller. Result: revealing the drafts squeezed the content above
// instead of extending the page, and the nested scroller trapped the scroll.
//
// A CSS parser is overkill here; the failure modes are all about which rules
// exist, so assert on the parsed declarations.

import { readFileSync } from 'node:fs';

let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const css = readFileSync('popup/popup.css', 'utf8');

/** Pulls the body of a rule by selector, ignoring comments. */
function rule(selector) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const idx = src.indexOf(selector + ' {');
  if (idx === -1) return null;
  const open = src.indexOf('{', idx);
  const close = src.indexOf('}', open);
  return src.slice(open + 1, close);
}

/** Every occurrence of a selector, including inside media queries. */
function allRules(selector) {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  let i = 0;
  while ((i = src.indexOf(selector + ' {', i)) !== -1) {
    const open = src.indexOf('{', i);
    const close = src.indexOf('}', open);
    out.push({ body: src.slice(open + 1, close), at: i });
    i = close;
  }
  return out;
}

// ─── No fixed-height body ────────────────────────────────────────────────────
{
  const bodies = allRules('body');
  ok('body is never pinned to the viewport height',
    !bodies.some(b => /height:\s*100vh/.test(b.body)),
    'height:100vh forbids the page growing, which made content unreachable');
  ok('body keeps its scroll', /overflow-y:\s*auto/.test(rule('body') || ''),
    'the page is the single scroll container');
  ok('the tall-panel rule lifts the max-height cap',
    /max-height:\s*none/.test(rule('body,') || bodies.map(b => b.body).join('})') || '')
    || /max-height:\s*none/.test(bodies.map(b => b.body).join(';')),
    'a 620px cap hides everything past it on a tall panel');
}

// ─── The drafts section must not clip its own content ────────────────────────
{
  const secs = allRules('#sectionDrafts');
  ok('no rule gives #sectionDrafts overflow:hidden',
    !secs.some(s => /overflow:\s*hidden/.test(s.body)),
    'overflow:hidden on the section clipped the cards');
  ok('no rule makes #sectionDrafts a rigid flex child',
    !secs.some(s => /flex:\s*1/.test(s.body) && /overflow:\s*hidden/.test(s.body)),
    'flex:1 + overflow:hidden pinned it so the page could not grow');
}

// ─── Exactly one scroller in the results area ────────────────────────────────
{
  const lists = allRules('.draft-list');
  const nestedScroller = lists.some(l => /overflow-y:\s*auto/.test(l.body));
  ok('the draft list is not a second scroll container',
    !nestedScroller,
    'a scroller nested in the panel scroller is what trapped the scroll');
  ok('the draft list is never capped at 340px',
    !lists.some(l => /max-height:\s*340px/.test(l.body)),
    'that cap is the exact height the scroll used to stop at');
}

// ─── The results bar stays reachable ─────────────────────────────────────────
{
  const bar = rule('.results-jump');
  ok('.results-jump exists', !!bar);
  ok('the results bar is sticky while scrolling',
    /position:\s*sticky/.test(bar || ''),
    'so it is never something you must scroll back up to find');
  ok('it sticks below the sticky header',
    /top:\s*\d+px/.test(bar || ''),
    'otherwise it hides under the header');
}

// ─── Scroll positioning is computed, not delegated ───────────────────────────
{
  const js = readFileSync('popup/popup.js', 'utf8');
  // Only revealResults is constrained; scrollIntoView is still fine where the
  // target is a small panel the user must interact with (the setup gate).
  const fn = js.match(/function revealResults\(\)[\s\S]*?\n\}/);
  ok('revealResults is defined', !!fn);
  ok('revealResults does not use scrollIntoView',
    !!fn && !/scrollIntoView/.test(fn[0]),
    'in a side panel it can pin the section at the viewport edge');
  ok('revealResults scrolls the document explicitly',
    !!fn && /window\.scrollTo\(/.test(fn[0]) && /scrollingElement/.test(fn[0]));
  ok('scroll targets are clamped so they cannot go negative',
    !!fn && /Math\.max\(0,\s*top\)/.test(fn[0]));
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  x ${f}`);
}
process.exit(fail ? 1 : 0);
