# DOM Cleaner (decluttering, modals, sidebar, header extras)

**Setting keys:** `2025-revisited`, `referral-stats`, `mess-fee`, `attendance`, `refer-earn`,
`scaler-coins`, `continue-watching`, `referral-banner`, `notebook-widget`, `referral-popup`,
`auto-close-modals`, `sst-goodies`, `refer-friends`, `sidebar-refer-banner`, `companion`,
`core-curriculum` (all default `true`)

**Code:**
[cleaner/selectors.js](../extension-main/content/cleaner/selectors.js) ·
[cleaner/cleanerEngine.js](../extension-main/content/cleaner/cleanerEngine.js) ·
[cleaner/modalHandler.js](../extension-main/content/cleaner/modalHandler.js) ·
[cleaner/sidebarHandler.js](../extension-main/content/cleaner/sidebarHandler.js) ·
[core/styleInjector.js](../extension-main/content/core/styleInjector.js)

## What it does

Hides the promotional and low-value chrome of the Scaler dashboard — referral banners, coin
counters, "Refer & Earn" nudges, the notebook widget, the SolveBot companion on assignments — and
auto-dismisses referral modals. It also injects a few small additions in the same pass (Core
Curriculum icon, Spotlight button, Mess-Fee "Mark as Filled" checkbox).

Hiding is done by class, never by removing nodes: React re-renders would just put them back and
a removed node cannot be restored when the user toggles the setting off.

## Data model

`selectors.js` declares four config arrays. Each entry is
`{ key, selector, verify(el) → boolean }`:

| Array | Scope |
|---|---|
| `TODOS_PAGE_SELECTORS` | `/academy/mentee-dashboard/todos` only |
| `GLOBAL_SELECTORS` | every scaler.com page (header items, referral popup + backdrop) |
| `SIDEBAR_SELECTORS` | the mentee sidebar |
| `ASSIGNMENT_SELECTORS` | assignment problem pages (the Companion / SolveBot widget) |

`verify` is a second gate on top of the CSS selector — Scaler's hashed class names
(`a._3l2QS_TrEOIiff69Oqtw-`) change between deploys, so each entry also checks the element's text
or a child (`textContent.includes("Mess Fee")`, an `img[alt="scaler coin"]`, …). A selector that
still matches but fails `verify` is left alone rather than hiding the wrong node.

Two constants drive the mechanism:

- `CLEANER_ATTR = "data-scaler-cleaner"` — stamped on a processed element with its setting key.
- `HIDDEN_CLASS = "scaler-cleaner-hidden"` — the only thing that actually hides, via
  `display: none !important` injected by `styleInjector.js`.

## Engine

`processElementsByConfig(configs)` — for each config, query, `verify`, stamp `CLEANER_ATTR`, then
add/remove `HIDDEN_CLASS` per `shouldHide(key)`.

`updateVisibilityForKey(key, hide)` — the fast path used by the popup toggle. It looks for
already-stamped `[data-scaler-cleaner="key"]` elements; if none exist yet (the page hadn't been
processed), it re-runs the matching configs to stamp them first, then flips the class. This is the
generic fallback branch in `content.js`'s toggle router.

`runCleanup()` is the orchestrator, called on load (+1 s, +2.5 s, +5 s) and after every SPA URL
change (+1.5 s, +3 s):

```
loadSettings()          // cached 5 s (SETTINGS_CACHE_TTL_MS)
injectStyles()          // once
cleanupGlobal()         // global selectors + referral popup + header icons + auto-close
cleanupTodosPage()      // todos selectors + mess-fee checkbox
cleanupSidebar()
cleanupAssignment()
setupSidebarObserver()
setupModalObserver()
handlePracticeMode()
```

## Referral modals

Two layers:

- **`hideReferralPopup()`** — hides `div.ug-referral-popup-modal` and its
  `.sr-backdrop.ug-referral-popup-modal__backdrop`.
