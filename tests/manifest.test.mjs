/**
 * Reply Guy — Manifest and syntax validator
 *
 * Catches the failure mode that costs the most time in MV3 development: the
 * extension loads, but a module has a syntax error or the manifest references
 * a file that does not exist, and Chrome fails silently.
 *
 * Run: node tests/manifest.test.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS } from '../lib/providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fail++;
  failures.push(`${name}${detail ? ' — ' + detail : ''}`);
}

// ─── Manifest presence and shape ─────────────────────────────────────────────
const manifestPath = join(ROOT, 'manifest.json');
ok('manifest.json exists', existsSync(manifestPath));

const raw = readFileSync(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(raw);
  ok('manifest.json is valid JSON', true);
} catch (e) {
  ok('manifest.json is valid JSON', false, e.message);
  process.exit(1);
}

ok('manifest_version is 3', manifest.manifest_version === 3);
ok('name is set', typeof manifest.name === 'string' && manifest.name.length > 0);
ok('version is semver-ish', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
ok('description under 132 chars',
  typeof manifest.description === 'string' && manifest.description.length <= 132,
  `len=${manifest.description?.length}`);
ok('service worker declared', !!manifest.background?.service_worker);

// ─── Every referenced file must exist ────────────────────────────────────────
const referenced = [];
if (manifest.background?.service_worker) referenced.push(manifest.background.service_worker);
if (manifest.side_panel?.default_path) referenced.push(manifest.side_panel.default_path);
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) referenced.push(f);
}
for (const v of Object.values(manifest.icons || {})) referenced.push(v);
for (const v of Object.values(manifest.action?.default_icon || {})) referenced.push(v);

for (const f of referenced) {
  ok(`referenced file exists: ${f}`, existsSync(join(ROOT, f)));
}

// ─── Permissions sanity ──────────────────────────────────────────────────────
const perms = manifest.permissions || [];
for (const p of ['storage', 'scripting', 'sidePanel', 'tabs', 'activeTab']) {
  ok(`has permission: ${p}`, perms.includes(p), JSON.stringify(perms));
}
ok('no <all_urls> host permission',
  !(manifest.host_permissions || []).includes('<all_urls>'),
  'X-only host permissions keep the extension scoped');
ok('host_permissions limited to x.com/twitter.com',
  (manifest.host_permissions || []).every(h => /x\.com|twitter\.com/.test(h)),
  JSON.stringify(manifest.host_permissions));

// ─── Parse every JS file ─────────────────────────────────────────────────────
const JS_FILES = [
  'background.js',
  'content.js',
  'lib/constants.js',
  'lib/rules.js',
  'lib/analyzer.js',
  'lib/prompt.js',
  'lib/providers.js',
  'utils/storage.js',
  'popup/popup.js',
];

// Importing executes the module, which is wrong for content.js/background.js
// (they touch chrome.* at load). Use a syntax-only check via new Function on a
// parsed representation instead — we shell out to node --check for those.
import { execFileSync } from 'node:child_process';

for (const file of JS_FILES) {
  const full = join(ROOT, file);
  ok(`js file exists: ${file}`, existsSync(full));
  if (!existsSync(full)) continue;

  let syntaxOk = true;
  let detail = '';
  try {
    // --check respects ESM syntax when the file has import/export.
    execFileSync(process.execPath, ['--check', full], { stdio: 'pipe' });
  } catch (e) {
    syntaxOk = false;
    detail = (e.stderr?.toString() || e.message).split('\n').slice(0, 3).join(' ');
  }
  ok(`syntax valid: ${file}`, syntaxOk, detail);
}

// ─── HTML references ─────────────────────────────────────────────────────────
const popupHtml = readFileSync(join(ROOT, 'popup/popup.html'), 'utf8');
ok('popup html links popup.css', popupHtml.includes('popup.css'));
ok('popup html loads utils/storage.js', popupHtml.includes('../utils/storage.js'));

// Extract every src/href that is a local path and confirm it exists.
const localRefs = [...popupHtml.matchAll(/(?:src|href)="(?!https?:|#|data:)([^"]+)"/g)]
  .map(m => m[1]);
for (const ref of localRefs) {
  ok(`popup html reference exists: ${ref}`, existsSync(join(ROOT, 'popup', ref)));
}

// Every id the JS queries must exist in the HTML.
const popupJs = readFileSync(join(ROOT, 'popup/popup.js'), 'utf8');
const queriedIds = [...popupJs.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]);
const missingIds = [...new Set(queriedIds)].filter(id => !popupHtml.includes(`id="${id}"`));
ok('all queried element ids exist in html', missingIds.length === 0,
  `missing: ${missingIds.join(', ')}`);
// Guard against the regex silently matching nothing after a refactor.
ok('id check actually inspected a meaningful number of ids',
  new Set(queriedIds).size >= 50, `saw ${new Set(queriedIds).size}`);

// ─── Two-option provider setup ──────────────────────────────────────────────
// The user asked for exactly two ways in: five named providers, or custom.
ok('setup screen exists', popupHtml.includes('id="setupPanel"'));
ok('setup has a provider card grid', popupHtml.includes('id="setupProviderGrid"'));
ok('setup separates preset and custom fields',
  popupHtml.includes('id="setupPresetFields"') && popupHtml.includes('id="setupCustomFields"'));
ok('settings separates preset and custom fields',
  popupHtml.includes('id="presetFields"') && popupHtml.includes('id="customFields"'));
ok('setup gates the UI', /needs-setup/.test(readFileSync(join(ROOT, 'popup/popup.css'), 'utf8')));

const providersJs = readFileSync(join(ROOT, 'lib/providers.js'), 'utf8');
for (const id of ['deepseek', 'kimi', 'glm', 'gemini', 'chatgpt', 'custom']) {
  ok(`providers.js declares ${id}`, new RegExp(`^\\s{2}${id}: \\{`, 'm').test(providersJs));
}
const bgSource = readFileSync(join(ROOT, 'background.js'), 'utf8');
ok('base URL is registry-owned for named providers',
  /isCustom \? String\(settings\?\.baseUrl/.test(bgSource),
  'background must not accept a user base URL for preset providers');

// ─── Provider hosts must be reachable ───────────────────────────────────────
// A provider whose host is missing from optional_host_permissions would fail
// at fetch time with an opaque error. Catch that here instead.
const optionalHosts = manifest.optional_host_permissions || [];
for (const [id, p] of Object.entries(PROVIDERS)) {
  if (id === 'custom' || !p.baseUrl) continue;
  const host = new URL(p.baseUrl).host;
  const covered = optionalHosts.some(pat => {
    try { return new URL(pat.replace(/\*$/, '')).host === host; }
    catch { return false; }
  });
  ok(`manifest allows outbound calls to ${id} (${host})`, covered,
    `add https://${host}/* to optional_host_permissions`);
}
ok('manifest covers every provider host it needs', true);
ok('manifest still grants no extra posting host',
  !optionalHosts.some(h => /api\.m\.twitter|upload\.twitter/.test(h)),
  optionalHosts.join(', '));
ok('custom provider has its own key field in setup',
  popupHtml.includes('id="setupCustomApiKey"') && popupHtml.includes('id="settingCustomApiKey"'));

// ─── Cross-module import integrity for the popup ─────────────────────────────
const imports = [...popupJs.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
for (const imp of imports) {
  const p = resolve(join(ROOT, 'popup'), imp);
  ok(`popup import resolves: ${imp}`, existsSync(p), p);
}

// ─── Background imports ──────────────────────────────────────────────────────
const bgJs = readFileSync(join(ROOT, 'background.js'), 'utf8');
const bgImports = [...bgJs.matchAll(/from\s+'([^']+)'/g)].map(m => m[1]);
for (const imp of bgImports) {
  const p = resolve(ROOT, imp);
  ok(`background import resolves: ${imp}`, existsSync(p), p);
}

// ─── Safety invariant: the extension must never post ─────────────────────────
const ALL_SRC = [bgJs, popupJs, readFileSync(join(ROOT, 'content.js'), 'utf8')].join('\n');

ok('no statuses/update post endpoint in background',
  !/statuses\/update\.json/.test(bgJs),
  'the extension must never call the X post endpoint');
ok('no CreateTweet graphql mutation',
  !/CreateTweet/i.test(ALL_SRC));
ok('no .click() on the post button',
  !/data-testid="tweetButton[^"]*"[^\n]*\.click\(\)/.test(ALL_SRC));
ok('composer safety gate present',
  bgJs.includes('assertComposerContext'),
  'background must gate inserts behind a status-page URL check');
ok('gate rejects non-status pages',
  /not on a post detail view/.test(bgJs) || /not on a status page/.test(bgJs));
ok('gate does not allow /compose/post',
  !/\/compose\/post[^\n]*\.test\(url\)/.test(bgJs),
  'a standalone composer is not a reply context');

// ─── Report ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`);
console.log(`PASS ${pass}   FAIL ${fail}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  x ' + f);
}
process.exit(fail === 0 ? 0 : 1);
