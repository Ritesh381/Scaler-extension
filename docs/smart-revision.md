# Smart Revision — spaced repetition for solved problems

**Setting key:** `revision-tracker` (default `true`)
**Code:** [content/features/revisionTracker.js](../extension-main/content/features/revisionTracker.js)
(storage + scheduling), [content/features/revisionMarker.js](../extension-main/content/features/revisionMarker.js)
(the "Mark for Revision" button), [content/features/revisionPanel.js](../extension-main/content/features/revisionPanel.js)
+ [revisionPanel.css](../extension-main/content/features/revisionPanel.css) (dashboard panel),
[background/revisionBadge.js](../extension-main/background/revisionBadge.js) (toolbar badge)

## What it does

Solving a problem once is not the same as remembering it. This adds a spaced-repetition queue:
mark a problem while you are on it, and it comes back on a widening schedule —
**1 → 3 → 7 → 14 → 30 days** — until it graduates off the queue.

## Marking is user-controlled, not automatic

An earlier revision polled Scaler's problems API to detect new solves. That was dropped: it meant
a background fetch on every dashboard load, and it queued problems the user had no intention of
revisiting. Problems now enter the queue only when the user presses **Mark for Revision** on a
problem page.

`markProblemForRevision(title, url, ib_problem_id)` is the only public entry point. It is a no-op
if the problem is already queued, so re-marking never resets an in-progress schedule back to
stage 0.

## Storage shape

One `chrome.storage.local` key, `scalerpp_revision_log`, keyed by **string** problem id:

```js
{
  "1001": {
    title: "Two Sum",
    url: "https://www.scaler.com/academy/...",
    ib_problem_id: "1001",
    solvedAt: 1751500000000,
    intervals: [1, 3, 7, 14, 30],   // per-entry copy, never the shared constant
    stage: 0,
    nextDue: 1751586400000,
  }
}
```

`intervals` is copied per entry on purpose — a shared array would mean rescheduling one problem
silently rescheduled every other one.

`_advanceStage(entry)` returns a **new** entry one stage further on, or `null` once the last
interval is passed, which is the signal to drop the problem from the log (graduated).

## The dashboard panel

`revisionPanel.js` injects a "📚 Revise Today" panel into `.mentee-home__sidebar`, immediately
before `.profile-page-performance`, and only when at least one problem is actually due. It is
collapsible, and each row has a **Revisit** button that opens the problem and advances its stage.

The panel sits **above** Performance, Attendance and the Notice Board, so its height is capped
rather than free-growing: `#srp-list` gets a viewport of ~5 rows
(`--srp-visible-rows`) and scrolls internally. A 50-problem queue therefore moves nothing below
it. `overscroll-behavior: contain` keeps a scroll that hits the end of the list from chaining
into the page.

## Dark mode

The panel is themed alongside the rest of the site — see
[theme-manager.md](theme-manager.md). The `html.scaler-theme-active` rules in `revisionPanel.css`
adjust the row and title colours so the panel reads correctly under the root invert.

## Tests

[tests/revisionTracker.test.js](../tests/revisionTracker.test.js) covers the storage and
scheduling logic: entry construction, id normalisation, per-entry interval copies, due-today
filtering, stage advancement and graduation, and that `markProblemForRevision` is idempotent,
context-safe and swallows storage failures rather than throwing into the page.
