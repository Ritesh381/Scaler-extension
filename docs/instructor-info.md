# Instructor Info (dashboard tags + session tab)

**Setting key:** `instructor-info` (default `true`)
**Code:** [content/features/instructorInfo.js](../extension-main/content/features/instructorInfo.js)
**Pages:** `/academy/mentee-dashboard/todos` (tags) and a class session page
`/academy/mentee-dashboard/class/{id}…` without `joinSession=1` (tab)

## What it does

Two halves:

1. **Dashboard** — subject + instructor pills on class cards (same as
   [lecture-info.md](lecture-info.md)).
2. **Session page** — an **Instructor Info** tab next to Scaler's own tabs, showing a card with
   the instructor's name, email (as a `mailto:` link), role, company, rating and experience. The
   tab label also shows the instructor's first name, e.g. `Instructor Info (Aditya)`.

## Data source

`GET https://www.scaler.com/academy/mentee/events/?start_date=…&end_date=…`, flattened
(`pastEvents` + `futureEvents`) into a `Map` keyed by `sbat_id`.

Two **separate caches** with different ranges, both `{ timestamp, lectureMap, inFlight, cacheKey }`
with a 5-minute TTL and in-flight de-duplication, where `cacheKey` is `"start:end"` so a range
change invalidates correctly:

| Cache | Range |
|---|---|
| `_dashboardInstructorCache` | today − 7 → today + 7 |
| `_sessionInstructorCache` | the session's own date → next day |

The session date is read from `.me-cr-header-dropdown-title__date` and parsed by
`_parseSessionDate()` (`D Mon YYYY` against a month table), falling back to today.

## Dashboard half

Identical mechanics to [lecture-info.md](lecture-info.md): match cards
(`a.me-cr-classroom-url[data-cy="classroom-link"]`) by `/class/(\d+)`, render pills into
`.mentee-card__header`, stamp `data-instructor-info-id`, skip if the stamp already matches.
`_cleanBatchName()` strips `sst`, `group`, single characters and 4-digit years from the batch name.

**Collision guard:** `_applyInstructorInfo` bails if `.scaler-lecture-instructor-info`
(lectureInfo.js's container) is already present — the two features check for each other so a card
never gets duplicate pills.

Observer: debounced 300 ms, scoped to `.mentee-dashboard__content` → `.mentee-dashboard` →
`document.body`, stored on `window._instructorInfoObserver`.

## Session half

`_injectSessionInstructorInfo()`:

1. Resolve the lecture: `classId` from the path first; if that misses, fall back to any lecture in
   the map whose `date_of_topic`/`date` falls on the same day as the session date.
2. `_ensureInstructorPanel()` creates `#scaler-instructor-panel` (`section me-cr-section`,
   `display: none`) and inserts it after `.me-cr-lecture-container` (or `.flex-fill`).
3. `_renderInstructorPanelContent()` builds a Scaler-styled `event-card` with label/value rows,
   skipping any field the API didn't return. No lecture → *"No instructor data available for this
   session."*
4. The tab heading is updated to `Instructor Info (<FirstName>)`, with `<`/`>` escaped since it is
   set via `innerHTML`.

`_ensureInstructorTab()` appends an `<a class="navigation-tab-item me-cr-tabs__tab-item"
id="classroom-instructor-info">` into `.navigation-tabs`, wiring its click handler once
(`dataset.scalerInstructorHandler`).

**Tab switching** — `_activateInstructorTab()` clears the active classes off every
`.navigation-tab-item`, marks ours active, shows the panel and hides the lecture container
(`_setLectureContainerVisible(false)`, which stores the previous `display` value in
`dataset.scalerPrevDisplay`). A delegated handler on `.navigation-tabs` (guarded by
`dataset.scalerInstructorNav`) calls `_deactivateInstructorTab()` when any *other* tab is clicked,
restoring the container.

This is the handler the [Notes tab](lecture-summary.md) has to out-race: it re-shows the container
on any non-instructor tab click, so lectureSummary defers its own hide with `setTimeout(…, 0)`.

Observer: `window._instructorTabObserver`, debounced 300 ms, scoped to `.me-cr-body` →
`document.body`, re-ensuring the tab and re-rendering the panel.

## Entry point

`window.initInstructorInfo()`:

- todos dashboard → inject tags + start the dashboard observer; otherwise disconnect it;
- session page → ensure tab, render panel, start the session observer; otherwise
  `_teardownSessionObserver()`.

Called by `content.js` 1.7 s after load and after every URL change, gated on
`currentSettings["instructor-info"]`.

## Teardown

`content.js` key `instructor-info`, off branch: disconnect both observers, remove
`.scaler-instructor-info` / `.scaler-instructor-tag`, remove `#classroom-instructor-info` and
`#scaler-instructor-panel`, and strip `data-instructor-info-id` attributes.

## Limits

- The session lookup depends on the events window containing that lecture; an old recording
  outside the range shows the empty state.
- Instructor fields (`instructors_email`, `instructors_rating`, `instructors_experience`, …) come
  straight from Scaler's events payload — missing fields are simply omitted.
- Hiding the lecture container to show the panel is a display swap on Scaler's own nodes; the
  previous value is saved and restored, but two features fighting over that container is why the
  ordering rules above exist.
