<p align="center">
  <img src="assets/icon128.png" alt="Reply Guy Logo" width="80" height="80">
</p>

<h1 align="center">Reply Guy</h1>

<p align="center">
  <strong>Read any post on X, generate natural replies in 3 languages and 5 tones, drop them straight into the reply box.</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Manifest-V3-4285f4?style=flat-square&logo=googlechrome&logoColor=white" alt="Manifest V3">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/Version-1.0.0-orange?style=flat-square" alt="Version">
  <img src="https://img.shields.io/badge/Bring%20your%20own-AI%20key-1d9bf0?style=flat-square" alt="Bring your own key">
</p>

---

## What is this

Reply Guy is a Chrome extension that sits next to X.com and helps you write
replies that don't sound like a bot wrote them.

You click a post, hit **Analyze**, pick a language and a tone, and get a handful
of drafts. Pick one, edit it if you want, insert it into the reply box. You press
**Post** yourself - always.

Four writing rules are baked in and enforced twice (in the prompt *and* by a
local validator that every draft has to pass):

- **No emoji.** Not one.
- **Keep it short.** A reply is a comment, not an essay. 120 characters is the target, 180 is the hard ceiling, and anything longer is rejected. Long output is the single loudest sign that a machine wrote it.
- **Original sentence structure.** No AI tells, no "game-changer", no em dashes, no list-of-three rhythm.
- **Slang required.** Each language has its own word bank the model is told to draw from.

> **This is not a spam tool.** It writes drafts. You still choose what to post.
> The extension has no code path that can post, reply, like, or follow for you.

## 📏 Replies stay short

Real people write short comments. Long ones are the giveaway.

A reply under someone else's post is not a post of its own, and models default to
writing essays. So brevity is a rule, not a suggestion:

| | Target | Hard ceiling |
|---|---|---|
| Characters | **120** | **180** |
| Words | **22** | **32** |

Anything over the ceiling is **rejected** and sent back for a rewrite. The prompt
also tells the model what to strip, because "be brief" on its own just produces
the same length again:

- Get to the point in the first few words. No preamble.
- Don't explain your reasoning. A reaction or a jab, then stop.
- Never summarise the post back to its author. They wrote it.
- No closing line. Ending slightly abruptly is correct.
- Over the limit? Delete a whole clause, don't trim word by word.

Verbose drafts that stay under the ceiling still score worse on the AI-smell
meter, so **Sort: Quality first** pushes the tight ones to the top.

Two deliberate details:

- **There is no minimum length.** `facts`, `fr this is it` and `setuju bgt` are
  real replies. A floor would reject exactly the short, human output this tool
  exists to produce.
- **Chinese is weighted, not counted per character.** X counts CJK as 2 units.
  Counting one word per hanzi made an ordinary 22-character reply register as
  21 "words" and trip the word ceiling — so `countWords()` halves the hanzi count,
  the same way X does.

The ceiling is clamped in the validator, so an old saved `maxChars` of 260 cannot
quietly disable the rule.

## ✨ Features

- **Tweet Analysis** - Pulls the post you're looking at via X's internal GraphQL API, plus an offline analyzer that reads intent, sentiment, topic and hooks
- **3 Languages** - American English · Bahasa Indonesia · Mandarin (Simplified)
- **5 Tones** - Friendly · Playful · Formal · Soft Selling · Edukatif
- **Bring Your Own AI Key** - Five providers (DeepSeek, Kimi, GLM, Gemini, ChatGPT) or any custom OpenAI-compatible endpoint
- **Key Check Before Saving** - "Save & test" verifies your key with a 1-token request, so a bad key fails immediately instead of mid-reply
- **Writing Rule Enforcement** - Every draft is scored for emoji, banned phrases, AI-smell, repetition and length
- **Short By Design** - 120-character target, 180-character hard ceiling. Over-long replies are rejected and rewritten, because a wall of text is the clearest sign a machine wrote it
- **Auto Repair** - A draft that breaks a rule gets one rewrite pass, then is re-validated. A repair that makes things worse is rejected and the original kept
- **Quality Badges** - Each draft shows its AI-smell score, slang found, and uniqueness at a glance
- **Draft History** - Last 300 drafts, kept locally
- **Results jump-bar** - After a run, a "N replies ready" bar appears right under
  Generate and scrolls you to the drafts. You should never have to go looking for
  the output you asked for.
