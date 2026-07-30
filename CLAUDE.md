# CLAUDE.md

Guidance for Claude Code (and any AI agent / new contributor) working in this repo.

## What this project is

**Scaler++** — a Manifest V3 Chrome extension that enhances `scaler.com`: lecture downloader + AI
transcription/summary, companion-mode bypass, live-stream DVR, Google Calendar sync, dark mode /
themes, LeetCode links on assignments, assignment export, spotlight search, vim mode, and DOM
decluttering.

Published on the Chrome Web Store. Current version lives in `extension-main/manifest.json`.

## Build & run

There is **no build step and no bundler**. Source files run directly in Chrome.

```bash
# Load extension: chrome://extensions -> Developer mode -> Load unpacked -> select extension-main/
# Tests:
cd tests
npm install     # one-time, installs jsdom
npm test        # node:test runner, --test-force-exit
npm run test:watch
```

Requires Node 18+ for tests. `tests/` is the **only** place a `package.json` exists — never add
dependencies to `extension-main/`; ship vendored files in `extension-main/libs/` instead.

Reload rules after editing:

- content script / popup change: refresh the extension card, then reload the Scaler tab
- background service worker change: refresh the extension card
- `manifest.json` change: refresh the extension card (Chrome only re-reads it on reload)

## Repo layout

```
extension-main/            the actual extension — everything shipped lives here
  manifest.json            MV3 manifest; version, permissions, content_scripts, web_accessible_resources
  popup.html/.css/.js      settings UI; DEFAULT_SETTINGS declared in popup.js
  background/              service worker: background.js + companionBypass, leetcodeLink,
                           videoTracker, calendarSync, messagesProxy, summaryProxy
  content/
    content.js             entry point + chrome.runtime.onMessage handler (toggle routing)
    core/                  settings.js, styleInjector.js, themePreload.js, urlObserver.js
    cleaner/               selectors.js (DEFAULT_SETTINGS + selector map), cleanerEngine.js,
                           modalHandler.js, sidebarHandler.js
    features/              one file or one folder per feature
    utils/                 domUtils.js, stringUtils.js, assignmentParser.js
  libs/                    vendored third-party (jszip, agora-sdk) — no CDNs allowed in MV3
  assets/ fonts/ icons/
tests/                     node:test + jsdom unit tests, one file per module
docs/                      per-feature docs (assignment-export.md, reviewer-guide.md)
addons/                    reference HTML/CSS snapshots of Scaler pages — not shipped
README.md CONTRIBUTING.md Feature-details.md
```

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributor workflow and
[tests/README.md](tests/README.md) for how the jsdom harness works.

## Architecture notes

- Content scripts are **plain browser scripts, not ES modules**. No `import`/`export`, no
  `module.exports`. Load order is whatever `manifest.json` lists — a script may only call functions
  from scripts registered before it.
- Three content-script blocks are registered: two at `document_start` (theme preload, early hooks)
  and one at `document_idle` with ~36 files. New feature file ⇒ add it to the right block in
  `manifest.json`, in the right position.
- Cross-script sharing happens through globals (`currentSettings`, `DEFAULT_SETTINGS`,
  `window._someObserver`) and IIFEs that attach `window.initX`.
- Scaler is a SPA. Navigation does not reload the page — `core/urlObserver.js` patches
  `history.pushState`/`replaceState` and re-runs feature init on URL change. Every feature must be
  idempotent on re-init.
- Settings live in `chrome.storage.sync` under the key `cleanerSettings`. `DEFAULT_SETTINGS` is
  duplicated in `popup.js` and `content/cleaner/selectors.js` — **update both** or the toggle silently
  no-ops.
- Toggling from the popup sends `settingsUpdated` / `toggleSetting` messages handled in `content.js`.
  A toggle must work **both ways**: turning a feature off has to tear down what turning it on built.
- Page-context work (Monaco editor, Agora SDK) goes through a bridge script listed in
  `web_accessible_resources` that talks back via `CustomEvent`. Don't try to reach page globals
  directly from an isolated content script.
- Always guard `chrome.*` calls with the `isExtensionValid()` pattern in `core/settings.js`; a
  reloaded extension throws "context invalidated" in still-open tabs.

## Writing code here

- **Match the surrounding style.** Banner comments (`// ==== core/settings.js ====`), JSDoc on
  exported-ish functions, 2-space indent, double quotes, `camelCase` functions,
  `SCREAMING_SNAKE_CASE` constants, `kebab-case` setting keys.
- One feature per file/folder in `content/features/`. Shared logic goes to `content/utils/` — do not
  copy-paste a parser between features (see how `assignmentParser.js` was extracted out of
  `leetcodeLink.js`).
- Keep modules single-responsibility and side-effect-free at load time; do work in `initX()`.
- Popup UI must match the existing dark-theme styling in `popup.css`.
- No external CDNs, no new runtime dependencies, no minified blobs you can't explain.
- Add a permission or host permission only if genuinely required — every new one lengthens Google's
  review and gets questioned.

## Memory leaks & performance — non-negotiable

This extension lives inside a long-lived SPA tab. A leak here compounds all day. Before you open a PR:

