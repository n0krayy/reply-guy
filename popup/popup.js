/**
 * Reply Guy — Popup UI logic
 *
 * Orchestrates the three-step flow:
 *   1. resolve a target tweet from the x.com tab + analyze it
 *   2. pick language + tones
 *   3. generate, review quality, insert into the composer
 *
 * Runs as an ES module so it shares the same rule/constant tables as the
 * background worker. The quality badges shown here come from the identical
 * validator, so the UI cannot disagree with the pipeline.
 */

import { LANGUAGES, TONES, DEFAULTS } from '../lib/constants.js';
import {
  PROVIDERS, PROVIDER_ORDER, PRESET_PROVIDERS, getProvider,
  validateProviderConfig,
} from '../lib/providers.js';
import { validateDraftSet, validateDraft } from '../lib/rules.js';

/**
 * Strips a base URL down to an origin pattern Chrome understands as a host
 * permission, e.g. "https://card.vantis.sh" -> "https://card.vantis.sh/*".
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
 * Requests host access for the configured endpoint, from the popup.
 *
 * This runs in the popup page — NOT in the service worker — because
 * `chrome.permissions.request()` requires a live user gesture, and a popup
 * click is one. Routing it through a message to the background worker would
 * consume the gesture during the round-trip and fail with "This function must
 * be called during a user gesture".
 *
 * Named providers get permission requested too: their origin is knowable and
 * asking here keeps a single code path for both cases.
 *
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function requestHostAccess(candidate) {
  const p = getProvider(candidate.provider);
  const baseUrl = p.id === 'custom' ? candidate.baseUrl : p.baseUrl;

  const pattern = originPattern(baseUrl);
  if (!pattern) return { ok: false, error: 'That base URL is not a valid http(s) URL.' };

  let host = baseUrl;
  try { host = new URL(baseUrl).host; } catch { /* keep raw */ }

  // No await before request(): the click gesture must still be on the stack.
  let granted;
  try {
    granted = await chrome.permissions.request({ origins: [pattern] });
  } catch (err) {
    if (/user gesture/i.test(err.message || '')) {
      return { ok: false, error: 'Chrome needs a fresh click for this. Close and reopen the panel, then press Save & test once.' };
    }
    return { ok: false, error: `Permission request failed: ${err.message}` };
  }

  if (granted) return { ok: true };

  // false can mean "already held, no prompt needed" — verify before crying denial.
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return { ok: true };
  } catch { /* fall through to denial */ }

  return { ok: false, error: `Access to ${host} was not granted. Press Save & test again and click Allow.` };
}

// ─── State ───────────────────────────────────────────────────────────────────
let settings = { ...DEFAULTS };
let authTokens = null;
let currentTweet = null;
let currentAnalysis = null;
let currentDrafts = [];
let targetTabId = null;
let busy = false;

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const dom = {
  statusBadge: $('#statusBadge'),
  statusText: $('#statusText'),
  connectInfo: $('#connectInfo'),
  connectInfoOk: $('#connectInfoOk'),
  connectedUser: $('#connectedUser'),
  usageBadge: $('#usageBadge'),
  btnTheme: $('#btnTheme'),
  btnHistory: $('#btnHistory'),
  btnSettings: $('#btnSettings'),
  btnAnalyze: $('#btnAnalyze'),
  analyzeLabel: $('#analyzeLabel'),
  tweetTarget: $('#tweetTarget'),
  analysisPanel: $('#analysisPanel'),
  analysisGrid: $('#analysisGrid'),
  analysisHooks: $('#analysisHooks'),
  langGroup: $('#langGroup'),
  toneGroup: $('#toneGroup'),
  draftsPerTone: $('#draftsPerTone'),
  btnGenerate: $('#btnGenerate'),
  generateLabel: $('#generateLabel'),
  sectionProgress: $('#sectionProgress'),
  progressText: $('#progressText'),
  progressFill: $('#progressFill'),
  sectionDrafts: $('#sectionDrafts'),
  btnResultsJump: $('#btnResultsJump'),
  resultsJumpCount: $('#resultsJumpCount'),
  resultsJumpLabel: $('#resultsJumpLabel'),
  statsDrafts: $('#statsDrafts'),
  statsTones: $('#statsTones'),
  statsQuality: $('#statsQuality'),
  sortDrafts: $('#sortDrafts'),
  draftList: $('#draftList'),
  btnRegenerate: $('#btnRegenerate'),
  btnCopyAll: $('#btnCopyAll'),
  btnClearDrafts: $('#btnClearDrafts'),
  settingsModal: $('#settingsModal'),
  providerGrid: $('#providerGrid'),
  providerHint: $('#providerHint'),
  presetFields: $('#presetFields'),
  customFields: $('#customFields'),
  settingModelSelect: $('#settingModelSelect'),
  settingBaseUrl: $('#settingBaseUrl'),
  settingModel: $('#settingModel'),
  modelList: $('#modelList'),
  btnFetchModels: $('#btnFetchModels'),
  settingApiKey: $('#settingApiKey'),
  settingCustomApiKey: $('#settingCustomApiKey'),
  keyHint: $('#keyHint'),
  btnToggleKey: $('#btnToggleKey'),
  btnTestProvider: $('#btnTestProvider'),
  testResult: $('#testResult'),
  // First-run setup
  setupPanel: $('#setupPanel'),
  setupProviderGrid: $('#setupProviderGrid'),
  setupPresetFields: $('#setupPresetFields'),
  setupCustomFields: $('#setupCustomFields'),
  setupApiKey: $('#setupApiKey'),
  setupCustomApiKey: $('#setupCustomApiKey'),
  setupModelSelect: $('#setupModelSelect'),
  setupModel: $('#setupModel'),
  setupBaseUrl: $('#setupBaseUrl'),
  setupKeyHint: $('#setupKeyHint'),
  btnSetupToggleKey: $('#btnSetupToggleKey'),
  btnSetupSave: $('#btnSetupSave'),
  setupStatus: $('#setupStatus'),
  setupDocLink: $('#setupDocLink'),
  settingLanguage: $('#settingLanguage'),
  settingTemperature: $('#settingTemperature'),
  tempValue: $('#tempValue'),
  settingMaxChars: $('#settingMaxChars'),
  settingAuthorContext: $('#settingAuthorContext'),
  btnSaveSettings: $('#btnSaveSettings'),
  btnResetSettings: $('#btnResetSettings'),
  btnCloseSettings: $('#btnCloseSettings'),
  historyModal: $('#historyModal'),
  historyContainer: $('#historyContainer'),
  btnCloseHistory: $('#btnCloseHistory'),
  btnClearHistory: $('#btnClearHistory'),
  toast: $('#toast'),
};

