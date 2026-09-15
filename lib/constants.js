/**
 * Reply Guy — Shared constants
 * Single source of truth for enums used by UI, prompt builder and validators.
 */

export const LANGUAGES = [
  { id: 'en-US', label: 'American English', native: 'American English', short: 'EN' },
  { id: 'id-ID', label: 'Indonesia',        native: 'Bahasa Indonesia', short: 'ID' },
  { id: 'zh-CN', label: 'Mandarin (Simplified)', native: '简体中文',     short: 'ZH' },
];

export const TONES = [
  { id: 'friendly',     label: 'Friendly',     accent: 'green'  },
  { id: 'playful',      label: 'Playful',      accent: 'blue'   },
  { id: 'formal',       label: 'Formal',       accent: 'yellow' },
  { id: 'softselling',  label: 'Soft Selling', accent: 'orange' },
  { id: 'edukatif',     label: 'Edukatif',     accent: 'blue'   },
];

export const TONE_IDS = TONES.map(t => t.id);
export const LANG_IDS = LANGUAGES.map(l => l.id);

export const DEFAULTS = {
  // AI provider. The user must supply their own key — see lib/providers.js.
  provider: 'deepseek',
  apiKey: '',
  // Only used when provider is 'custom'. For the five named providers the
  // base URL always comes from the registry so a stale saved value can never
  // redirect a key to the wrong host.
  baseUrl: '',
  model: 'deepseek-chat',

  draftsPerTone: 3,
  temperature: 0.95,
  maxChars: 180,
  language: 'id-ID',
  tones: ['friendly'],
  theme: 'dark',
  includeAuthorContext: true,
  setupComplete: false,
};

/**
 * How long a reply is allowed to be.
 *
 * A reply is a comment under someone else's post, not an essay. X itself
 * supports 280 characters, but a 280-character reply reads as generated: real
 * people type a line or two and hit send. Length is therefore a style rule, not
 * just a cap.
 *
 * - `target`  what the model should aim for
 * - `max`     hard ceiling; exceeding it is a blocking violation
 *
 * There is intentionally no minimum. "facts", "fr this is it" and "setuju bgt"
 * are real replies, and a floor would reject exactly the short, human output
 * this extension is meant to produce.
 */
export const REPLY_LENGTH = {
  target: 120,
  max: 180,
};

/**
 * Word-count sanity for replies. Word count catches a draft that slips under the
 * character ceiling by using many very short words.
 *
 * No minimum here either, for the same reason as above.
 */
export const REPLY_WORDS = {
  target: 22,
  max: 32,
};

/**
 * Known X GraphQL query IDs for TweetResultByRestId.
 * X rotates these. The background worker tries each in order and falls
 * back to REST v1.1 when all of them 404.
 */
export const TWEET_QUERY_IDS = [
  'xd_EMdYvB9hfZsZ6Idri0w',
  'QuBlQ4o2LvGZjJV5M2hPDA',
  'nBS-WpgA6ZG0CyNHD517JQ',
  'VwKJcAd7zqlBOitPLUrB8A',
  '3X7dMjJPQDcMFCkcSCFVSA',
];

export const COMPOSE_FEATURE_FLAGS = [
  'creator_subscriptions_tweet_preview_api_enabled',
  'premium_content_api_read_enabled',
  'communities_web_enable_tweet_community_results_fetch',
  'c9s_tweet_anatomy_moderator_badge_enabled',
  'responsive_web_grok_analyze_button_fetch_trends_enabled',
  'responsive_web_grok_analyze_post_followups_enabled',
  'responsive_web_jetfuel_frame',
  'responsive_web_grok_share_attachment_enabled',
  'articles_preview_enabled',
  'responsive_web_edit_tweet_api_enabled',
  'graphql_is_translatable_rweb_tweet_is_translatable_enabled',
  'view_counts_everywhere_api_enabled',
  'longform_notetweets_consumption_enabled',
  'responsive_web_twitter_article_tweet_consumption_enabled',
  'tweet_awards_web_tipping_enabled',
  'responsive_web_grok_show_grok_translated_post',
  'responsive_web_grok_analysis_button_from_backend',
  'creator_subscriptions_quote_tweet_preview_enabled',
  'freedom_of_speech_not_reach_fetch_enabled',
  'standardized_nudges_misinfo',
  'tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled',
  'longform_notetweets_rich_text_read_enabled',
  'longform_notetweets_inline_media_enabled',
  'responsive_web_grok_image_annotation_enabled',
  'responsive_web_grok_community_note_auto_translation_is_enabled',
  'responsive_web_enhance_cards_enabled',
];
