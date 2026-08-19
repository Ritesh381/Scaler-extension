# Pick Random Problem

**Setting key:** `problem-picker` (default `true`)
**Code:** [content/features/problemPicker.js](../extension-main/content/features/problemPicker.js)
Button styling lives in [core/styleInjector.js](../extension-main/content/core/styleInjector.js)
(`.scaler-pick-random-btn`).

## What it does

Adds a **Pick Random** button next to the dashboard's *Practice* section header. Clicking it
fetches the student's problem list, picks a random **unsolved** problem, and opens it in a new tab.

## `ProblemPicker` class

```js
fetchProblems()   // GET /academy/mentee/problems-data (credentials: include)
                  // → Object.values(data.problems).filter(p => p.status === "unsolved")
pickRandom()      // fetch on first use, then Math.random() index into the cached list
static buildUrl(p)
```

`buildUrl` reconstructs a canonical URL rather than trusting any slug from the API:

```
https://www.scaler.com/academy/mentee-dashboard/class/{sbat_id}/{assignment|homework}/problems/{ib_problem_id}
```

The segment is `assignment` when `problem.type === "assignment"`, otherwise `homework`.

The unsolved list is cached on the instance (`this.loaded`), so repeated clicks on the same page
reuse one fetch. A fresh `ProblemPicker` is created per injected button, so a page reload or SPA
navigation gets fresh data.

## Injection (`initProblemPicker`)

Called on load (+1.5 s and +1.2 s from the two init paths) and after every URL change.

1. Skip if `currentSettings["problem-picker"]` is falsy.
2. Scan `.section-header__content` nodes for one whose `.section-header__title` text is exactly
   `Practice`.
3. Guard: skip if `header.dataset.pickerInjected === "true"` or the button already exists.
   The dataset flag is set **immediately**, before any async work, so two overlapping init calls
   cannot both inject.
4. Append the button.

## Click handling

The handler `preventDefault`s and `stopPropagation`s (the header may be inside a link), swaps the
label to `Fetching...`, disables the button, then:

- problem found → `window.open(url, "_blank")`;
- list empty → `alert("Scaler++: No unsolved problems found in your dashboard!")`;
- fetch error → logged to console (the user-facing alert is intentionally commented out, so a
  logged-out session fails quietly).

A `finally` block always restores the original label and re-enables the button.

## Teardown

`content.js` key `problem-picker`: on → `initProblemPicker()`; off → remove
`.scaler-pick-random-btn`. Note the `data-picker-injected` attribute is not cleared on teardown,
so re-enabling relies on a subsequent navigation re-rendering the header. No observers, timers or
listeners on `window`/`document` are created by this feature.

## Limits

- Depends on the *Practice* section header being present and titled exactly "Practice".
- `/academy/mentee/problems-data` is a Scaler endpoint reached with the session cookie; if the
  user is logged out it 4xx's and the click silently does nothing beyond a console warning.
- The random pick is uniform over all unsolved problems — there is no difficulty or topic
  weighting.