// ─── Small helpers ───────────────────────────────────────────────────────────
function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, error: 'No response' });
    });
  });
}

let toastTimer = null;
function toast(text, kind = '') {
  dom.toast.textContent = text;
  dom.toast.className = 'toast ' + kind;
  dom.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 3200);
}

function setStatus(text, kind = '') {
  dom.statusText.textContent = text;
  dom.statusBadge.className = 'status-badge' + (kind ? ' ' + kind : '');
}

function setBusy(on, label) {
  busy = on;
  if (label) dom.generateLabel.textContent = label;
  dom.btnGenerate.disabled = on || !currentTweet || selectedTones().length === 0;
  dom.btnAnalyze.disabled = on;
  dom.sectionProgress.classList.toggle('hidden', !on);
  if (on) {
    dom.progressFill.classList.add('indeterminate');
  } else {
    dom.progressFill.classList.remove('indeterminate');
    dom.progressFill.style.width = '0%';
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function selectedLang() {
  const active = dom.langGroup.querySelector('.seg-btn.active');
  return active ? active.dataset.lang : settings.language;
}

function selectedTones() {
  return $$('#toneGroup .chip.active').map(c => c.dataset.tone);
}

function toneLabel(id) {
  return TONES.find(t => t.id === id)?.label || id;
}

function formatCount(n) {
  if (!n && n !== 0) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(n);
}

// ─── Init ────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  settings = await Storage.getSettings();

  // Theme
  const theme = settings.theme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  buildProviderOptions();
  buildLanguageOptions();
  hydrateSettingsForm();
  hydrateSelectionUI();
  renderSetupForm();
  applySetupGate();

  await checkAuth();
  await refreshUsage();

  wireEvents();
  pollTargetTweet();
});

function buildProviderOptions() {
  const cards = PROVIDER_ORDER.map(id => {
    const p = PROVIDERS[id];
    const tag = id === 'custom' ? '<span class="provider-tag">BYO endpoint</span>' : '';
    return `<button type="button" class="provider-card" data-provider="${id}">
      <span class="provider-name">${escapeHtml(p.label)}</span>
      ${tag}
    </button>`;
  }).join('');

  dom.providerGrid.innerHTML = cards;
  dom.setupProviderGrid.innerHTML = cards;
}

/**
 * Renders the model list for a named provider into a <select>. The five
 * presets have fixed, known model names, so a dropdown beats free text here —
 * a typo produces a 404 that looks like a key problem.
 */
