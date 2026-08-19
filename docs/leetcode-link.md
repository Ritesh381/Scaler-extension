# LeetCode Link on Assignment Problems

**Setting key:** `leetcode-link` (default `true`)
**Code:** [content/features/leetcodeLink.js](../extension-main/content/features/leetcodeLink.js)
(page side), [background/leetcodeLink.js](../extension-main/background/leetcodeLink.js) (search +
scoring), [content/utils/stringUtils.js](../extension-main/content/utils/stringUtils.js) (matching
maths, shared by both), [content/utils/assignmentParser.js](../extension-main/content/utils/assignmentParser.js)
(DOM extraction)

## What it does

On a Scaler coding-assignment problem page, injects a small LeetCode badge next to the problem
title linking to the equivalent LeetCode problem — but only when the match is confident enough.

## Why the work is split across contexts

The LeetCode GraphQL API and the Google fallback search cannot be fetched from a content script
(page CSP / CORS). They can from the service worker. So:

- **content script** decides *whether the page qualifies*, extracts the title + statement, manages
  the cache, and injects the DOM;
- **service worker** does the network search and returns a scored result;
- **`stringUtils.js`** is loaded by *both* (in the worker via `importScripts`, where it exports
  onto `globalThis`) so the two halves score identically.

## Page-side flow (`initLeetCodeLink`)

1. `isAssignmentProblemPage()` — path contains `/assignment/problems/` or `/homework/problems`
   **and** matches `/problems/\d+`.
2. Setting check via `shouldHide("leetcode-link")`. If off, remove any existing
   `.scaler-leetcode-link` and return.
3. Bail if a link is already injected (prevents a duplicate search on SPA re-init).
4. Wait 1.5 s for the SPA to render.
5. **Coding-problem gate** — `isLikelyCodingProblem()` requires a *positive* signal:
   a known editor root (`.monaco-editor`, `.ace_editor`, `.CodeMirror`, `.cm-editor`, `[class*=code-editor]`, …)
   **or** an action button whose text is exactly `run` / `run code` / `compile` / `run & submit`
   (MCQ pages only have *Submit*). Anything else → no link. Erring toward "no" keeps the icon off
   MCQ/theory questions in OS, DBMS, etc.
6. `extractProblemTitle()` + `extractProblemStatement()` from the shared parser.
7. `searchLeetCodeProblem(title, statement)` → cache, else the service worker.
8. If `found`, `injectLeetCodeLink(url)` appends an anchor into `.cr-p-heading__text` containing
   the bundled `icons/leetcode_icon.png` and an external-link SVG, with hover styling.

## Cache

Key: `leetcode_cache_${normalizeTitleForCache(title)}` in `chrome.storage.local`
(title lowercased, non-alphanumerics stripped).

- **Positive** results cached **30 days**.
- **Negative** ("no confident match") cached **7 days** — shorter, so a problem later added to
  LeetCode can be picked up and a real match isn't suppressed forever.
- Expired entries are removed on read.

Caching negatives is what stops every visit to a non-DSA problem from re-running two network
searches.

## Background search (`handleSearch`)

1. **LeetCode GraphQL** (`problemsetQuestionList` with `filters.searchKeywords`), up to
   `MAX_CANDIDATES = 5` results. Candidates are pre-ranked by `titleMatchScore` so the most
   promising bodies are fetched first.
2. **Google fallback** — `https://www.google.com/search?q=<title> site:leetcode.com/problems`,
   regex-collecting **all** slugs on the page (up to 5), not just the first.
3. Either way, `rankCandidates()` de-dupes by slug, fetches at most `MAX_CONTENT_FETCHES = 3`
   problem bodies (`questionData` GraphQL: `title`, `titleSlug`, `content`), scores each, keeps
   the best, and early-exits at confidence ≥ 0.85.
4. Returns `{ found: true, url, title, confidence }` only if the best confidence clears
   `ACCEPT_THRESHOLD = 0.6`; otherwise `{ found: false }`.

## Confidence scoring (`stringUtils.js`)

`tokenize()` lowercases, strips punctuation, and drops stop words that are generic in problem
titles (`implement`, `find`, `maximum`, `longest`, `problem`, `the`, …).

- **`titleMatchScore(a, b)` → 0..1** — 1 for an exact tight match (`normalizeTight`: lowercase,
  alphanumerics only). Otherwise a Jaccard score over tokens with exact **or** ≥3-char prefix
  matching (so `Power`/`Pow`, `Subsequence`/`Subseq` count). `"Two Sum"` vs `"Two Sum II"`
  scores ≈ 0.67 — deliberately *not* a confident match.
- **`statementSimilarity(a, b)` → 0..1** — token-set **containment** (intersection ÷ smaller set),
  not Jaccard, after `stripHtml()`. Containment keeps a correct match scoring high even when
  Scaler's page text is much longer/noisier than LeetCode's.
- **`computeMatchConfidence({...})`** combines them:
  - no LeetCode content available (premium problem): `exactTitle ? 0.8 : titleScore * 0.7`;
  - otherwise `0.5 * titleScore + 0.5 * stmtScore`;
  - exact title **and** `stmtScore ≥ 0.25` → floor of `0.85`;
  - exact title **but** `stmtScore < 0.12` → capped at `0.3` — almost certainly a Scaler custom
    variation reusing a LeetCode heading, suppressed hard.

This two-signal design exists because the earlier title-only heuristic linked wrong problems for
(a) non-DSA questions sharing a heading and (b) Scaler variations of a LeetCode title.

## Toggling off

`content.js` handles key `leetcode-link`: on → `initLeetCodeLink()`; off → remove
`.scaler-leetcode-link`. No observers or timers are owned by this feature.

## Limits

- Google's HTML is scraped with a regex; a markup change degrades the fallback (the GraphQL path
  still works).
- Premium LeetCode problems return no `content`, so they can only reach title-only confidence
  (max 0.8).
- The injected anchor uses inline styles, so the theme engine treats it like any other page
  element.
