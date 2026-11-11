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

`initSubjectSort()` runs once at module load (+500 ms, after `loadSettings()`), and `content.js`
calls it 1.5 s after every URL change. On a `/core-curriculum` page with the feature on, it starts
`observeSubjectList()` and sorts. Anywhere else, or with the feature off, it stops the observer.

The observer watches `document.body` (`childList` + `subtree`), is debounced 150 ms, and only ever
calls `sortSubjects()`, which does nothing unless some block lacks `data-subject-processed`. It
never calls `restoreSubjectSort()`. An earlier version did, and restoring the numbers mutated the
list, which re-ran the observer in a loop that froze the tab. The observer is stored on
`window._subjectSortObserver`, guarded against double-creation, and stopped by
`stopSubjectSortObserver()`.

## Teardown

`restoreSubjectSort()` clears `data-subject-processed`, restores each number element's
`data-original-text` and then removes that attribute, so a second restore changes nothing.
`content.js` (key `subject-sort`, off) calls it and disconnects `window._subjectSortObserver`.

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
