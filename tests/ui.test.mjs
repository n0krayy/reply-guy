// Covers the "I generated replies and saw nothing" class of bug.
//
// The drafts were always produced and saved to history - the failure was that
// nothing on screen said so, and switching tabs quietly discarded the run. Both
// halves are pinned here: the jump-bar must exist and track the draft count,
// and a tab switch must not wipe completed work.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const html = readFileSync(join(ROOT, 'popup/popup.html'), 'utf8');
const css = readFileSync(join(ROOT, 'popup/popup.css'), 'utf8');
const js = readFileSync(join(ROOT, 'popup/popup.js'), 'utf8');

let pass = 0; let fail = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

// ─── The results control exists and is wired ─────────────────────────────────
ok('a results control sits directly under the Generate button',
  /id="btnResultsJump"/.test(html), 'no jump-bar in the markup');
{
  const genIdx = html.indexOf('id="btnGenerate"');
  const jumpIdx = html.indexOf('id="btnResultsJump"');
  const draftsIdx = html.indexOf('id="sectionDrafts"');
  ok('it appears after Generate and before the drafts section',
    genIdx > -1 && jumpIdx > genIdx && draftsIdx > jumpIdx,
    `generate=${genIdx} jump=${jumpIdx} drafts=${draftsIdx}`);
}
ok('the jump-bar starts hidden',
  /class="results-jump hidden"/.test(html), 'it would show an empty 0-reply bar on load');
ok('its count and label are addressable',
  /id="resultsJumpCount"/.test(html) && /id="resultsJumpLabel"/.test(html));
ok('the element is registered in the dom map',
  /btnResultsJump:\s*\$\('#btnResultsJump'\)/.test(js), 'never queried, so never updated');
ok('clicking it reveals the results',
  /btnResultsJump\.addEventListener\('click',\s*revealResults\)/.test(js));

// ─── The bar actually reflects state ─────────────────────────────────────────
ok('renderDrafts updates the bar', /bindDraftActions\(\);\s*\n\s*updateResultsJump\(\)/.test(js),
  'bar would go stale as drafts change');
ok('updateResultsJump is defined', /function updateResultsJump\(\)/.test(js));
ok('a zero-draft state hides the bar', /if \(!n\) \{[\s\S]{0,80}add\('hidden'\)/.test(js));
ok('clearing drafts hides the bar again',
  /btnClearDrafts\.addEventListener[\s\S]{0,200}updateResultsJump\(\)/.test(js),
  'otherwise it advertises replies that were cleared');
ok('the label distinguishes clean from flagged drafts',
  /clean \\u00b7|clean ·/.test(js), 'a user cannot tell quality at a glance');

// ─── Results are brought into view automatically ─────────────────────────────
ok('generating reveals the results without the user hunting for them',
  /renderDrafts\(\);[\s\S]{0,200}revealResults\(\)/.test(js),
  'the whole point: the outcome must be unmissable');
ok('revealResults scrolls the drafts into view',
  /function revealResults\(\)[\s\S]{0,220}scrollIntoView/.test(js));
ok('the reveal is announced with a flash',
  /results-flash/.test(js) && /results-flash/.test(css));
ok('the flash respects reduced-motion preferences',
  /prefers-reduced-motion[\s\S]{0,120}results-flash[\s\S]{0,60}animation: none/.test(css),
  'animation-sensitive users should not get a flashing panel');

// ─── Switching tabs must not destroy completed work ──────────────────────────
// This was the actual defect: onActivated fires pollTargetTweet on every tab
// change, and the old code nulled currentTweet/currentAnalysis unconditionally,
// leaving a generated result set with no analysis above it.
ok('a tab switch no longer wipes a completed run',
  /if \(!currentTweet \|\| !currentDrafts\.length\) \{/.test(js),
  'the guard that protects finished work is missing');
ok('the wipe is still available when there is nothing to lose',
  /currentTweet = null;/.test(js) && /currentAnalysis = null;/.test(js));
ok('drafts survive a target change',
  !/lastResolvedId = res\.id;[\s\S]{0,200}currentDrafts = \[\]/.test(js),
  'clearing drafts on tab switch would lose the replies');

// ─── A missing response must not look like success ───────────────────────────
ok('an ok response with no drafts raises an error',
  /!Array\.isArray\(res\.drafts\) \|\| !res\.drafts\.length[\s\S]{0,160}throw/.test(js),
  'otherwise the panel renders empty and the toast claims success');

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (fail) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  x ${f}`);
}
process.exit(fail ? 1 : 0);