- **`autoCloseReferralModals()`** (`auto-close-modals`) — actually *clicks* the close control.
  It targets the referral modal's `a.sr-modal__close-alt`, then sweeps all `div.sr-modal` nodes
  whose text mentions `Referral` / `Refer` / `NSET registration` and clicks whichever close
  control they expose. Clicking (rather than hiding) matters for modals that block scroll or
  re-open until dismissed.

`modalHandler.js` watches for them: a `MutationObserver` on `document.body`
(`childList` + `subtree`, **no** attribute watching) that only reacts when an added node is or
contains `.sr-modal` / `.sr-backdrop`. It then debounces 150 ms so the modal is fully rendered
before acting. Guarded by the `modalObserverSetup` flag so it is installed once.

## Sidebar

The sidebar mounts late and its contents are re-rendered when it opens.
`setupSidebarObserver()` waits for `.ug-sidebar.sidebar.mentee-sidebar`, retrying every second up
to **10 times** then giving up. Once found it observes only `attributes: ["class"]` on that one
container, and when `sidebar__open` appears it runs `cleanupSidebar()` at +100 ms and +500 ms.
If the sidebar is already open at install time, it cleans immediately.

## Header extras (injected, not hidden)

`addCoreCurriculumIconLink()` finds the header container `.e7ge61UPj54Me37pqU2Rd`, falling back
after 2 s to a hard-coded XPath, then appends:

- **`appendCurriculumIcon()`** — a pill anchor to
  `/academy/mentee-dashboard/core-curriculum/m/`, stamped with `CLEANER_ATTR = "core-curriculum"`.
  This key is an *enhancement*: `handleCoreCurriculumVisibility()` inverts the usual meaning —
  `shouldHide("core-curriculum") === true` means **show** the icon.
- **`appendSpotlightButton()`** — the "Search anything" pill (`#scaler-spotlight-header-btn`).
  Clicking calls `window.initSpotlightSearch()` and dispatches the `scaler-spotlight-open`
  event that [spotlight-search.md](spotlight-search.md) listens for.

Both guard on an existing child, so repeated `runCleanup()` calls don't duplicate them.

## Mess-Fee card

`injectMessFeeCheckbox()` is the most stateful part of the cleaner.

- If `mess-fee` hiding is **off**: unhide the card, remove any previously injected checkbox
  container, clear the `data-mess-fee-injected` guard, return.
- **Visibility gate** — the card is only useful while Scaler's own Typeform button exists. Since
  browsers break nested anchors out of the parent `<a>`, the lookup for `a[href*="typeform"]`
  runs on `card.parentElement`. No button → hide the card and stop.
- **Filled state** — `currentSettings["mess-fee-filled-timestamp"]`. Within **12 days** of that
  timestamp the card stays hidden (re-applied every pass so it survives React re-renders); past
  12 days the timestamp is deleted and the card returns.
- **Checkbox** — an absolutely positioned "Mark as Filled [Scaler++]" control appended to the
  card (which is given `position: relative`). Its `change` handler writes/clears the timestamp in
  `chrome.storage.sync` and hides the card after 400 ms. Click events are stopped with
  `preventDefault` + `stopPropagation` + `stopImmediatePropagation` on both the container and the
  input, because the card itself is a link.

## Toggling

Most keys fall through to `updateVisibilityForKey()`. `content.js` has special branches for
`core-curriculum` (inverted meaning), `referral-popup` (re-show removes `HIDDEN_CLASS` from
stamped nodes), and `auto-close-modals` (turning on triggers an immediate sweep).

## Leak notes

- Two observers total: modal (body, childList+subtree, debounced 150 ms) and sidebar (one
  container, `class` attribute only). Both are guarded by module flags.
- The sidebar retry chain is bounded at 10 attempts; there is no unbounded polling.
- Nothing here uses `setInterval`.

## Limits

- Selectors are tied to Scaler's hashed class names. When a deploy changes them, the `verify`
  callback prevents mis-hiding but the element simply stops being hidden until the selector is
  updated.
- `autoCloseReferralModals()` matches modal text in English only.
- `restore` for the Mess-Fee card is best-effort: if the user toggles `mess-fee` off while the
  card is hidden by a fresh timestamp, the card reappears but the timestamp is kept.
