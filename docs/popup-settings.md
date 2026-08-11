# Popup / Settings UI

**Code:** [popup.html](../extension-main/popup.html) · [popup.css](../extension-main/popup.css) ·
[popup.js](../extension-main/popup.js)

## What it does

The extension's settings panel. Every control applies **instantly** — there is no Save button.
A toggle writes to `chrome.storage.sync` and messages the active tab in the same handler.

## Data model

`popup.js` declares its own copy of `DEFAULT_SETTINGS`. The content-script copy lives in
[cleaner/selectors.js](../extension-main/content/cleaner/selectors.js). **Both must be updated
together** — a key present in only one silently no-ops.

`TOGGLE_MAP` maps every checkbox id → setting key (`"toggle-problem-search": "problem-search"`).
It is the single source of truth for wiring: `loadSettings()`, `resetSettings()` and the
`DOMContentLoaded` listener registration all iterate it.

`theme` is **not** in `TOGGLE_MAP` — it is a `<select>` (`#theme-select`) with its own
`handleThemeChange()`.

## Adding a setting

1. Add the key to `DEFAULT_SETTINGS` in **both** `popup.js` and `cleaner/selectors.js`.
2. Add the toggle markup to `popup.html`, styled like its neighbours.
3. Add the id → key entry to `TOGGLE_MAP`.
4. Add a branch to the `toggleSetting` router in
   [content/content.js](../extension-main/content/content.js) that initialises the feature on and
   **tears it down** on off.

## Instant apply (`handleToggleChange`)

1. Refuse if the key is in `FORCE_DISABLED_FEATURES` (see below).
2. Update `currentSettings`.
3. Special cases:
   - `practice-mode` **on** → stamp `practice-mode-start = Date.now()` (drives the auto-expiry);
     **off** → clear it and delete every `reset_history_*` key from `chrome.storage.local`;
   - `calendar-sync` → send `CALENDAR_SYNC_TOGGLED` to the service worker so the 24 h alarm is
     created or cleared.
4. `_syncSubOptions()` shows/hides the companion panel for toggles that have one
   (`practice-mode` → `#practice-mode-options`, `calendar-sync` → `#calendar-sync-options`).
5. `chrome.storage.sync.set({ cleanerSettings })`.
6. `chrome.tabs.sendMessage(activeTab, { action: "toggleSetting", key, value })`, wrapped in
   try/catch — the active tab may not be a Scaler page.
7. Toast: enhancement keys say *Enabled/Disabled*, cleaner keys say *Hidden/Visible*.
8. On any error the toggle is **reverted** in both the UI and `currentSettings`, and an error toast
   is shown.

## Force-disabled features

```js
const FORCE_DISABLED_FEATURES = new Set(["live-stream-recorder"]);
```

`lockForceDisabledToggles()` sets the checkbox unchecked **and** `disabled`, and adds
`.toggle-item--locked` to the row. It is called at the end of `loadSettings()` and
`resetSettings()` so it always wins over stored state, and `handleToggleChange()` refuses the key
outright.

This must stay in sync with the feature's own kill switch — for the recorder,
`LIVE_STREAM_RECORDER_FORCE_DISABLED` in `liveStreamRecorder.js`. Re-shipping a feature means
removing it from **both**.

## Theme selector

`handleThemeChange(value)` writes `theme` and messages the tab with
`{ action: "toggleSetting", key: "theme", value }`. `themeManager.js` also listens to
`chrome.storage.onChanged`, so the theme applies even if the tab message is missed or the content
script loaded late.

## Reset

`resetSettings()` writes `DEFAULT_SETTINGS` wholesale, re-syncs every toggle and the theme select,
re-locks force-disabled toggles, and sends `{ action: "settingsUpdated", settings }` (the
full-object message, distinct from `toggleSetting`) so the content script re-applies everything at
once.

## Other controls

- **Sync Now** (`#syncCalendarBtn`) — disables itself, shows `Syncing…`, sends `SYNC_CALENDAR`,
  renders success/failure into `#syncStatus`, clears after 5 s. See
  [calendar-sync.md](calendar-sync.md).
- **Practice-mode days** (`#practice-mode-days`) — writes `practice-mode-days` and messages the
  tab.
- **Rate / Feedback / GitHub / developer links** — `chrome.tabs.create` to the Web Store listing,
  the feedback form, the repo, and the author's site.
- **Version** — read from `chrome.runtime.getManifest().version` into `#extension-version`, so it
  never drifts from the manifest.
- `showToast()` — one toast at a time (any existing one is removed), animated in via `rAF`, removed
  after 1.2 s.

## Conventions

- Popup UI must match the existing dark-theme styling in `popup.css`.
- Setting keys are `kebab-case`; toggle ids are `toggle-<key>`.
- The popup never manipulates the page directly — it only writes storage and sends messages.