- **Side Panel Support** - Open as a sidebar alongside X.com
- **Insert to Composer** - One click writes the draft into the reply box, without posting
- **Light / Dark Theme** - Matches X.com's native look in either mode
- **Rate Limit Protection** - Random delays and bounded exponential backoff on X API calls

## 📦 Installation

### From Source (Developer Mode)

1. **Download** this repository:
   ```
   git clone https://github.com/n0krayy/reply-guy.git
   ```
   Or click **Code > Download ZIP** and extract it.

2. Open Chrome and navigate to:
   ```
   chrome://extensions/
   ```

3. Enable **Developer mode** (toggle in the top-right corner).

4. Click **"Load unpacked"** and select the `reply-guy` folder.

5. The extension icon will appear in your toolbar. Pin it for easy access.

6. **Open [x.com](https://x.com)** in a tab and make sure you are logged in.

7. Click the extension icon or right-click it and select **"Open in side panel"**.

## 🚀 First-Time Setup (Required)

Reply Guy has **no built-in AI**. It runs on your own API key. The first time you
open it you'll see a setup screen and you can't generate anything until you
connect a provider.

### Option 1 - Paste a key (easiest)

Pick one of these five, paste the key, hit **Save & test**. The base URL and
model list come from the extension, so there's nothing to type wrong.

| Provider | Get a key here | Default model | Why pick it |
|---|---|---|---|
| **DeepSeek** | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | `deepseek-chat` | Cheap and strong at casual writing. This is the default. |
| **Kimi (Moonshot)** | [platform.moonshot.ai](https://platform.moonshot.ai/console/api-keys) | `kimi-k2-0905-preview` | Best at Chinese slang and Mandarin tone |
| **GLM (Zhipu)** | [open.bigmodel.cn](https://open.bigmodel.cn/usercenter/apikeys) | `glm-4.5-flash` | Free tier on flash models. Key format is `id.secret` |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-2.0-flash` | Generous free tier |
| **ChatGPT (OpenAI)** | [platform.openai.com](https://platform.openai.com/api-keys) | `gpt-4o-mini` | Most consistent at obeying the no-emoji rule |

### Option 2 - Custom OpenAI-compatible endpoint

Pick **Custom (OpenAI-compatible)** and fill in:

- **Base URL** - anything exposing `/chat/completions`
- **Model** - the model name your endpoint expects
- **API key** - optional, leave blank for local servers

Works with OpenRouter, Groq, Together, Ollama, llama.cpp, LM Studio, vLLM, and
similar. There's a **Fetch** button that pulls the model list from `/models`
when the endpoint supports it.

Common base URLs:

| Service | Base URL |
|---|---|
| OpenRouter | `https://openrouter.ai/api/v1` |
| Groq | `https://api.groq.com/openai/v1` |
| Together | `https://api.together.xyz/v1` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |

Any `http(s)` URL works. On the first **Save & test**, Chrome asks you to allow
access to that specific host — click **Allow**. Reply Guy requests permission for
the exact origin you typed, at the moment you click, and nothing else.

> **If you get a "Could not reach … CORS" message**, the endpoint refuses
> browser requests. That is a limitation of the endpoint, not the extension: a
> server that does not send `Access-Control-Allow-Origin` cannot be called from a
> browser extension, and only the vendor can change that. DeepSeek, OpenAI, Groq
> and OpenRouter all allow it. Some smaller or self-hosted gateways do not.
 
> **Note:** If you switch providers later, the key field is cleared on purpose.
> Each vendor needs its own key.

## 📖 Usage

### Basic Workflow

1. **Open x.com** and make sure you're logged in
2. Click the extension icon - it should show **Connected** with your user ID
3. Scroll to the post you want to reply to and **click it** to open its detail view
4. Click **Analyze** - the post text and analysis appear
5. Pick a **language** (English / Indonesia / Mandarin)
6. Pick one or more **tones** (Friendly / Playful / Formal / Soft Selling / Edukatif)
7. Click **Generate** - drafts appear with quality badges
8. Review them, edit if you want, then click **Insert** to drop one into the reply box
9. **Read it once more, then press Post yourself**

### Understanding the Quality Badges

Each draft card shows what the validator found:

| Badge | Meaning |
|---|---|
| `clean` | Passed every rule |
| `1 issue` / `2 issues` | Blocked by something - hover the card to see what |
| `repaired` | Failed at first, was rewritten, now passes |
| `edited` | You changed it manually |
| `original` | AI-smell score. Lower is better. Under 30 is good |
| `slang` | Slang markers detected in the draft |
| `length` | Draft length vs. the target, graded as a reply |
| `unique` | Overlap with other drafts. Only shows above 30% |

Drafts that fail are **still shown**, with the reason. Nothing is hidden from you.

### Tips

- **Write in your own voice at the end.** The drafts are a starting point, not a finished product. Changing 3-4 words makes them genuinely yours.
- **Generate 2-3 tones at once** to get genuinely different angles on the same post
- **Use "Use as base"** to edit a draft before inserting instead of retyping it
- **Indonesian tone reads best** with DeepSeek or ChatGPT; **Mandarin reads best** with Kimi or GLM
- **Bump the temperature** to 1.0-1.1 in Settings if replies feel samey
- **Lower it** to 0.8 if they get too wild or off-topic
- **Open the side panel** instead of the popup - it's a much better experience on a wide screen

### Side Panel Mode

Click the extension icon to open it as a **side panel** alongside X.com. This
gives you more room for the post and the drafts at the same time.

## 📁 Project Structure

```
reply-guy/
├── manifest.json          # Chrome Extension Manifest V3
├── background.js          # Service worker - tweet fetch, LLM calls, repair loop, cache
├── content.js             # Content script - extracts auth tokens, bridges to the composer
├── popup/
│   ├── popup.html         # Main UI + setup screen + settings modal
│   ├── popup.js           # UI logic, state management, draft rendering
│   └── popup.css          # X-style dark/light theme
├── lib/
│   ├── constants.js       # Shared enums (languages, tones, defaults)
│   ├── rules.js           # Writing rules, banned lists, draft validator
│   ├── analyzer.js        # Offline tweet analyzer (intent/topic/sentiment/hooks)
│   ├── prompt.js          # Prompt builder + language/tone/slang policy + repair prompt
│   └── providers.js       # 5 named providers + custom, config validation, connection test
├── utils/
│   └── storage.js         # Chrome storage wrapper (settings, history, cache)
├── tests/
│   ├── run.mjs            # Test runner (npm test)
│   ├── rules.test.mjs     # Writing rules and validators
│   ├── length.test.mjs    # Brevity rule: target, ceiling, CJK weighting, prompt text
│   ├── manifest.test.mjs  # Manifest validity, file refs, syntax, safety invariants
│   ├── imports.test.mjs   # Module graph actually loads; enums agree across files
│   ├── scrape.test.mjs    # DOM tweet scraping against fixtures
│   ├── pipeline.test.mjs  # Full generate → validate → repair flow vs a mock model
│   ├── ui.test.mjs        # Results visibility, tab-switch state, jump-bar
│   ├── layout.test.mjs    # Panel scrolling and the single-scroller rule
│   └── live.test.mjs      # Same, against a real model (needs a key)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── assets/
│   ├── icon128.png
│   └── icon.svg
├── LICENSE
├── SECURITY.md
└── README.md
```

## 🔧 How It Works

### Authentication

The extension reads your existing X.com session cookies (`ct0` CSRF token and
`twid` user ID) directly from the page - it does **NOT** ask for your password or
create any new sessions.

### Reading the Post
Reading a post off X is done in three steps, most reliable first:

1. **Scrape it from the page.** X has already rendered the post into the DOM
   before the extension runs, so the content script can just read it. No network
   request, no query ID, no rate limit.
2. **GraphQL** (`TweetResultByRestId`) for posts that are not on screen.
3. **REST v1.1** (`statuses/show.json`) as a last resort.

The order is deliberate. GraphQL query IDs rotate, and X has retired much of the
v1.1 REST surface - so a fetch-only design eventually returns 404 for everyone,
no matter how correct the code is. The DOM path has no such dependency, which is
why it goes first. If all three fail, the extension says so instead of surfacing
a bare `404` that reads like a broken install.

Media-only posts (no text body) are rejected with an explanation, since there is
nothing for the model to analyze.

### API Calls

| Endpoint | Purpose |
|---|---|
| *(DOM scrape)* | Primary: read the post straight off the page |
| `GET /i/api/graphql/<qid>/TweetResultByRestId` | Fetch a post that is not on screen |
| `GET /1.1/statuses/show.json` | Last-resort post fetch |
| `GET /1.1/statuses/user_timeline.json` | Optional: author's recent posts for context |

### The Repair Loop

If a draft breaks a rule, it isn't just flagged - it's sent back to the model once
with a precise list of what it violated. Two details matter:

- **Repairs run one at a time and know about their siblings.** Each repair is told
  which other drafts already exist and that its rewrite must not be a variation of
  them. Two near-duplicate drafts repaired independently converge on the same
  replacement, which recreates the repetition the repair was meant to fix.
- **A repair is rejected if it doesn't help** or if it would create a new
  near-duplicate. The original is kept instead. A repair call that throws never
  kills the run.

### Safety Measures

- **Cannot post.** No create-post endpoint is called anywhere in the code, the
  Post button is never clicked programmatically, and the background worker
  refuses any insert unless the tab is on a `*/status/<id>` detail view. The test
  suite asserts all three.
- Random delays between X API calls
- Bounded exponential backoff with a max-retry limit on rate limits (429)
- Auth-failure detection that tells you to reconnect instead of retrying blindly

## ⚙️ Configuration

Open **Settings** (gear icon) to configure:

| Setting | Default | Description |
|---|---|---|
| Provider | DeepSeek | Which AI provider to use |
| Model | `deepseek-chat` | Model name |
| Default language | Bahasa Indonesia | Language pre-selected on open |
| Temperature | 0.95 | Higher = more varied and less generically AI-sounding |
| Max characters | 180 | Reply length ceiling (target is 120). Values above 180 are clamped |
| Drafts per tone | 3 | How many drafts each tone produces |
| Author context | On | Fetch the author's recent posts for better replies (costs 1 extra X call) |

Settings are stored in `chrome.storage.local` on your machine.

## 🧪 Development & Testing

No build step. Load the folder directly. For the test suite you need Node 18+.

```bash
npm test
```

| Suite | What it covers |
|---|---|
| `rules` | Emoji regex, banned phrases, AI-smell scoring, slang detection, validator verdicts |
| `length` | Brevity rule: 120-char target, 180-char ceiling, word ceiling, CJK weighting, the prompt's brevity section, and that short human replies still pass |
| `manifest` | Manifest validity, referenced files exist, syntax check on every JS file, popup DOM ids resolve, safety invariants |
| `imports` | The module graph actually loads, and enums agree across files |
| `pipeline` | Full generate → validate → repair → re-validate flow against a scripted mock model |

To test against a real model:

```bash
node tests/live.test.mjs deepseek deepseek-chat $API_KEY
node tests/live.test.mjs gemini gemini-2.0-flash $API_KEY
```

## ❓ FAQ

<details>
<summary><strong>Does this post for me?</strong></summary>

No, and it can't. There is no code that calls X's create-post endpoint, the Post
button is never clicked for you, and the background worker refuses to insert into
anything that isn't a post detail view. It writes drafts into the reply box. You
press Post.

</details>

<details>
<summary><strong>Do I need my own API key?</strong></summary>

Yes. Reply Guy ships with no AI built in. You connect your own provider key in
the setup screen. Most providers have a free tier - Gemini and GLM's flash models
are the easiest to start with for free.

</details>

<details>
<summary><strong>Is my API key safe?</strong></summary>

The key is stored in `chrome.storage.local`, which is unencrypted - that's the
normal ceiling for an unpacked extension. It is only ever sent to the provider
you picked. For the five named providers the base URL comes from the extension's
compiled-in list, never from a saved setting, so a stale value can't redirect
your key to another host.

Practical advice: treat it as a key you're willing to rotate, and use a spending
limit on the provider side where they offer one.

</details>

<details>
<summary><strong>Why does it say "Not connected"?</strong></summary>

Make sure you have x.com open in a tab and you are logged in. If it still
doesn't connect, refresh x.com (F5) and reopen the extension.

</details>

<details>
<summary><strong>Why do some drafts show a warning badge?</strong></summary>

The validator blocked them. Common reasons: an emoji slipped through, the
phrasing reads as AI-generated, it's over the character limit, or it's too
similar to another draft in the set. The extension tries to repair these
automatically. Anything it can't fix is shown with the reason so you can decide.

</details>

<details>
<summary><strong>The replies still sound a bit like AI. What can I do?</strong></summary>

Three things, in order of impact:

1. **Edit them.** Change a few words to your own phrasing. This is the biggest factor.
2. **Raise the temperature** in Settings to 1.0-1.1.
3. **Try a different model.** Larger models follow the slang rule more naturally instead of dropping in a slang word mechanically. DeepSeek and ChatGPT are the strongest for English and Indonesian.

</details>

<details>
<summary><strong>"Could not read this post" / "REST tweet fetch failed: 404".</strong></summary>

Reply Guy reads posts in three ways and only reports failure when all three miss:
scraping the rendered page, then GraphQL, then REST v1.1.

Almost always this means the post is not currently rendered on any open x.com
tab. The fix is simple: **open the post's own page** (click it so the URL ends in
`/status/<id>`), make sure it is visible, and try again.

If it still fails, the post may be deleted, protected, or withheld - or your X
session has gone stale. Reload x.com and try once more.

</details>

<details>
<summary><strong>My custom endpoint says "Could not reach …" but the URL works in the browser.</strong></summary>

Two things to check, in order.

**1. Did you allow the host permission?** On the first **Save & test** Chrome
shows a permission prompt naming your host. Click **Allow**. If you dismissed it,
press **Save & test** again on the same screen — a permission request is only
valid during the click that triggered it, so it cannot be raised later or in the
background.

**2. Does the endpoint allow browser requests?** A server only has to send
`Access-Control-Allow-Origin` for extensions to reach it. Testing the URL in an
address bar does not tell you anything — a normal page navigation is not subject
to the same rule. To check, look at the response of an `OPTIONS` request to your
endpoint; if the `access-control-allow-origin` header is missing or empty, the
vendor has to fix it. Nothing on the extension side can work around that.

</details>

<details>
<summary><strong>Can I use this with a local model?</strong></summary>

Yes. Pick **Custom**, set the base URL to your local server
(`http://localhost:11434/v1` for Ollama, `http://localhost:1234/v1` for LM Studio),
enter the model name, and leave the API key blank.

Fair warning: small local models follow the writing rules much less reliably and
you'll see more drafts with warning badges.

</details>

<details>
<summary><strong>X changed its interface and the Insert button stopped working.</strong></summary>

X's DOM selectors change without notice. The reply-button bridge tries
`data-testid="reply"`, then `[aria-label^="Reply"]`, then a text match. If all
three miss, open an issue with the post you were on.

</details>

## ⚠️ Disclaimer

> **Using this tool may risk your X/Twitter account. Use at your own risk.**
>
> This extension is provided "as is" without warranty of any kind. The author is
> not responsible for any consequences resulting from the use of this tool,
> including but not limited to account restrictions, suspensions, or bans by
> X/Twitter.
>
> This tool uses X's internal (unofficial) API. These endpoints may change or
> break at any time without notice.
>
> Using AI to mass-produce replies is a good way to get muted, reported, or
> suspended. This extension is built to help you write a better reply to a post
> you actually care about - not to flood timelines. Use it that way.

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Run the tests: `npm test`
4. Commit your changes: `git commit -m "Add my feature"`
5. Push to the branch: `git push origin feature/my-feature`
6. Open a Pull Request

## 📄 License

This project is licensed under the **MIT License** - see the [LICENSE](LICENSE)
file for details.

## 🙏 Credits

Architecture inspired by [X Unfollower](https://github.com/kysoog/x-unfollowers)
by [@KysooG](https://x.com/KysooG) - the MV3 side-panel layout, X session token
reuse, and storage conventions all come from there.

---

<p align="center">
  <sub>If you find this useful, consider giving it a ⭐ on GitHub!</sub>
</p>
