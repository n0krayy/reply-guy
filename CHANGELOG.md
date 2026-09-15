# Changelog

All notable changes to Reply Guy are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Brevity is now a writing rule.** A reply is a comment under someone else's
  post, not an essay, and a long one reads as machine-written no matter how good
  the wording is. Drafts now target **120 characters / 22 words** against a hard
  ceiling of **180 characters / 32 words**. Anything over the ceiling is rejected
  and sent back for a rewrite.
  - The prompt gained a dedicated brevity section: no preamble, no explaining the
    reasoning, never summarise the post back to its author, no closing line, and
    cut a whole clause rather than trimming word by word.
  - The repair prompt knows how to fix an over-long draft specifically.
  - Verbose drafts under the ceiling still score worse on the AI-smell meter, so
    *Quality first* sorting pushes the tight ones to the top.
  - The default `maxChars` dropped from 260 to 180, the validator clamps to the
    policy ceiling so an old saved setting cannot disable the rule, and the
    settings input now advertises the real limit.
  - Draft cards gained a **length** badge grading the draft against the target.
- New `length` test suite (42 assertions) covering the policy, enforcement, the
  prompt text, and the Chinese-character edge case below.

### Fixed

- **An ordinary Chinese reply was being flagged as too long.** `countWords()`
  counted every hanzi as a word, so a normal 22-character zh-CN draft registered
  as 21 "words" and tripped the word ceiling while its AI-smell score was 0. CJK
  is now weighted at 2 units per character, the same way X counts it.

### Notes

- There is deliberately **no minimum length**. `facts`, `fr this is it` and
  `setuju bgt` are real replies, and a floor would reject exactly the short,
  human output this extension exists to produce.

## [1.0.0] — 2026-02-14

Initial release.

### Added

- **Tweet analysis** — fetches the focused post via X's internal GraphQL API
  with a REST v1.1 fallback, plus an offline analyzer for intent, sentiment,
  topic, hooks and reply angles.
- **3 languages** — American English, Bahasa Indonesia, Mandarin (Simplified).
- **5 tones** — Friendly, Playful, Formal, Soft Selling, Edukatif. Multi-select;
  each selected tone produces its own draft.
- **Two ways to connect an AI provider:**
  - Five named providers where you only paste a key — DeepSeek, Kimi (Moonshot),
    GLM (Zhipu), Google Gemini, ChatGPT (OpenAI).
  - A custom OpenAI-compatible endpoint (OpenRouter, Groq, Together, Ollama,
    llama.cpp, LM Studio, vLLM, ...). API key optional for local servers.
- **First-run setup gate** — the working UI stays hidden until a usable provider
  config exists, so there is no half-broken state.
- **Save & test** — validates the key with a 1-token request before saving.
- **Writing rule enforcement** — no emoji, no AI tells, slang required. Applied
  in the prompt and re-checked by a local validator on every draft.
- **Repair loop** — a draft that violates a rule gets one rewrite pass. Repairs
  run sequentially and are told which sibling drafts exist, so two near-duplicate
  drafts cannot both be "fixed" into the same text. A repair that does not
  improve the draft, or that would create a new near-duplicate, is rejected and
  the original kept. A throwing repair call never kills the run.
- **Quality badges** — per-draft AI-smell score, slang found, uniqueness against
  the rest of the set, and character count.
- **Draft history** — last 300 drafts, stored locally.
- **Composer insert** — one click writes a draft into the reply box.
- **Side panel support** and a matching light/dark X-native theme.
- **Rate limit protection** — random delays and bounded exponential backoff on
  X API calls.
- **Test suite** — 410 assertions across four suites covering the writing rules,
  manifest validity, module graph, and the full generate/repair pipeline against
  a mock model.

### Security

- The extension cannot post. No create-post endpoint is called, the Post button
  is never clicked programmatically, and the background worker refuses to insert
  unless the target tab is on a `*/status/<id>` detail view. All three are
  asserted by the test suite.
- For the five named providers the base URL is read from the compiled-in
  registry, never from stored settings, so a stale value cannot redirect an API
  key to another host.

[1.0.0]: https://github.com/n0krayy/reply-guy/releases/tag/v1.0.0
