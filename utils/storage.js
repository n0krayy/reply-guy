/**
 * Reply Guy — Storage utility
 * chrome.storage.local wrapper. Same shape as the reference repo's utils/storage.js
 * so the mental model carries over.
 */

const Storage = {
  async get(key, fallback = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get(key, (result) => {
        if (chrome.runtime.lastError) { resolve(fallback); return; }
        resolve(result[key] !== undefined ? result[key] : fallback);
      });
    });
  },

  async set(key, value) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: value }, resolve);
    });
  },

  async remove(key) {
    return new Promise((resolve) => {
      chrome.storage.local.remove(key, resolve);
    });
  },

  // ─── Settings ───────────────────────────────────────────────────────────
  // Defaults mirror lib/constants.js DEFAULTS. Only `apiKey`, `baseUrl`,
  // `model` and `provider` are user-editable in setup.
  async getSettings() {
    const s = await this.get('settings', {});
    return {
      provider: 'deepseek',
      apiKey: '',
      baseUrl: '',
      model: 'deepseek-chat',
      draftsPerTone: 3,
      temperature: 0.95,
      maxChars: 260,
      language: 'id-ID',
      tones: ['friendly'],
      theme: 'dark',
      includeAuthorContext: true,
      autoInsert: false,
      setupComplete: false,
      ...s,
    };
  },

  async saveSettings(settings) {
    return this.set('settings', settings);
  },

  // Merges a patch into settings rather than replacing wholesale, so a partial
  // write from one panel cannot blank out fields owned by another.
  async patchSettings(patch) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await this.set('settings', next);
    return next;
  },

  // ─── Theme ──────────────────────────────────────────────────────────────
  async getTheme() {
    return this.get('theme', 'dark');
  },
  async saveTheme(theme) {
    return this.set('theme', theme);
  },

  // ─── Draft history ──────────────────────────────────────────────────────
  async getDrafts() {
    return this.get('draftHistory', []);
  },

  async addDrafts(entries) {
    const list = await this.getDrafts();
    const merged = [...entries, ...list];
    if (merged.length > 300) merged.length = 300;
    await this.set('draftHistory', merged);
    return merged;
  },

  async clearDrafts() {
    await this.set('draftHistory', []);
    return [];
  },

  // ─── Tweet cache ────────────────────────────────────────────────────────
  // Keyed by tweet id so re-opening the same tweet is instant and does not
  // cost another API call.
  async getCachedTweet(id) {
    const cache = await this.get('tweetCache', {});
    const entry = cache[id];
    if (!entry) return null;
    if (Date.now() - entry.at > 30 * 60 * 1000) return null; // 30 min TTL
    return entry.data;
  },

  async cacheTweet(id, data) {
    const cache = await this.get('tweetCache', {});
    cache[id] = { at: Date.now(), data };
    const keys = Object.keys(cache);
    if (keys.length > 80) {
      keys.sort((a, b) => cache[a].at - cache[b].at);
      for (const k of keys.slice(0, keys.length - 80)) delete cache[k];
    }
    await this.set('tweetCache', cache);
  },

  // ─── Usage counter (requests today) ─────────────────────────────────────
  async getUsage() {
    const today = new Date().toISOString().slice(0, 10);
    const u = await this.get('usage', null);
    if (!u || u.date !== today) return { date: today, calls: 0, tokens: 0 };
    return u;
  },
  async bumpUsage(tokens = 0) {
    const u = await this.getUsage();
    u.calls += 1;
    u.tokens += tokens;
    await this.set('usage', u);
    return u;
  },
};