- Every `MutationObserver` you create must be `disconnect()`ed on teardown and before re-creating on
  URL change. Store it (`window._myFeatureObserver`) so `content.js` can kill it. Never observe
  `document.body` with `subtree: true` when a narrower root works.
- Every `setInterval` must have a `clearInterval` and a bounded retry count — no infinite
  "wait for element" polling. Prefer an observer or a `Promise.race` with a timeout.
- Every `addEventListener` on `window`/`document` needs a matching `removeEventListener`, or use
  `{ once: true }` / an `AbortController` signal.
- Wrap async page/iframe work in `try...finally`, use a concurrency lock flag, and cap it with
  `Promise.race([work, timeout])` so a hung Scaler response can't pin resources
  (`assignmentExport/exporter.js` is the reference implementation).
- Remove injected DOM nodes and revoke `URL.createObjectURL` blobs when a feature is disabled.
- Keep the hot path cheap: cache DOM lookups, debounce observer callbacks, avoid layout thrash, don't
  re-parse the same document twice. Cache network results (the LeetCode matcher caches by normalized
  title).
- Verify: leave a Scaler tab open with your feature on, navigate around the SPA for a few minutes,
  then check Chrome DevTools Memory (heap snapshot comparison, detached nodes) and Performance for
  runaway listeners/timers. Also inspect the service worker console for errors.

## Tests

- Add or update a test in `tests/` for any logic you can test headlessly (parsers, matchers, markdown
  generation, theme math, string/DOM utils). Name it `<module>.test.js`.
- The harness (`tests/helpers/harness.js`) `eval`s a content script inside a fresh jsdom window with
  mocked `chrome.*` and `fetch`. Two gotchas: rebase jsdom objects (`Array.from(x)`, `{ ...x }`)
  before `deepStrictEqual`, and expect leaked timers/observers — hence `--test-force-exit`.
- `npm test` in `tests/` must pass before you push.

## Docs — update them, always

A change is not done until the docs match it:

- **README.md** — add/adjust the feature section (with the emoji heading style) for any user-visible
  feature or behavior change.
- **docs/`<feature>`.md** — add one for any non-trivial feature; document architecture, data flow,
  and intentional limitations. `docs/assignment-export.md` is the template.
- **CONTRIBUTING.md** — update if you change the project structure, workflow, or guidelines.
- **CLAUDE.md** (this file) — update if you change architecture, conventions, or commands.
- **Feature-details.md** and popup copy — keep in sync with what actually ships.
- Bump `version` in `extension-main/manifest.json` for a release-worthy change.

## Git & PR workflow

Branch off `main`: `feature/<name>`, `fix/<name>`, `docs/<name>`. Never commit to `main` directly.

Conventional commits: `feat:`, `fix:`, `docs:`, `style:`, `refactor:`, `chore:`. Subject in
imperative mood, one logical change per commit.

### What makes a good PR here

1. **Scoped.** One feature or one fix. No drive-by reformatting, no unrelated renames — they make the
   diff unreviewable.
2. **Description answers what / why / how tested.** Include screenshots or a GIF for any UI change,
   and the exact steps you followed on `scaler.com`.
3. **Docs + tests included in the same PR** (see the two sections above). A feature PR with no README
   change gets bounced.
4. **Structure respected.** New feature under `content/features/`, shared helper under
   `content/utils/`, registered in `manifest.json`, toggle wired through `popup.js` +
   `content.js` + both `DEFAULT_SETTINGS` copies.
5. **Leak & perf statement.** Say explicitly which observers/intervals/listeners you added and where
   they are torn down, plus what you saw in DevTools. Reviewers check this first.
6. **Toggle-off verified.** Feature disables cleanly, and existing features still work (theme,
   downloads, LeetCode links, spotlight, cleaner toggles).
7. **Console clean.** No errors or leftover `console.log` in the page console or the service worker
   console; no `debugger`, no commented-out dead code.
8. **Permissions justified.** If `manifest.json` gained a permission, explain why in the PR body.
9. **Reviewer guide for large PRs.** For a multi-file feature, add a `docs/`-style reviewer guide
   listing suggested review order, files added/modified, what was deliberately *not* changed,
   backward-compatibility notes, and a risk assessment — model it on
   [docs/reviewer-guide.md](docs/reviewer-guide.md).
10. **Rebase on latest `main`** and keep the branch conflict-free; push follow-up commits to the same
    branch when addressing review feedback.

Note: after merge, a Chrome Web Store update takes **7–15 days** (Google review). Test unpacked in
the meantime.

## Do not

- Add a build step, bundler, framework, or npm dependency to `extension-main/`.
- Reverse-engineer or hammer Scaler's private backend APIs; reuse the SPA/DOM (that is why the export
  feature uses a sandboxed hidden iframe).
- Log or transmit user credentials, tokens, or personal data anywhere. API keys the user supplies
  (Deepgram, Groq, OpenAI, ElevenLabs) stay in `chrome.storage` and go only to that provider.
- Commit anything under `addons/` as if it were shipped code, or commit `tests/node_modules`.
- Edit `libs/` vendored files by hand — replace the whole file with a documented upstream version.
- Push, tag, or open a PR unless the user asked for it.
