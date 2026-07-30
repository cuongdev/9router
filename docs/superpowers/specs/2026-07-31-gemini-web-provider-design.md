# Gemini Web provider — design

Date: 2026-07-31
Status: approved for planning

## Overview

Add a new cookie-based provider, `gemini-web`, that proxies chat requests through
Google Gemini's web app (`gemini.google.com`) using a browser cookie pasted by the
user — no API key, no OAuth. This mirrors the existing `grok-web` and
`perplexity-web` providers in this repo: a dedicated executor that bypasses the
generic OpenAI-compatible request path and talks directly to the upstream's
internal (reverse-engineered) web protocol.

## Goals

- Let a user paste their Gemini web session cookie and route chat completions
  through `gemini.google.com` like any other 9router provider (same fallback,
  same OpenAI-compatible request/response shape).
- Support multiple internal Gemini web models (Flash / Thinking / Pro today),
  resolved per-account rather than hardcoded, since availability depends on the
  account's subscription tier.
- Fit entirely within existing conventions: `authType: "cookie"` UI (already
  generic), `BaseExecutor` contract, registry-driven `PROVIDERS` config. No
  changes to `chat.js`, `fetch.js`, `auth.js`, or the credential fallback loop.

## Non-goals (out of scope for this spec)

- Multi-account indexing within a single cookie (`/u/N/` account switching).
  Multiple Google accounts are handled the same way 9router already handles
  multi-account fallback for every other provider: the user adds one connection
  per account (one cookie paste per connection).
- Image generation, image/file upload, "Canvas", or Google Workspace tool
  integration ("Sources: Search/Gmail/Drive/Chat" seen in the model-list RPC
  response). Text-in/text-out chat only, matching the `grok-web` scope.
- True token-by-token streaming. Gemini's web protocol does not stream deltas;
  streaming is simulated client-side (see "Streaming" below).
