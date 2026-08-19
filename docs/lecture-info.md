# Lecture Info tags (dashboard class cards)

**Setting key:** `lecture-info` (default `true`)
**Code:** [content/features/lectureInfo.js](../extension-main/content/features/lectureInfo.js)
**Page:** `/academy/mentee-dashboard/todos`

## What it does

Adds two small pills to each class card on the todos dashboard: the **subject** (cleaned batch
name) and the **instructor** name — so you can tell classes apart without opening them.

Sibling feature to [instructor-info.md](instructor-info.md), which does the same tagging plus a
session-page tab. They are deliberately written to never double-inject (see below).

## Data source

One call, cached:

```
GET https://www.scaler.com/academy/mentee/events/?start_date=<today-7>&end_date=<today+7>
```

`pastEvents` and `futureEvents` are flattened into a `Map` keyed by `String(sbat_id)`.

`_lectureInstructorCache` holds `{ timestamp, lectureMap, inFlight }` with a **5-minute TTL**, and
`inFlight` de-dupes concurrent callers into a single request (cleared in a `finally`). Since the
observer can fire repeatedly, this is what keeps the feature to roughly one network call per
5 minutes.

## Matching a card to a lecture

Cards are `a.me-cr-classroom-url[data-cy="classroom-link"]`. `_extractClassId(href)` pulls
`/class/(\d+)` and looks it up in the map. No match → the card is skipped silently.

## Rendering

`_applyInstructorInfo(card, lecture)`:

- anchor is `.mentee-card__header`;
- **collision guard** — if `.scaler-instructor-info` (instructorInfo.js's container) is already
  there, bail. The two features check for each other's container so a card never gets two sets of
  pills;
- container `.scaler-lecture-instructor-info` (created once, emptied on re-render);
- subject pill from `_cleanBatchName(lecture.super_batch_name)`, instructor pill from
  `lecture.instructors_name` (`title="Instructor"`);
- pills get inline styling (11 px, rounded, translucent blue background);
- the card is stamped `data-lecture-instructor-info-id="<sbat_id>"`. On the next pass, a card whose
  stamp already equals the current lecture id is skipped — that is the idempotency check.

`_cleanBatchName()` trims noise from names like `"SST Group DSA 2024"`: drops the tokens `sst` and
`group`, single characters, anything containing a 4-digit year, and empty fragments. If everything
is stripped it returns the original name.

## Init and observer

`window.initLectureInfo()` (exposed from an IIFE):

- on the todos dashboard → inject + `_observeDashboardForInstructorInfo()`;
- anywhere else → disconnect and null `window._instructorInfoObserver_lecture`.

The observer is debounced 300 ms and scoped to `.mentee-dashboard__content` →
`.mentee-dashboard` → `document.body`, guarded against double-creation.

`content.js` calls it 1.7 s after load and after every URL change, in both cases only when
`currentSettings["lecture-info"]` is true.

## Teardown

`content.js` key `lecture-info`, off branch: disconnect the observer, remove every
`.scaler-lecture-instructor-info` / `.scaler-lecture-instructor-tag`, and strip every
`data-lecture-instructor-info-id` attribute so a later re-enable re-injects cleanly.

## Limits

- Only classes returned in the ±7 day events window get tags.
- Pill colours are inline and fixed (`#000` text on translucent blue); under a dark theme they are
  recoloured by the global filter like any other page element.
- A fetch failure logs `[Scaler++] Instructor info fetch failed:` and leaves the cards untouched.
