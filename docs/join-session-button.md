# Join Session Button

**Setting key:** `join-session` (default `true`, declared in `popup.js`'s `DEFAULT_SETTINGS`)
**Code:** [content/features/joinClassButton.js](../extension-main/content/features/joinClassButton.js)
Styling: `.scaler-join-session-btn` in [core/styleInjector.js](../extension-main/content/core/styleInjector.js)

## What it does

On the mentee dashboard, replaces the passive **View Details** label on a class card with a
one-click **Join Session** button — but only for classes that are live *right now*.

The button links to `${classHref}/session?joinSession=1`, which is also the URL that triggers the
[companion bypass](companion-bypass.md).

## Two gates

A button is injected only when **both** hold:

1. **Date gate** — `isActiveDateToday()`. The dashboard has date tabs (`23 Feb`);
   `getActiveDashboardDate()` reads `.tabs__tab--active`, parses `D Mon` against a month table,
   and infers the year: current year, bumped to next year if the resulting date is more than
   60 days in the past (a December→January boundary case). The parsed date must equal today.
2. **Time gate** — `isClassLiveNow(start, end)`. `extractClassTimes(card)` reads the two
   non-separator `<span>`s inside `._1EQZYaGMSYVhKTiIKY-qXP > div` (the separator spans carry
   `m-l-5` / `m-r-5`). `parseClassTime("02:30 PM")` converts 12-hour text to today's `Date`
   (12 AM → 0, 1–11 PM → +12). Live means `start <= now < end`.

If the times can't be parsed the card is skipped — the original "View Details" stays.

## Injection

`injectJoinSessionButtons()` iterates `a.me-cr-classroom-url[data-cy="classroom-link"]`. For each
live card it finds the `._3cg2nc-UIVR1CzIB7nNQ8Z` span ("View Details") and `replaceWith()`s an
anchor:

- text `Join Session`, class `scaler-join-session-btn`, `title` showing the class window;
- a `click` handler calling `stopPropagation()` so the parent card link doesn't also navigate.

The card is stamped `data-joinSessionInjected="true"`. The guard is deliberately *soft*: a card is
skipped only if the flag **and** the button are both present, so cards re-rendered by React get
re-evaluated (and so does the time window, which changes as the class ends).

## Observer

`observeDashboardForClassCards()` installs one debounced (200 ms) `MutationObserver`, scoped to
`.mentee-dashboard__content` → `.mentee-dashboard` → `document.body`, stored on
`window._joinSessionObserver` and guarded so it is created once.

`initJoinSessionButtons()` runs only when the URL contains `mentee-dashboard` and the setting is
not `false`; it is called on load (+1.5 s) and after every URL change.

## Teardown

`content.js` key `join-session`, off branch:

1. every `.scaler-join-session-btn` is replaced back with a
   `<span class="_3cg2nc-UIVR1CzIB7nNQ8Z">View Details</span>`;
2. every `data-join-session-injected` flag is deleted so re-enabling can re-inject;
3. `window._joinSessionObserver` is disconnected and nulled.

## Limits

- Reconstructing "View Details" hardcodes Scaler's hashed span class; if that class changes the
  restored label loses its styling (the text is still correct).
- The live check is evaluated only when the observer fires or navigation re-inits. A class that
  starts while the dashboard sits idle and untouched won't sprout a button until something
  mutates.
- Time strings are assumed to be `hh:mm AM/PM` in the browser's local timezone.
