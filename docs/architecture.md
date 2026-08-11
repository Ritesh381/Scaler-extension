# Architecture — how Scaler++ functions

How the whole extension is wired: what loads when, how a feature gets its settings, how the
content scripts, the service worker and the page world talk to each other.

Read this before any per-feature doc. Every feature doc assumes the mechanics described here.

---

## 1. What kind of extension this is

- **Manifest V3**, no build step, no bundler, no npm dependencies inside `extension-main/`.
- Files are shipped exactly as written and are loaded by Chrome in the order `manifest.json`
  lists them.
- Content scripts are **plain classic scripts**, not ES modules. There is no `import`/`export`.
  Sharing happens through globals (`currentSettings`, `DEFAULT_SETTINGS`, `window.initX`,
  `window._someObserver`).
- Third-party code is vendored under `libs/` (`jszip.min.js`, `agora-sdk.js`) and
  `content/features/vimMode/libs/monaco-vim.js`. No CDN loads — MV3 forbids remote code.

## 2. The four execution contexts

| Context | Where the code runs | What it can touch |
|---|---|---|
| **Service worker** | `background/background.js` + its `importScripts()` modules | `chrome.*` APIs, cross-origin `fetch` (no page CSP, no CORS preflight problems), cookies of the browser profile |
| **Content script (ISOLATED world)** | everything under `content/` listed in `manifest.json` | the page DOM, `chrome.runtime`/`chrome.storage`; **not** page JS globals |
| **Page (MAIN world)** | bridge scripts in `web_accessible_resources`, plus `vimEditorCapture.js` (registered directly in the manifest with `"world": "MAIN"`) | page globals: `window.monaco`, `AgoraRTC`; **no** `chrome.*` |
| **Extension pages** | `popup.html`, `videoProcessor.html`, `transcriptProcessor.html` | full `chrome.*`, own CSP, own origin (`chrome-extension://`) |

