# Security Policy

## Overview

Reply Guy is a client-side Chrome extension. It has two outbound paths, and
they are strictly separated:

1. **X/Twitter** — to read the post you are replying to, using your existing
   logged-in session.
2. **Your chosen AI provider** — to generate the reply text, using the API key
   you supplied.

Nothing goes anywhere else.

## What This Extension Accesses

| Data | Purpose | Sent Externally? |
|---|---|---|
| `ct0` cookie (CSRF token) | Authenticate X API requests | **Only to x.com** |
| `twid` cookie (User ID) | Identify your session | **Only to x.com** |
| Session cookies | Make authenticated X requests | **Only to x.com** |
| The post you are replying to | Send to your AI provider as context | **Yes** — to your configured provider only |
| Your AI API key | Authenticate to your provider | **Only to your provider** |
| Draft history | Show the history panel | **No** — local `chrome.storage` only |

## What This Extension Does NOT Do

- Does NOT collect or transmit data to any third party beyond your chosen AI provider
- Does NOT store passwords or login credentials
- Does NOT modify your X session or cookies
- Does NOT inject ads or tracking scripts
- Does NOT use `eval()`, `Function()`, or any dynamic code execution
- Does NOT post, reply, like, or follow on your behalf — see "No automated posting" below

## No automated posting

The extension physically cannot post. Three independent safeguards:

1. There is no code path that calls X's create-post endpoint. No `CreateTweet`
   GraphQL mutation, no `POST /statuses/update.json`. The test suite asserts
   this and fails the build if either appears.
2. The reply button is never clicked programmatically. The test suite asserts
   this too.
3. The background worker refuses any insert request unless the target tab is on
   a `*/status/<id>` detail view — a hard gate in code, not a UI convention, so
   a UI bug cannot bypass it.

Inserting a draft writes into the reply box. You still press Post yourself.

## Where your API key lives

The key is stored in `chrome.storage.local`, unencrypted. That is the normal
ceiling for an unpacked extension — Chrome does not offer a keystore to content
scripts. Practical implications:

- Anyone with access to your Chrome profile directory can read it.
- Treat it as a key you are willing to rotate.
- Use a provider key with a spending limit where the vendor supports it.
- To revoke: delete the key in the extension's Settings, then rotate it in the
  provider's dashboard.

## Base URL pinning

For the five named providers (DeepSeek, Kimi, GLM, Gemini, ChatGPT) the base URL
is read from the compiled-in registry, never from stored settings. A stale or
hand-edited `baseUrl` value cannot redirect your key to another host. Only the
`Custom` provider accepts a user-supplied base URL, which is the whole point of
that option.

## Reporting a vulnerability

Open a GitHub issue, or contact the author privately if the report is sensitive.
Please include reproduction steps and the version from `manifest.json`.
