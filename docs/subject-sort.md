# Subject Sort (Core vs Other)

**Setting key:** `subject-sort` (default `true`)
**Code:** [content/features/subjectSort.js](../extension-main/content/features/subjectSort.js)
**Page:** any URL containing `/core-curriculum`

## What it does

Splits the Core Curriculum subject list into **Core** subjects and **Other** subjects (clubs,
workshops, revision, POSH, interview prep, miscellaneous), reorders the page so Core comes first,
renumbers the subjects sequentially, and tags each with a coloured `Core` / `Other` pill.

## Classification

Pure keyword match on the subject name (`._29EfoWpTY6mSoc0URgsgPl`, lowercased). If the name
contains any of:

```
academic, club, misc, miscellaneous, revision, other, others,
posh, session, workshop, workshops, interview, prep, prep-
```

it goes to **Other**; otherwise **Core**. A subject whose name element can't be found defaults to
Core (fail-safe: never demote something unknown).

## Reordering + renumbering

`initSubjectSort()`:

1. Bail unless `shouldHide("subject-sort")` and the URL contains `/core-curriculum`.
2. Find the container `.m-l-20.m-r-20.m-t-20`, collect `.m-b-20` subject blocks.
3. Bail if every block already has `data-subject-processed` (idempotency).
4. Stamp each block processed, bucket it Core/Other.
5. `processDiv(type)` runs over Core first, then Other. For each block it rewrites the
   `.ZV1LrApmcV6Ae3HM7BSTK` number element to `Subject - {n}` with a running counter, appends the
   styled pill span (`.subject-sort-tag`, blue for Core, grey for Other), and **`container.appendChild(div)`** —
   re-appending an existing child moves it to the end, so processing Core then Other produces the
   desired order.
6. Before overwriting, the original number text is preserved in `data-original-text`.

## Observer

`observeSubjectList()` is started by a `setTimeout(..., 500)` at module load (this file
self-registers rather than being driven from `content.js`'s init list). It observes
`document.body` (`childList` + `subtree`) and re-runs `initSubjectSort()` only when the curriculum
container holds at least one block lacking `data-subject-processed`. The observer is stored on
`window._subjectSortObserver` and guarded against double-creation.

`content.js` also calls `initSubjectSort()` 1.5 s after any URL change that includes
`/core-curriculum`.

## Teardown

`restoreSubjectSort()` clears `data-subject-processed` and restores each number element's
`data-original-text`. `content.js` (key `subject-sort`, off) calls it and disconnects
`window._subjectSortObserver`.

**Known limitation, stated in the code:** the original DOM *order* is not restored — only the
numbering. Toggling off leaves the subjects grouped until the page is reloaded.

## Limits

- Keyword classification is heuristic; a core subject whose title contains e.g. "Session" will be
  bucketed as Other.
- The observer is on `document.body` with `subtree: true` (broader than the codebase's usual
  narrow scoping) and is only cheap because the re-run check short-circuits on the
  `data-subject-processed` scan.
- Depends on three hashed Scaler class names (`.m-l-20.m-r-20.m-t-20`, `.m-b-20`,
  `._29EfoWpTY6mSoc0URgsgPl`, `.ZV1LrApmcV6Ae3HM7BSTK`).
