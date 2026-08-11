# Spotlight Search

**Setting key:** `spotlight-search` (default `true`)
**Code:** [content/features/spotlightSearch.js](../extension-main/content/features/spotlightSearch.js)
Header button injected by [cleaner/cleanerEngine.js](../extension-main/content/cleaner/cleanerEngine.js)
(`appendSpotlightButton`)
**Shortcut:** `Alt + /` (Option + / on Mac) · `Esc` to close

## What it does

A macOS-Spotlight-style overlay for searching Scaler: classrooms, problems and events in one
list, with keyboard navigation and grouped sections. Results open in a new tab.

## Structure

The whole feature is one IIFE with module-level state: `spotlightOpen`, `selectedIndex`,
`allResults` (array of `{ el, url }`), `searchDebounceTimer`, `searchAbortController`.

Public surface exposed on `window`:

- `initSpotlightSearch()` — injects the stylesheet; the keyboard listener is already registered at
  module load, so init is idempotent and cheap.
- `closeSpotlight()` — used by `content.js` when the setting is toggled off while the panel is
  open.

## Opening

Two entry points, both checking `currentSettings["spotlight-search"] !== false`:

- **Keyboard** — a capture-phase `keydown` listener on `window` matching
  `e.altKey && !e.metaKey && e.code === "Slash"`. It `preventDefault` +
  `stopPropagation` + `stopImmediatePropagation` so Scaler never sees the key, and toggles the
  overlay. `Escape` closes when open.
- **Header button** — `#scaler-spotlight-header-btn` dispatches the
  `scaler-spotlight-open` `CustomEvent`, which this module listens for.

`buildSpotlightDOM()` creates `#scaler-spotlight-overlay` (fixed, `z-index: 2147483647`, blurred
backdrop) containing the input header, the results body, and a footer with `↑ ↓ / ↵ / Esc` hints.
Backdrop `mousedown` (only when `e.target === overlay`) closes. The input is focused after 50 ms.

## Searching

- `input` → cancel any in-flight fetch, clear the debounce timer, reset selection, then
  `setTimeout(doSearch, 300)`. Queries shorter than 2 characters do nothing; an empty query clears
  the list.
- `doSearch(query)` — `GET https://www.scaler.com/academy/mentee/search-with-query?q=…` with
  `credentials: "include"`, `Accept: application/json`, `X-Requested-With: XMLHttpRequest`, and a
  fresh `AbortController` signal.
- `AbortError` is swallowed (expected while typing). Any other failure shows
  *"Could not reach Scaler. Are you logged in?"*.

## Rendering

The response is read as `{ classroom: [], problems: [], events: [] }` and rendered into three
labelled sections via one `DocumentFragment`. Each item becomes an `<a class="spo-result-item">`
with:

- a gradient icon bubble per type (inline SVG: teacher+board, lightbulb+puzzle, calendar+check);
- title (HTML-escaped) and a subtitle built from `item_type` plus a formatted `en-IN` date;
- a badge where relevant — `✓ Solved` / `Active` for problems, `Upcoming` for a future event.

**URL resolution** (`resolveUrl`) is type-aware. Problems get a *reconstructed canonical* URL
rather than the API's slug URL:

```
/academy/mentee-dashboard/class/{sbat_id}/{homework|assignment}/problems/{id}
```

(`homework` when `item.event_type === "homework"`). Classrooms and events use the API's `url`,
prefixed with `https://www.scaler.com` when it is root-relative.

## Keyboard navigation

`ArrowDown` / `ArrowUp` move `selectedIndex` with wraparound, apply `.spo-selected` (which also
paints an orange left rail), and `scrollIntoView({ block: "nearest" })`. `Enter` opens the
selected result with `window.open(url, "_blank", "noopener,noreferrer")` and closes the overlay.
Mouse hover sets the selection using the index captured at creation time (not parsed from
`dataset`, to avoid a parse per hover event).

## Closing and cleanup

`closeSpotlight()`:

1. aborts the in-flight fetch and clears the debounce timer;
2. empties `allResults` and resets `selectedIndex` — this drops the element references so the GC
   can reclaim the removed DOM;
3. plays the fade-out animation and removes the overlay after 150 ms, re-checking
   `overlay.parentNode` to guard a double-close race.

Because the input listeners live on elements *inside* the overlay, removing the overlay removes
them; only the two `window` listeners are permanent, and they are registered exactly once at
module load.

## Theme interaction

The panel is designed dark. Under the global invert-based themes it would be flipped to light, so
[themeManager.js](../extension-main/content/features/themeManager.js) has an explicit
`#scaler-spotlight-overlay` counter rule, and the dark-region scan skips the overlay and its
subtree (a second counter would double-flip it). The overlay's `backdrop-filter: blur` is also
killed in dark mode — a backdrop filter samples the *pre-invert* page and would wash the panel
out.

## Limits

- Results depend entirely on Scaler's own search endpoint and an authenticated session.
- Every result opens in a new tab; there is no in-SPA navigation option.
- `Alt + /` is captured globally on scaler.com, including while typing in an editor.
