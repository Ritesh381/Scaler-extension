# Problem Search Bar

**Setting key:** `problem-search` (default `true`)
**Code:** [content/features/problemSearch.js](../extension-main/content/features/problemSearch.js)
**Page:** `/academy/mentee-dashboard/problems`

## What it does

Adds a client-side filter bar above the problems table. Typing filters rows live by name, day,
type (Code/Objective) and topic, highlights the matched substrings, and shows an
`N of M problems` count. Press `/` anywhere on the page to focus it.

Everything is local DOM filtering — no API calls, no pagination requests.

## Injection

`initProblemsSearch(retries = 0)`:

1. Not the problems page → `removeSearchBar()` and stop (covers SPA navigation away).
2. `shouldHide("problem-search")` false → `removeSearchBar()` and stop.
3. `injectSearchBar()` — injects the stylesheet once (`#scaler-search-styles`), builds the
   container `#scaler-problem-search`, and inserts it **after** `.problem-tabs.problem-tabs__right-padding`.
4. If the anchor wasn't there yet, retry every second, **capped at 8 attempts**, then give up.

Duplicate protection is twofold: an `#scaler-problem-search` existence check *and* the
`searchBarInjected` module flag (which `content.js` resets on every URL change).

The bar contains: a search icon, the input, a clear (✕) button, the result count, and a
`Press / to focus` hint. A separate fixed-position `#scaler-search-mode` toast is appended to
`document.body`.

## Search mode

Focusing the input calls `activateSearchMode()`, which shows the toast and — importantly —
**clicks the "All Problems" tab** (`.problem-tabs-navigation__header:first-child`) if it isn't
already active. Without that, filtering would only search the currently loaded tab's subset.

Blur with an empty query, or Escape, deactivates it and clears the count.

## Filtering (`filterProblems`)

For each `.problems-list__table .column` row:

- The problem name's original text is cached once in `nameEl.dataset.originalText` — needed
  because highlighting rewrites `innerHTML`.
- Searchable text = name + `.problem__item--days` + `.problem__item--judge` (type) +
  `.problem__item--topic`, lowercased.
- The query is split on whitespace; a row matches when **every** term is a substring
  (AND semantics).
- Match → remove `.scaler-search-hidden`, and rebuild the name with each term wrapped in
  `<span class="scaler-highlight">` using a `RegExp` built from `escapeRegex(term)`
  (from `utils/stringUtils.js`).
- No match → add `.scaler-search-hidden` (`display: none !important`) and restore the original
  name text.

An empty query restores every row and clears the count.

## The `/` shortcut

Registered **once at module load**, outside `setupSearchListeners()`, deliberately: the search bar
is destroyed and re-created on navigation, and re-registering per injection would stack duplicate
listeners on `document`. The handler ignores keypresses while focus is in an `INPUT`/`TEXTAREA`
and only acts on the problems page.

## Teardown

`removeSearchBar()` removes the container and the mode toast, resets `searchBarInjected` /
`isSearchActive`, and un-hides every `.scaler-search-hidden` row. It runs when the feature is
toggled off (`content.js`, key `problem-search`) and whenever navigation leaves the problems page.

## Limits

- Filtering only sees rows currently in the DOM. If Scaler virtualises or paginates the table,
  off-screen problems are invisible to the filter — hence the forced switch to "All Problems".
- The injected styles are light-mode colours; on a dark theme they are recoloured by the global
  theme filter like any other page element.
- Highlighting rewrites `innerHTML` of the name anchor. Any rich markup Scaler puts inside that
  anchor is flattened to its text while a query is active.