- Proactive/background cookie or token rotation. If the pasted cookie expires,
  the user re-pastes it (same UX as `grok-web`'s `sso` cookie).
- Playwright/headless-browser automation. Rejected in favor of direct HTTP
  calls to the same protocol the real web app uses — matches this repo's
  existing web-cookie providers and adds no new dependency.

## Architecture

New files only; no changes to the core request pipeline.

- `open-sse/providers/registry/gemini-web.js` — registry entry (id, display,
  authType, transport, static model list used as the passthrough/default set).
- `open-sse/executors/gemini-web.js` — `GeminiWebExecutor extends BaseExecutor`,
  overriding `execute()` completely (own fetch/parse, no `buildUrl`/`buildHeaders`
  reuse), following the exact shape of `open-sse/executors/grok-web.js`.
- `open-sse/executors/index.js` — manual import + registration (same pattern as
  every other executor).
- `open-sse/providers/registry/index.js` — regenerated via
  `scripts/migrate-registry.mjs` (auto-generated file, not hand-edited).

Credentials continue to flow through the existing `authType: "cookie"` path:
the pasted cookie string is stored as `credentials.apiKey` (`AddApiKeyModal.js`
already renders a cookie-hint textarea for any `authType === "cookie"`
provider — no UI changes needed).

## Registry entry

```js
export default {
  id: "gemini-web",
  priority: 230,
  alias: "gemini-web",
  aliases: ["gw2"],
  uiAlias: "gw2",
  display: {
    name: "Gemini Web (Google Account)",
    icon: "auto_awesome",
    color: "#4285F4",
    textIcon: "GM",
    website: "https://gemini.google.com",
  },
  category: "webCookie",
  authType: "cookie",
  authHint: "Dán toàn bộ document.cookie từ gemini.google.com (F12 → Console → document.cookie)",
  transport: {
    baseUrl: "https://gemini.google.com/_/BardChatUi/data",
    format: "gemini-web",
    authType: "cookie",
  },
  models: [
    { id: "gemini-web-flash", name: "Gemini 3.6 Flash (Web)" },
    { id: "gemini-web-thinking", name: "Gemini 3.6 Thinking (Web)" },
    { id: "gemini-web-pro", name: "Gemini 3.1 Pro (Web)" },
  ],
  passthroughModels: true,
};
```

The three static models are a *default/fallback* list for the model picker UI.
The executor does not trust hardcoded mode numbers for routing (see "Model
resolution" below) — `passthroughModels: true` also lets a user type a raw
model id if Google's offering changes before the registry list is updated.

## Cookie handling

- User pastes the full `document.cookie` string from an authenticated
  `gemini.google.com` tab. It is forwarded **verbatim** as the `Cookie` header
  on every upstream request — the executor does not parse or validate
  individual cookie names (`__Secure-1PSID`, `__Secure-1PSIDTS`, etc.). This is
  intentionally a superset of the two cookies documented by reference
  implementations, since the full jar is at least as valid as any subset.
- No sensitive cookie values are stored in this spec, in code comments, or in
  test fixtures — tests use synthetic placeholder cookie strings.

## Session bootstrap (token + session id) and model resolution

Before the first chat request for a connection (or after the cache below
expires), the executor performs one bootstrap round-trip:

1. `GET https://gemini.google.com/app` with the `Cookie` header.
   - If the final response URL contains `accounts.google.com`, or the HTML has
     no `SNlM0e` value, treat the cookie as invalid/expired (see "Errors").
   - Scrape from the HTML: `SNlM0e` (anti-CSRF token, used as the `at` request
     param), `cfb2h` (build label, used as the `bl` request param, with a
     hardcoded fallback constant if absent), and the batchexecute session id
     (`f.sid`; exact HTML key to confirm against a live account during
     implementation — this is an implementation verification step, not an
     open design question).
2. `POST https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b&...`
   (generic batchexecute endpoint, using the `bl`/`f.sid`/`at` values from
   step 1) with body `f.req=[[["otAQ7b","[]",null,"generic"]]]` — returns the
   account's available models as an array of
   `[hashId, shortName, description, ..., mode, ..., fullDisplayName]` entries
   (see captured example in the exploration notes; indices to pin down exactly
   during implementation against a live response).
3. Map the requested model (`gemini-web-flash` / `-thinking` / `-pro`, or a
   passthrough raw hash id) to the `mode` value found in step 2's response for
   that account. If the requested model isn't present in the account's list
   (e.g., no Pro subscription), fall back to the first/default entry and log a
   warning — never a hard failure purely for an unavailable model tier.

All three scraped/fetched values (`at`, `bl`, `f.sid`, and the resolved model
list) are cached in-memory per `connectionId` in a `Map` with a multi-hour TTL,
following the existing pattern in `open-sse/utils/kiroSessionReplay.js`. A
request only re-runs the bootstrap when the cache is empty/expired, or when a
chat request fails with an auth-shaped error (see "Errors").

## Sending a message

`POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=<bl>&hl=en&_reqid=<random>&rt=c`
(query params sourced from the bootstrap step; whether this endpoint also
needs `f.sid`/`source-path` like the generic `batchexecute` endpoint does is
an implementation-time verification item, not a design ambiguity).

Body: `f.req=<freeze-encoded payload>&at=<SNlM0e>`, where the freeze-encoded
payload is a sparse-array-of-80-slots structure (ported from the reference
`buildFreq` implementation) carrying the flattened prompt text at index 0 and
the resolved `mode` value at index 79 (thinking flag at index 17).

Multi-turn handling: stateless, matching `grok-web`. The full OpenAI message
history is flattened into a single text blob (role-prefixed lines, last user
message unprefixed) before each request — no Gemini-side conversation id is
tracked or replayed. The flattening helper is functionally identical to
`grok-web.js`'s `parseOpenAIMessages`; extract it into a small shared utility
(e.g. `open-sse/utils/flattenChatMessages.js`) since there are now two call
sites doing the same thing — this is a small, targeted dedup, not a new
abstraction layer.

## Response parsing

The response is newline-delimited; lines containing `"wrb.fr"` are candidate
frames. Each candidate line is `JSON.parse`d, its second-level payload string
`JSON.parse`d again, and the assistant text extracted from the nested chunk
array. Gemini re-sends the **cumulative full answer** on each frame (not an
incremental delta), so the executor keeps only the **last non-empty** extracted
text as the final answer.

Error signals to check, in order:
1. A `BardErrorInfo [<code>]` substring anywhere in the raw body → upstream
   error, regardless of HTTP status (Gemini can return 200 with an embedded
   error marker).
2. HTTP 401/403 → auth error (cookie invalid/expired).
3. HTTP 429 → rate limited.
4. No parsable frames / empty extracted text → treat as upstream error, not a
   silent empty response.

## Streaming

Gemini web never streams token-by-token; the full answer is available only
once parsing completes. For `stream: true` requests, the executor chunks the
final text (e.g., by word) into multiple `chat.completion.chunk` SSE events,
mirroring `buildStreamingResponse` in `grok-web.js`. For `stream: false`, a
single `chat.completion` response is returned directly.

## Error handling summary

| Condition | Behavior |
|---|---|
| No `SNlM0e` after bootstrap GET, or redirected to `accounts.google.com` | 401, "cookie hết hạn hoặc không hợp lệ, vui lòng dán lại" |
| Bootstrap succeeds but token missing from HTML (edge case seen in public trackers) | Proceed with request anyway (empty `at`); only fail if the subsequent chat request itself then 401s |
| `BardErrorInfo` in a 200 response body | Upstream error, message includes the code |
| HTTP 401/403 from chat/model-list RPCs | Invalidate the connection's cached bootstrap values, retry bootstrap once, then fail with the same "re-paste cookie" message if it still fails |
| HTTP 429 | Standard `markAccountUnavailable` fallback path (same as every other executor — no special-casing needed) |
| Requested model not in account's `otAQ7b` list | Fall back to account's default model, log a warning; not an error |

## Testing

New `tests/unit/gemini-web.test.js`, mirroring `tests/unit/perplexity-web.test.js`:

- Export pure helpers from the executor (`buildFreq`, `extractText`,
  `flattenChatMessages` re-export, the model-resolution mapper) for direct
  unit testing without mocking `fetch`.
- Mock `global.fetch` for the two bootstrap calls (HTML scrape GET, `otAQ7b`
  POST) plus the `StreamGenerate` POST; assert:
  - cookie is forwarded verbatim as `Cookie` header;
  - bootstrap values are cached — a second chat call within the TTL does not
    re-issue the scrape/`otAQ7b` calls;
  - `extractText` returns the last non-empty frame, not the first;
  - `BardErrorInfo` and HTTP 401/403/429 map to the expected error shapes;
  - an unavailable requested model falls back to the account's default
    instead of erroring.
- No live/real-account test tier for this provider (matches the project's
  existing convention of skipping `*.real.test.js`-style live calls without
  credentials) — all fixtures are synthetic/captured-and-redacted.

## Risks

- **Protocol drift**: this is a reverse-engineered, undocumented protocol.
  Google can change field indices, RPC ids, or HTML token markers without
  notice (a public tracker already shows `SNlM0e` intermittently missing from
  page HTML). Mitigated by: clear, distinct error/log tags for parse failures
  vs. auth failures, so drift is diagnosable quickly; no CI dependency on a
  live account.
- **Cookie sensitivity**: the pasted cookie is a live Google session credential.
  Handled the same way `grok-web`'s `sso` cookie already is (stored as
  `credentials.apiKey`, never logged in full — only masked via the existing
  `log.maskKey` helper).