Anything that needs a page global (Monaco's model text, the Agora client) must be done from a
MAIN-world bridge and returned to the isolated world by `CustomEvent` or `window.postMessage`.
Anything that needs a cross-origin request that the Scaler page CSP would block (LeetCode
GraphQL, Google search, the Scaler++ backend, a user's LLM endpoint) must be proxied through the
service worker.

## 3. Load order

`manifest.json` registers **three** content-script blocks:

1. `document_start`, ISOLATED — `content/core/themePreload.js`
   Re-applies the saved theme before first paint so there is no light→dark flash.
2. `document_start`, MAIN — `content/features/vimMode/vimEditorCapture.js`
   Wraps `monaco.editor.create` the instant `window.monaco` is defined, so Vim mode can find the
   real editor instance later.
3. `document_idle`, ISOLATED — ~36 files, in this order:
   `cleaner/selectors.js` (defines `DEFAULT_SETTINGS`) → `core/settings.js` → `core/styleInjector.js`
   → `utils/*` → features → `libs/jszip.min.js` → `assignmentExport/*` → `vimMode/vimMode.js`
   → `content/content.js` (last, because it calls into everything above).

A new feature file must be added to the right block **in the right position**: a script may only
call functions declared in a script registered before it.

## 4. Settings

- Single storage key: `chrome.storage.sync` → `cleanerSettings` (one flat object).
- `DEFAULT_SETTINGS` is declared **twice** — in `popup.js` and in `content/cleaner/selectors.js`.
  Both copies must be updated together or a new toggle silently no-ops.
- Semantics of a key differ by category:
  - **Cleaner keys** (`referral-stats`, `mess-fee`, …): `true` = *hide* that element.
  - **Enhancement keys** (`problem-search`, `leetcode-link`, …): `true` = *feature on*.
  - `theme` is a string id (`"off" | "dark" | "midnight" | "dracula" | "nord" | "sepia" | "solarized"`).
  - A few keys are state, not switches: `practice-mode-start`, `practice-mode-days`,
    `mess-fee-filled-timestamp`.
- Content scripts read settings through `loadSettings()` in [core/settings.js](../extension-main/content/core/settings.js),
  which merges storage over defaults into the global `currentSettings`. `shouldHide(key)` returns
  `currentSettings[key] !== false`, i.e. **default-on**.
- `runCleanup()` caches the settings read for 5 s (`SETTINGS_CACHE_TTL_MS`) so observer-driven
  calls don't hammer `chrome.storage.sync`.

Other storage in use:

| Store | Keys | Used by |
|---|---|---|
| `storage.sync` | `cleanerSettings`, `scaler_user`, `scaler_sync_version` | settings, profile cache |
| `storage.local` | `leetcode_cache_*`, `reset_history_*`, `dismissed_message_ids`, `scaler_summary_config` | LeetCode match cache, practice mode, custom messages, AI notes config (incl. the user's own API key) |
| page `localStorage` | `scalerpp_theme`, `scalerpp_theme_filter`, `scalerpp_theme_bg`, `scalerpp_dark_paths` | theme preload (must be readable at `document_start`, before `chrome.storage` resolves) |

## 5. Message routing

Popup → content script (`chrome.tabs.sendMessage`):

- `settingsUpdated` — full settings object, after a reset. Content re-applies everything.
- `toggleSetting` — `{ key, value }` for a single switch.

Both are handled by the single listener at the top of
[content/content.js](../extension-main/content/content.js). That listener is the **toggle router**:
per-key branches call the feature's `initX()` when turned on, and explicitly tear down
(disconnect observers, remove injected nodes, restore replaced markup) when turned off. Keys with
no branch fall through to `updateVisibilityForKey()`, the generic cleaner path.

Content script → service worker (`chrome.runtime.sendMessage`), by action/type:

| Message | Handler | Purpose |
|---|---|---|
| `searchLeetCodeProblem` | `background/leetcodeLink.js` | LeetCode match with confidence scoring |
| `M3U8_CAPTURED`, `GET_VIDEO_URL`, `INITIATE_DOWNLOAD` | `background/videoTracker.js` | stream capture + opening a processor tab |
| `fetchCustomMessages`, `syncUserProfile`, `pingUser`, `trackDownload`, `proxyButtonClick`, `checkTranscriptCache`, `saveTranscriptToCache` | `background/messagesProxy.js` | Scaler++ backend proxy |
| `checkSummaryCache`, `saveSummary`, `generateSummary` | `background/summaryProxy.js` | notes cache + user's LLM |
| `SYNC_CALENDAR`, `CALENDAR_SYNC_TOGGLED` | `background/calendarSync.js` | Google Calendar |
| `FETCH_PROXY` | `videoDownloader.js` (content-script listener) | CORS proxy for HLS chunks |

Page world ↔ isolated world:

| Feature | Channel |
|---|---|
| Assignment Export | `CustomEvent` `scaler-assignment-export-command` / `-event` |
| Live Stream Recorder | `CustomEvent` `scaler-stream-command` / `scaler-stream-event` |
| Vim mode | `window.postMessage` with `source: "scalerpp-vim*"` |

## 6. The SPA problem

Scaler is a single-page app: navigating does **not** reload the page, so a content script runs
once and must survive every route change itself.

[core/urlObserver.js](../extension-main/content/core/urlObserver.js) handles detection:

- patches `history.pushState` / `history.replaceState`,
- listens for `popstate`,
- plus a `MutationObserver` on `document.body` as a backstop for routers that change the URL
  without either,
- everything funnels into `handleUrlChange()`, debounced 300 ms, which re-runs `runCleanup()` at
  +1.5 s and +3 s (Scaler renders progressively, so one pass is not enough).

`content.js` then *wraps* `handleUrlChange` to also re-init the per-page features (problem search,
LeetCode link, join buttons, lecture/instructor/summary tabs, subject sort, contest leaderboard,
problem picker, Vim mode, assignment export).

**Consequence: every feature's `initX()` must be idempotent.** The standard patterns used in this
codebase are: an injection guard attribute (`data-*-injected`), an `#id` existence check, or a
module-level `_injected` flag reset by the teardown path.

## 7. Waiting for the DOM

Scaler renders asynchronously, so features must wait for their anchor element. Three approved
patterns, all bounded:

- **Bounded retry** — `initProblemsSearch(retries)` caps at 8 attempts, `assignmentExport` at 15,
  `sidebarHandler` at 10, `lectureSummary._scheduleTabRetries()` at 40 × 500 ms.
- **Debounced MutationObserver** on the narrowest useful root (`.mentee-dashboard__content`,
  `.me-cr-body`, `.classroom-contest`, …), stored on `window._xObserver` so `content.js` can
  disconnect it.
- **`Promise.race([work, timeout])`** for anything involving an iframe or the network
  (`assignmentExport/exporter.js` is the reference).

Unbounded polling is not allowed — see the memory-leak rules in [CLAUDE.md](../CLAUDE.md).

## 8. Extension-context invalidation

When the extension is reloaded or updated, already-open Scaler tabs keep running the *old*
content script, and every `chrome.*` call in it throws `"Extension context invalidated"`.
Every entry point guards with `isExtensionValid()` (`chrome.runtime?.id` present) and swallows
that specific error. Long-lived loops (`themeManager.flushPendingNodes`, `practiceMode`) check it
each tick and tear themselves down.

## 9. Feature map

| Area | Content script | Background half | Doc |
|---|---|---|---|
| DOM decluttering, mess-fee card, header icons | `cleaner/*` | — | [dom-cleaner.md](dom-cleaner.md) |
| Companion-mode bypass | — | `companionBypass.js` | [companion-bypass.md](companion-bypass.md) |
| Google Calendar sync | — (popup only) | `calendarSync.js` | [calendar-sync.md](calendar-sync.md) |
| LeetCode links | `features/leetcodeLink.js` | `leetcodeLink.js` + `utils/stringUtils.js` | [leetcode-link.md](leetcode-link.md) |
| Problem search bar | `features/problemSearch.js` | — | [problem-search.md](problem-search.md) |
| Practice mode | `features/practiceMode.js` | — | [practice-mode.md](practice-mode.md) |
| Pick Random problem | `features/problemPicker.js` | — | [problem-picker.md](problem-picker.md) |
| Join Session button | `features/joinClassButton.js` | — | [join-session-button.md](join-session-button.md) |
| Subject sort | `features/subjectSort.js` | — | [subject-sort.md](subject-sort.md) |
| Contest leaderboard | `features/contestLeaderboard.js` | — | [contest-leaderboard.md](contest-leaderboard.md) |
| Spotlight search | `features/spotlightSearch.js` | — | [spotlight-search.md](spotlight-search.md) |
| Themes / dark mode | `features/themeManager.js`, `core/themePreload.js` | — | [theme-manager.md](theme-manager.md) |
| Recording download (video/audio) | `features/videoDownloader/*` | `videoTracker.js` | [video-downloader.md](video-downloader.md) |
| Transcription | `videoDownloader/transcriptProcessor.*`, `customAudioTranscriber.js` | `messagesProxy.js` | [lecture-transcript.md](lecture-transcript.md) |
| AI lecture notes | `features/lectureSummary.js` | `summaryProxy.js` | [lecture-summary.md](lecture-summary.md) |
| Dashboard lecture tags | `features/lectureInfo.js` | — | [lecture-info.md](lecture-info.md) |
| Instructor tags + tab | `features/instructorInfo.js` | — | [instructor-info.md](instructor-info.md) |
| Live-stream DVR (shipped OFF) | `features/liveStreamRecorder/*` | — | [live-stream-recorder.md](live-stream-recorder.md) |
| Vim mode | `features/vimMode/*` | — | [vim-mode.md](vim-mode.md) |
| Assignment export | `features/assignmentExport/*` | — | [assignment-export.md](assignment-export.md) |
| In-header announcements | `features/customMessage.js` | `messagesProxy.js` | [custom-messages.md](custom-messages.md) |
| Profile sync / usage counters | `features/usernameTracker.js` | `messagesProxy.js` | [user-profile-sync.md](user-profile-sync.md) |
| Settings UI | `popup.*` | — | [popup-settings.md](popup-settings.md) |

## 10. Permissions and why each exists

| Permission | Needed by |
|---|---|
| `storage` | settings + all caches |
| `declarativeNetRequest` | companion bypass request-header rules |
| `webRequest` | legacy of the stream capture path (capture itself now uses `PerformanceObserver`) |
| `identity` | Google OAuth for Calendar sync |
| `alarms` | the 24 h calendar sync alarm |
| host `leetcode.com`, `google.com` | LeetCode GraphQL + Google fallback search (service worker) |
| host `scaler.com` | content scripts + Scaler API reads |
| host `googleapis.com/calendar` | Calendar writes |
| host `scalerbackend.vercel.app` | transcript/summary cache, messages, usage counters |

## 11. Third-party / backend surface

- **Scaler's own endpoints** are reused through the logged-in session cookie
  (`/academy/mentee/events/`, `/api/v2/classroom/{id}/meta`, `/academy/mentee/problems-data`,
  `/academy/mentee/search-with-query`, …). No credentials are handled by the extension.
- **`scalerbackend.vercel.app`** stores the shared transcript/summary cache, the announcement
  messages, and anonymous-ish usage counters keyed by the user's Scaler email.
- **User-supplied API keys** (Deepgram / Groq / OpenAI / ElevenLabs / any OpenAI-compatible LLM)
  live in `chrome.storage.local` and are sent only to the provider the user configured.

## 12. Tests

`tests/` (the only place with a `package.json`) runs `node:test` + jsdom. The harness
`eval`s a content script inside a fresh jsdom window with mocked `chrome.*` and `fetch`, so pure
logic (parsers, matchers, markdown, theme math) is testable headlessly. `--test-force-exit` is
used because features intentionally leave timers/observers behind in the fake window.