function fillModelSelect(selectEl, providerId, current) {
  const p = getProvider(providerId);
  const models = p.models || [];
  selectEl.innerHTML = models
    .map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`)
    .join('');
  if (current && models.includes(current)) selectEl.value = current;
}

function buildLanguageOptions() {
  dom.settingLanguage.innerHTML = LANGUAGES
    .map(l => `<option value="${l.id}">${escapeHtml(l.label)}</option>`)
    .join('');
}

/**
 * True when the user picked "custom". Drives which field group is visible.
 */
function isCustomProvider(id) {
  return getProvider(id).id === 'custom';
}

// ─── First-run setup ─────────────────────────────────────────────────────────
/**
 * The app is unusable without a working provider config, so the setup panel
 * replaces everything else until one exists.
 */
function applySetupGate() {
  const ready = validateProviderConfig(settings).ok;
  dom.setupPanel.classList.toggle('hidden', ready);
  document.body.classList.toggle('needs-setup', !ready);
  return ready;
}

function renderSetupForm() {
  const p = getProvider(settings.provider);
  const custom = p.id === 'custom';

  $$('#setupProviderGrid .provider-card').forEach(c => {
    c.classList.toggle('active', c.dataset.provider === p.id);
  });

  dom.setupPresetFields.classList.toggle('hidden', custom);
  dom.setupCustomFields.classList.toggle('hidden', !custom);

  if (custom) {
    dom.setupBaseUrl.value = settings.baseUrl || '';
    dom.setupModel.value = settings.model || '';
    dom.setupCustomApiKey.value = settings.apiKey || '';
    dom.setupDocLink.classList.add('hidden');
  } else {
    dom.setupApiKey.value = settings.apiKey || '';
    dom.setupKeyHint.textContent = p.keyHint
      ? `Key looks like ${p.keyHint}. ${p.note || ''}`.trim()
      : (p.note || '');
    fillModelSelect(dom.setupModelSelect, p.id, settings.model);
    if (p.docs) {
      dom.setupDocLink.href = p.docs;
      dom.setupDocLink.textContent = `Get a ${p.label} key`;
      dom.setupDocLink.classList.remove('hidden');
    } else {
      dom.setupDocLink.classList.add('hidden');
    }
  }
}

/**
 * Reads the setup form into a settings patch. Field ownership depends on the
 * selected provider, so the other group's inputs are ignored rather than
 * carried over.
 */
function readSetupForm() {
  const p = getProvider(settings.provider);
  if (p.id === 'custom') {
    return {
      provider: 'custom',
      baseUrl: dom.setupBaseUrl.value.trim(),
      model: dom.setupModel.value.trim(),
      apiKey: dom.setupCustomApiKey.value.trim(),
    };
  }
  return {
    provider: p.id,
    baseUrl: p.baseUrl,
    model: dom.setupModelSelect.value || p.defaultModel,
    apiKey: dom.setupApiKey.value.trim(),
  };
}

async function saveSetup() {
  const patch = readSetupForm();
  const check = validateProviderConfig(patch);
  if (!check.ok) {
    setSetupStatus(check.error, 'err');
    return;
  }

  dom.btnSetupSave.disabled = true;
  dom.btnSetupSave.textContent = 'Testing...';

  const target = getProvider(patch.provider).id === 'custom'
    ? new URL(patch.baseUrl).host
    : getProvider(patch.provider).label;
  setSetupStatus(`Requesting access to ${target}...`, 'busy');

  try {
    // Requested here, in the click handler, so Chrome sees a live user gesture.
    // Doing this via a message to the background worker fails with "must be
    // called during a user gesture" because the round-trip consumes it.
    const perm = await requestHostAccess(patch);
    if (!perm.ok) {
      setSetupStatus(perm.error || 'Permission denied.', 'err');
      return;
    }

    setSetupStatus(`Testing ${target}...`, 'busy');
    const res = await send({ type: 'TEST_PROVIDER', settings: { ...settings, ...patch } });
    if (!res.ok) {
      setSetupStatus(res.error || 'Connection failed.', 'err');
      return;
    }

    settings = { ...settings, ...patch, setupComplete: true };
    await Storage.saveSettings(settings);
    setSetupStatus(`Connected. Model ${res.model} responded.`, 'ok');
    applySetupGate();
    toast('AI connected. You are ready to go.', 'ok');
  } finally {
    dom.btnSetupSave.disabled = false;
    dom.btnSetupSave.textContent = 'Save & test';
  }
}

function setSetupStatus(msg, kind) {
  dom.setupStatus.textContent = msg || '';
  dom.setupStatus.className = 'setup-status' + (kind ? ' ' + kind : '');
}

// ─── Settings modal ──────────────────────────────────────────────────────────
function hydrateSettingsForm() {
  const p = getProvider(settings.provider);
  const custom = p.id === 'custom';

  $$('#providerGrid .provider-card').forEach(c => {
    c.classList.toggle('active', c.dataset.provider === p.id);
  });

  dom.presetFields.classList.toggle('hidden', custom);
  dom.customFields.classList.toggle('hidden', !custom);

  if (custom) {
    dom.settingBaseUrl.value = settings.baseUrl || '';
    dom.settingModel.value = settings.model || '';
    dom.settingCustomApiKey.value = settings.apiKey || '';
    dom.providerHint.textContent = p.note || '';
  } else {
    dom.settingApiKey.value = settings.apiKey || '';
    dom.providerHint.textContent = p.note || '';
    dom.keyHint.textContent = p.keyHint ? `Key looks like ${p.keyHint}` : '';
    fillModelSelect(dom.settingModelSelect, p.id, settings.model);
  }

  dom.settingLanguage.value = settings.language;
  dom.settingTemperature.value = settings.temperature;
  dom.tempValue.textContent = settings.temperature;
  dom.settingMaxChars.value = settings.maxChars;
  dom.settingAuthorContext.checked = !!settings.includeAuthorContext;
  dom.testResult.textContent = '';
}

function hydrateSelectionUI() {
  // Language
  $$('#langGroup .seg-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === settings.language);
  });
  // Tones
  const tones = settings.tones?.length ? settings.tones : ['friendly'];
  $$('#toneGroup .chip').forEach(chip => {
    chip.classList.toggle('active', tones.includes(chip.dataset.tone));
  });
  dom.draftsPerTone.value = settings.draftsPerTone || 3;
  updateGenerateState();
}

function updateGenerateState() {
  const ready = !!currentTweet && selectedTones().length > 0 && !busy;
  dom.btnGenerate.disabled = !ready;
  dom.btnAnalyze.disabled = busy;
}

// ─── Auth ────────────────────────────────────────────────────────────────────
async function checkAuth() {
  const res = await send({ type: 'GET_AUTH_STATUS' });
  if (res.authenticated) {
    authTokens = { userId: res.userId };
    dom.connectInfo.classList.add('hidden');
    dom.connectInfoOk.classList.remove('hidden');
    dom.connectedUser.textContent = res.userId ? `id ${res.userId}` : '@you';
    setStatus('Connected');
  } else {
    dom.connectInfo.classList.remove('hidden');
    dom.connectInfoOk.classList.add('hidden');
    setStatus('No x.com tab', 'warn');
  }
  return res.authenticated;
}

async function refreshUsage() {
  const res = await send({ type: 'GET_USAGE' });
  if (res.ok) dom.usageBadge.textContent = `${res.usage.calls} today`;
}

// ─── Target tweet polling ────────────────────────────────────────────────────
let lastResolvedId = null;

async function pollTargetTweet() {
  const res = await send({ type: 'GET_TARGET_TWEET' });
  if (!res.ok || !res.id) {
    setStatus('No post found', 'warn');
    return;
  }
  targetTabId = res.tabId;

  if (res.id !== lastResolvedId) {
    lastResolvedId = res.id;

    // Do NOT throw away work the user has already done. Switching tabs is
    // routine, and wiping currentTweet here left a generated result set with
    // no analysis above it and a disabled Generate button - the drafts looked
    // like they had vanished. Keep the analysis and drafts; only swap the
    // post preview so it reflects what is on screen now.
    if (!currentTweet || !currentDrafts.length) {
      currentTweet = null;
      currentAnalysis = null;
      renderTweetPlaceholder(res.meta, res.id, res.source);
      updateGenerateState();
    } else {
      // Someone else's post is now on screen while results are still open.
      // Leave the results alone and just note the change.
      dom.tweetTarget.dataset.drifted = '1';
    }
  }
}

function renderTweetPlaceholder(meta, id, source) {
  const name = meta?.author?.name || 'Unknown';
  const handle = meta?.author?.screen_name || 'unknown';
  dom.tweetTarget.innerHTML = `
    <div class="tt-author">
      <span class="tt-name">${escapeHtml(name)}</span>
      <span>@${escapeHtml(handle)}</span>
    </div>
    <div class="tt-text">${meta?.text ? escapeHtml(meta.text.slice(0, 400)) : '<span class="empty-msg">Press Analyze to load this post.</span>'}</div>
    <div class="tt-meta">
      <span>id ${escapeHtml(id)}</span>
      <span>detected via ${escapeHtml(source || 'dom')}</span>
    </div>`;
  dom.analysisPanel.classList.add('hidden');
}

// ─── Analyze ─────────────────────────────────────────────────────────────────
async function analyze() {
  if (busy) return;

  // Analysis itself is offline, but generating is not, so make the user fix
  // their key before they invest effort in picking a post.
  if (!validateProviderConfig(settings).ok) {
    setSetupStatus('Connect your AI provider first.', 'err');
    applySetupGate();
    dom.setupPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast('Set up your AI key first.', 'err');
    return;
  }

  setBusy(true, 'Working...');
  dom.analyzeLabel.textContent = 'Analyzing...';
  setStatus('Analyzing', 'busy');
  dom.progressText.textContent = 'Fetching post...';

  try {
    const target = await send({ type: 'GET_TARGET_TWEET' });
    if (!target.ok || !target.id) {
      throw new Error('No post detected. Click a post on x.com first, or open its detail view.');
    }
    targetTabId = target.tabId;

    dom.progressText.textContent = 'Analyzing content...';
    const res = await send({
      type: 'ANALYZE_TWEET',
      tweetId: target.id,
      withAuthorContext: settings.includeAuthorContext !== false,
      tweet: null,
    });
    if (!res.ok) throw new Error(res.error);

    currentTweet = res.tweet;
    currentAnalysis = res.analysis;

    renderTweet(currentTweet);
    renderAnalysis(res.analysis);
    setStatus('Analyzed');
    toast('Post analyzed', 'ok');
  } catch (err) {
    setStatus('Error', 'err');
    toast(err.message, 'err');
    console.error('[Reply Guy] analyze failed:', err);
  } finally {
    setBusy(false, 'Generate Replies');
    dom.analyzeLabel.textContent = 'Analyze';
    updateGenerateState();
  }
}

function renderTweet(tweet) {
  const m = tweet.metrics || {};
  dom.tweetTarget.innerHTML = `
    <div class="tt-author">
      <span class="tt-name">${escapeHtml(tweet.author?.name || 'Unknown')}</span>
      <span>@${escapeHtml(tweet.author?.screen_name || 'unknown')}</span>
      ${tweet.author?.followers ? `<span>· ${formatCount(tweet.author.followers)} followers</span>` : ''}
    </div>
    <div class="tt-text">${escapeHtml(tweet.text)}</div>
    <div class="tt-meta">
      <span>${formatCount(m.likes)} likes</span>
      <span>${formatCount(m.replies)} replies</span>
      <span>${formatCount(m.retweets)} rts</span>
      <span>${formatCount(m.views)} views</span>
      ${tweet._source ? `<span>via ${escapeHtml(tweet._source)}</span>` : ''}
    </div>`;
}

function renderAnalysis(a) {
  if (!a) { dom.analysisPanel.classList.add('hidden'); return; }

  const sentimentPct = Math.round((a.sentiment.score + 1) / 2 * 100);
  const cards = [
    { label: 'Intent', value: a.intent, sub: a.intentSignals.length ? a.intentSignals.join(', ') : (a.isQuestion ? 'question detected' : '') },
    { label: 'Sentiment', value: a.sentiment.label, sub: `score ${a.sentiment.score} · intensity ${a.sentiment.intensity}/3` },
    { label: 'Topics', value: a.topics.length ? a.topics.slice(0, 2).join(', ') : a.topic, sub: a.topics.slice(2, 5).join(', ') },
    { label: 'Detected lang', value: a.language, sub: `${a.stats.words} words · ${a.stats.chars} chars` },
    { label: 'Keywords', value: a.keywords.slice(0, 3).join(', ') || '—', sub: a.keywords.slice(3, 6).join(', ') },
    { label: 'Entities', value: [a.entities.hashtags.length && `${a.entities.hashtags.length} tags`, a.entities.mentions.length && `${a.entities.mentions.length} @`, a.entities.numbers.length && `${a.entities.numbers.length} nums`].filter(Boolean).join(' · ') || 'none', sub: a.entities.cashtags.join(' ') },
  ];

  dom.analysisGrid.innerHTML = cards.map(c => `
    <div class="analysis-card">
      <div class="ac-label">${escapeHtml(c.label)}</div>
      <div class="ac-value" title="${escapeHtml(c.value)}">${escapeHtml(c.value || '—')}</div>
      ${c.sub ? `<div class="ac-sub" title="${escapeHtml(c.sub)}">${escapeHtml(c.sub)}</div>` : ''}
    </div>`).join('');

  if (a.hooks?.length) {
    dom.analysisHooks.classList.remove('hidden');
    dom.analysisHooks.innerHTML = `
      <div class="ah-title">Reply angles</div>
      <ul>${a.replyAngles.slice(0, 4).map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`;
  } else {
    dom.analysisHooks.classList.add('hidden');
  }

  dom.analysisPanel.classList.remove('hidden');
}

// ─── Generate ────────────────────────────────────────────────────────────────
async function generate() {
  if (busy) return;

  if (!currentTweet) {
    toast('Analyze a post first', 'err');
    return;
  }
  const tones = selectedTones();
  if (!tones.length) {
    toast('Pick at least one tone', 'err');
    return;
  }

  const provider = getProvider(settings.provider);
  if (!settings.apiKey && !provider.noKey) {
    toast('No API key set. Open Settings.', 'err');
    openSettings();
    return;
  }

  setBusy(true, 'Generating...');
  setStatus('Generating', 'busy');
  dom.progressFill.classList.add('indeterminate');
  dom.progressText.textContent = 'Writing drafts...';
  dom.draftList.innerHTML = '<div class="shimmer"></div><div class="shimmer"></div><div class="shimmer"></div>';
  dom.sectionDrafts.classList.remove('hidden');
  dom.statsDrafts.textContent = 'working';
  dom.statsTones.textContent = `${tones.length} tones`;
  dom.statsQuality.textContent = '';

  try {
    const draftsPerTone = Math.max(1, Math.min(6, parseInt(dom.draftsPerTone.value, 10) || 3));

    const res = await send({
      type: 'GENERATE_DRAFTS',
      tweet: currentTweet,
      analysis: currentAnalysis,
      language: selectedLang(),
      tones,
      draftsPerTone,
      settings: { ...settings, language: selectedLang(), tones },
    });
    if (!res.ok) throw new Error(res.error);

    // Defensive: a response that is "ok" but carries no usable array would
    // otherwise render an empty panel and toast a success, which reads as
    // "it worked" while showing nothing. Fail loudly instead.
    if (!Array.isArray(res.drafts) || !res.drafts.length) {
      console.warn('[Reply Guy] generate returned ok but no drafts:', res);
      throw new Error('The model returned no drafts. Try again, or switch model.');
    }

    currentDrafts = res.drafts;
    renderDrafts();
    // Bring the drafts into view automatically. The user pressed a button to get
    // them, so they should not have to go looking.
    revealResults();
    await refreshUsage();

    const pass = currentDrafts.filter(d => d.ok).length;
    setStatus('Done');
    toast(`${currentDrafts.length} drafts · ${pass} clean`, pass === currentDrafts.length ? 'ok' : '');
  } catch (err) {
    setStatus('Error', 'err');
    dom.draftList.innerHTML = `<p class="empty-msg">${escapeHtml(err.message)}</p>`;
    dom.statsDrafts.textContent = 'failed';
    toast(err.message, 'err');
    console.error('[Reply Guy] generate failed:', err);
  } finally {
    setBusy(false, 'Generate Replies');
  }
}

// ─── Draft rendering ─────────────────────────────────────────────────────────
function sortedDrafts() {
  const mode = dom.sortDrafts.value;
  const list = [...currentDrafts];
  if (mode === 'quality') {
    list.sort((a, b) => (a.ok === b.ok ? a.quality.aiSmell - b.quality.aiSmell : (a.ok ? -1 : 1)));
  } else if (mode === 'short') {
    list.sort((a, b) => a.quality.chars - b.quality.chars);
  } else if (mode === 'long') {
    list.sort((a, b) => b.quality.chars - a.quality.chars);
  }
  return list;
}

function renderDrafts() {
  // Ids are positional within the current sort order. Both this function and
  // bindDraftActions() derive them from sortedDrafts(), so they always agree.
  const ordered = sortedDrafts();
  ordered.forEach((d, i) => { d._id = 'd' + i; });
  if (!currentDrafts.length) {
    dom.draftList.innerHTML = '<p class="empty-msg">No drafts.</p>';
    return;
  }

  const pass = currentDrafts.filter(d => d.ok).length;
  const toneCount = new Set(currentDrafts.map(d => d.tone)).size;

  dom.statsDrafts.textContent = `${currentDrafts.length} drafts`;
  dom.statsTones.textContent = `${toneCount} tone${toneCount > 1 ? 's' : ''}`;
  dom.statsQuality.textContent = `${pass}/${currentDrafts.length} clean`;
  dom.statsQuality.style.color = pass === currentDrafts.length
    ? 'var(--accent-green)'
    : (pass === 0 ? 'var(--accent-red)' : 'var(--accent-yellow)');

  dom.sectionDrafts.classList.remove('hidden');

  dom.draftList.innerHTML = ordered.map(d => draftCardHtml(d)).join('');
  bindDraftActions();
  updateResultsJump();
}

/**
 * Keeps the jump-bar under Generate in sync with the drafts.
 *
 * Without this the results live only in the drafts section further down the
 * panel, which is easy to miss and easy to mistake for "nothing happened".
 */
function updateResultsJump() {
  if (!dom.btnResultsJump) return;
  const n = currentDrafts.length;
  if (!n) {
    dom.btnResultsJump.classList.add('hidden');
    return;
  }
  const clean = currentDrafts.filter(d => d.ok).length;
  dom.resultsJumpCount.textContent = String(n);
  dom.resultsJumpLabel.textContent = clean === n
    ? (n === 1 ? 'reply ready' : 'replies ready')
    : `${clean} clean \u00b7 ${n - clean} flagged`;
  dom.btnResultsJump.classList.remove('hidden');
}

/** Scrolls the results into view and flashes them, so the eye can follow. */
function revealResults() {
  dom.sectionDrafts.scrollIntoView({ behavior: 'smooth', block: 'start' });
  dom.sectionDrafts.classList.remove('results-flash');
  // Force a reflow so the animation restarts on repeated clicks.
  void dom.sectionDrafts.offsetWidth;
  dom.sectionDrafts.classList.add('results-flash');
  setTimeout(() => dom.sectionDrafts.classList.remove('results-flash'), 1200);
}

function qualityBadges(d) {
  const q = d.quality;
  const items = [];

  const emojiOk = q.emoji.length === 0;
  items.push(dotBadge(emojiOk ? 'good' : 'bad', 'no emoji', emojiOk ? 'clean' : q.emoji.join(' ')));

  const aiOk = q.aiSmell < 30;
  const aiMid = q.aiSmell >= 30 && q.aiSmell < 45;
  items.push(dotBadge(aiOk ? 'good' : (aiMid ? 'warn' : 'bad'), 'original', `AI-smell ${q.aiSmell}`));

  items.push(dotBadge(!q.slangMissing ? 'good' : 'warn', 'slang',
    q.slang.length ? q.slang.slice(0, 2).join(', ') : 'none found'));

  if (q.repetition > 30) {
    items.push(dotBadge(q.repetition > 62 ? 'bad' : 'warn', 'unique', `${q.repetition}% overlap`));
  }

  return items.join('');
}

function dotBadge(kind, label, title) {
  return `<span class="q-item" title="${escapeHtml(title)}"><span class="q-dot ${kind === 'good' ? '' : kind}"></span>${escapeHtml(label)}</span>`;
}

function blockingMessage(blocking) {
  const map = {
    emoji: 'Contains emoji — violates the no-emoji rule.',
    banned_phrase: 'Contains AI-sounding filler phrases.',
    ai_smell: 'Reads as generated text. Regenerate or edit before using.',
    too_long: 'Over the character limit.',
    repetition: 'Too similar to another draft in this set.',
    empty: 'Empty output.',
  };
  return blocking.map(b => map[b] || b).join(' ');
}

function draftCardHtml(d) {
  const q = d.quality;
  const statusBadge = d.ok
    ? '<span class="draft-badge good">clean</span>'
    : `<span class="draft-badge bad">${d.blocking.length} issue${d.blocking.length > 1 ? 's' : ''}</span>`;
  const repairedBadge = d.repaired ? '<span class="draft-badge repaired">repaired</span>' : '';
  const editedBadge = d.edited ? '<span class="draft-badge repaired">edited</span>' : '';
  const overLimit = q.chars > settings.maxChars;
  const id = escapeHtml(d._id);

  return `
    <div class="draft-card ${d.ok ? '' : 'is-flagged'}">
      <div class="draft-head">
        <span class="tone-tag" data-tone="${escapeHtml(d.tone)}">${escapeHtml(toneLabel(d.tone))}</span>
        ${statusBadge}
        ${repairedBadge}
        ${editedBadge}
      </div>
      ${!d.ok ? `<div class="draft-warning">${escapeHtml(blockingMessage(d.blocking))}</div>` : ''}
      <div class="draft-text">${escapeHtml(d.text)}</div>
      <div class="draft-quality">${qualityBadges(d)}</div>
      <div class="draft-actions-row">
        <button class="btn-sm btn-insert" data-insert="${escapeHtml(d._id)}">Insert</button>
        <button class="btn-sm btn-outline" data-copy="${escapeHtml(d._id)}">Copy</button>
        <button class="btn-sm btn-outline" data-edit="${escapeHtml(d._id)}">Use as base</button>
        <span class="draft-charcount ${overLimit ? 'over' : ''}">${q.chars}/${settings.maxChars}</span>
      </div>
    </div>`;
}

function bindDraftActions() {
  // Ids are assigned by renderDrafts() in sorted order. Rebuild the same
  // ordering here so the DOM ids resolve to the right draft.
  const ordered = sortedDrafts();
  const byId = new Map(ordered.map((d, i) => ['d' + i, d]));

  $$('#draftList [data-insert]').forEach(btn => {
    btn.addEventListener('click', () => insertDraft(byId.get(btn.dataset.insert)));
  });
  $$('#draftList [data-copy]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const d = byId.get(btn.dataset.copy);
      if (!d) return;
      await navigator.clipboard.writeText(d.text);
      toast('Copied', 'ok');
    });
  });
  $$('#draftList [data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const d = byId.get(btn.dataset.edit);
      if (!d) return;
      const edited = prompt('Edit before inserting:', d.text);
      if (edited && edited.trim()) {
        const next = edited.trim();
        d.text = next;
        // Re-validate the edit so the badges stay honest.
        const r = validateDraft(next, { lang: selectedLang(), maxChars: settings.maxChars });
        d.quality = r.quality;
        d.ok = r.ok;
        d.blocking = r.blocking;
        d.edited = true;
        renderDrafts();
      }
    });
  });
}

// ─── Insert into composer ────────────────────────────────────────────────────
async function insertDraft(draft) {
  if (!draft) return;
  if (!targetTabId) {
    toast('No x.com tab bound. Re-run Analyze.', 'err');
    return;
  }

  try {
    const res = await send({
      type: 'INSERT_REPLY',
      tabId: targetTabId,
      tweetId: currentTweet?.id,
      text: draft.text,
    });
    if (!res.ok) throw new Error(res.error);
    setStatus('Inserted');
    toast('Inserted into the reply box. Review before posting.', 'ok');
  } catch (err) {
    setStatus('Insert failed', 'err');
    toast(err.message, 'err');
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────
function openSettings() {
  hydrateSettingsForm();
  dom.testResult.textContent = '';
  dom.settingsModal.classList.remove('hidden');
}

async function saveSettings() {
  const p = getProvider(settings.provider);
  const custom = p.id === 'custom';

  const patch = custom
    ? {
        provider: 'custom',
        baseUrl: dom.settingBaseUrl.value.trim(),
        model: dom.settingModel.value.trim(),
        apiKey: dom.settingCustomApiKey.value.trim(),
      }
    : {
        provider: p.id,
        // Base URL always comes from the registry for named providers.
        baseUrl: p.baseUrl,
        model: dom.settingModelSelect.value || p.defaultModel,
        apiKey: dom.settingApiKey.value.trim(),
      };

  const check = validateProviderConfig(patch);
  if (!check.ok) {
    dom.testResult.textContent = check.error;
    dom.testResult.className = 'setting-hint err';
    return;
  }

  settings = {
    ...settings,
    ...patch,
    language: dom.settingLanguage.value,
    temperature: parseFloat(dom.settingTemperature.value) || 0.95,
    maxChars: parseInt(dom.settingMaxChars.value, 10) || 260,
    includeAuthorContext: dom.settingAuthorContext.checked,
    tones: selectedTones().length ? selectedTones() : ['friendly'],
    draftsPerTone: parseInt(dom.draftsPerTone.value, 10) || 3,
    setupComplete: true,
  };

  await Storage.saveSettings(settings);
  hydrateSelectionUI();
  renderSetupForm();
  applySetupGate();
  dom.settingsModal.classList.add('hidden');
  toast('Saved', 'ok');
}

// ─── History ─────────────────────────────────────────────────────────────────
async function openHistory() {
  const drafts = await Storage.getDrafts();
  if (!drafts.length) {
    dom.historyContainer.innerHTML = '<p class="empty-msg">No drafts yet.</p>';
  } else {
    dom.historyContainer.innerHTML = drafts.slice(0, 60).map(d => `
      <div class="history-item">
        <div class="hi-head">
          <span class="tone-tag" data-tone="${escapeHtml(d.tone)}">${escapeHtml(toneLabel(d.tone))}</span>
          <span>${escapeHtml((d.language || '').toUpperCase())}</span>
          <span>@${escapeHtml(d.author || 'unknown')}</span>
        </div>
        <div class="hi-text">${escapeHtml(d.text)}</div>
        <div class="hi-actions">
          <button class="btn-sm btn-outline" data-hist-copy="${escapeHtml(d.id)}">Copy</button>
        </div>
      </div>`).join('');

    $$('#historyContainer [data-hist-copy]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const d = drafts.find(x => x.id === btn.dataset.histCopy);
        if (d) { await navigator.clipboard.writeText(d.text); toast('Copied', 'ok'); }
      });
    });
  }
  dom.historyModal.classList.remove('hidden');
}

// ─── Events ──────────────────────────────────────────────────────────────────
function wireEvents() {
  dom.btnAnalyze.addEventListener('click', analyze);
  dom.btnGenerate.addEventListener('click', generate);
  dom.btnRegenerate.addEventListener('click', generate);
  dom.btnClearDrafts.addEventListener('click', () => {
    currentDrafts = [];
    dom.sectionDrafts.classList.add('hidden');
    updateResultsJump();
  });
  if (dom.btnResultsJump) {
    dom.btnResultsJump.addEventListener('click', revealResults);
  }
  dom.btnCopyAll.addEventListener('click', async () => {
    const text = currentDrafts.map(d => `[${toneLabel(d.tone)}] ${d.text}`).join('\n\n');
    await navigator.clipboard.writeText(text);
    toast(`${currentDrafts.length} drafts copied`, 'ok');
  });

  dom.sortDrafts.addEventListener('change', () => {
    if (currentDrafts.length) renderDrafts();
  });

  dom.draftsPerTone.addEventListener('change', () => {
    settings.draftsPerTone = parseInt(dom.draftsPerTone.value, 10) || 3;
  });

  // Language
  dom.langGroup.addEventListener('click', (e) => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#langGroup .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    settings.language = btn.dataset.lang;
    updateGenerateState();
  });

  // Tones
  dom.toneGroup.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    chip.classList.toggle('active');
    if (!selectedTones().length) chip.classList.add('active'); // never allow zero
    settings.tones = selectedTones();
    updateGenerateState();
  });

  // Theme
  dom.btnTheme.addEventListener('click', async () => {
    const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    settings.theme = next;
    await Storage.saveSettings(settings);
  });

  // Settings modal
  dom.btnSettings.addEventListener('click', openSettings);
  dom.btnCloseSettings.addEventListener('click', () => dom.settingsModal.classList.add('hidden'));
  dom.btnSaveSettings.addEventListener('click', saveSettings);
  dom.btnResetSettings.addEventListener('click', async () => {
    settings = { ...DEFAULTS };
    await Storage.saveSettings(settings);
    hydrateSettingsForm();
    hydrateSelectionUI();
    renderSetupForm();
    applySetupGate();
    toast('Reset to defaults', 'ok');
  });

  // Provider cards: clicking one switches the visible field group.
  dom.providerGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    // Switching provider invalidates the previously entered key, so do not
    // carry it across. Each vendor needs its own key.
    settings = { ...settings, provider: card.dataset.provider, apiKey: '', model: '' };
    hydrateSettingsForm();
  });

  dom.setupProviderGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.provider-card');
    if (!card) return;
    settings = { ...settings, provider: card.dataset.provider, apiKey: '', model: '', baseUrl: '' };
    renderSetupForm();
    setSetupStatus('', '');
  });

  dom.btnSetupToggleKey.addEventListener('click', () => {
    const el = isCustomProvider(settings.provider) ? dom.setupCustomApiKey : dom.setupApiKey;
    const isPw = el.type === 'password';
    el.type = isPw ? 'text' : 'password';
    dom.btnSetupToggleKey.textContent = isPw ? 'Hide' : 'Show';
  });

  dom.btnSetupSave.addEventListener('click', saveSetup);

  // Enter in the setup fields should just submit.
  for (const el of [dom.setupApiKey, dom.setupModel, dom.setupBaseUrl, dom.setupCustomApiKey]) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveSetup(); }
    });
  }

  dom.btnToggleKey.addEventListener('click', () => {
    const el = isCustomProvider(settings.provider) ? dom.settingCustomApiKey : dom.settingApiKey;
    const isPw = el.type === 'password';
    el.type = isPw ? 'text' : 'password';
    dom.btnToggleKey.textContent = isPw ? 'Hide' : 'Show';
  });

  dom.settingTemperature.addEventListener('input', () => {
    dom.tempValue.textContent = dom.settingTemperature.value;
  });

  dom.btnFetchModels.addEventListener('click', async () => {
    dom.btnFetchModels.disabled = true;
    dom.btnFetchModels.textContent = '...';
    try {
      const res = await send({
        type: 'LIST_MODELS',
        settings: {
          provider: 'custom',
          baseUrl: dom.settingBaseUrl.value.trim(),
          model: dom.settingModel.value.trim(),
          apiKey: dom.settingCustomApiKey.value.trim(),
        },
      });
      if (!res.ok) throw new Error(res.error);
      dom.modelList.innerHTML = res.models.map(m => `<option value="${escapeHtml(m)}">`).join('');
      toast(`${res.models.length} models loaded. Start typing in the field.`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      dom.btnFetchModels.disabled = false;
      dom.btnFetchModels.textContent = 'Fetch';
    }
  });

  dom.btnTestProvider.addEventListener('click', async () => {
    dom.btnTestProvider.disabled = true;
    dom.testResult.className = 'setting-hint';
    dom.testResult.textContent = 'Testing...';

    // Test exactly what the modal currently shows, not what is saved, so the
    // button works as a pre-save check.
    const p = getProvider(settings.provider);
    const custom = p.id === 'custom';
    const candidate = custom
      ? {
          provider: 'custom',
          baseUrl: dom.settingBaseUrl.value.trim(),
          model: dom.settingModel.value.trim(),
          apiKey: dom.settingCustomApiKey.value.trim(),
        }
      : {
          provider: p.id,
          baseUrl: p.baseUrl,
          model: dom.settingModelSelect.value || p.defaultModel,
          apiKey: dom.settingApiKey.value.trim(),
        };

    try {
      const pre = validateProviderConfig(candidate);
      if (!pre.ok) throw new Error(pre.error);

      // Must happen here, inside the click handler, for the user gesture.
      const perm = await requestHostAccess(candidate);
      if (!perm.ok) throw new Error(perm.error);

      const res = await send({ type: 'TEST_PROVIDER', settings: { ...settings, ...candidate } });
      if (!res.ok) throw new Error(res.error);
      dom.testResult.className = 'setting-hint ok';
      dom.testResult.textContent = `Working. ${res.model} replied.`;
    } catch (err) {
      dom.testResult.className = 'setting-hint err';
      dom.testResult.textContent = err.message;
    } finally {
      dom.btnTestProvider.disabled = false;
    }
  });

  // History modal
  dom.btnHistory.addEventListener('click', openHistory);
  dom.btnCloseHistory.addEventListener('click', () => dom.historyModal.classList.add('hidden'));
  dom.btnClearHistory.addEventListener('click', async () => {
    await Storage.clearDrafts();
    dom.historyContainer.innerHTML = '<p class="empty-msg">No drafts yet.</p>';
    toast('History cleared', 'ok');
  });

  // Close modals on overlay click
  [dom.settingsModal, dom.historyModal].forEach(m => {
    m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); });
  });

  // Escape closes modals
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      dom.settingsModal.classList.add('hidden');
      dom.historyModal.classList.add('hidden');
    }
  });

  // Status updates from the background worker
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RG_PROGRESS') {
      dom.progressText.textContent = msg.message || msg.phase;
    }
    if (msg.type === 'RG_RATE_LIMITED') {
      dom.progressText.textContent = `Rate limited. Waiting ${Math.round(msg.wait / 1000)}s...`;
      setStatus('Rate limited', 'warn');
    }
  });

  // Re-poll the target tweet when the user switches tabs.
  chrome.tabs.onActivated.addListener(() => setTimeout(pollTargetTweet, 400));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.status === 'complete' || info.url) setTimeout(pollTargetTweet, 600);
  });
}
