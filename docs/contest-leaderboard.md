# Contest Leaderboard Unlock

**Setting key:** `contest-leaderboard` (default `true`)
**Code:** [content/features/contestLeaderboard.js](../extension-main/content/features/contestLeaderboard.js)
**Pages:** any URL containing `/contest`

## What it does

Scaler greys out the **View Leaderboard** stat card while a contest is still running. This feature
turns it into a working link so you can watch the scoreboard live.

## How it works

1. **`findDisabledLeaderboard()`** scans `.cr-stats.cr-stats--first` containers for one that:
   - has `i.cr-icon-trophy` **without** the `cr-icon-trophy-filled` modifier (i.e. the disabled
     trophy), and
   - has a `.cr-stats__bottom` element that is *not* an `<a>` and whose text is exactly
     `View Leaderboard`.

   Returning `null` means it is already enabled, already processed, or the layout is unknown.
2. **`extractContestId()`** pulls the numeric id from the URL
   (`/(?:class|classroom)/(\d+)/contest`).
3. **`fetchContestAlias(contestId)`** — `GET https://www.scaler.com/api/v2/classroom/{id}/contest`
   with `credentials: "include"`. The alias is looked up through a fallback chain because the
   response shape varies:

   ```
   data.attributes.current_contest.alias
   → data.attributes.current_contest.tests[0].alias
   → data.attributes.alias
   ```
4. **`injectLeaderboardLink(container, alias)`** swaps the trophy class to
   `cr-icon-trophy-filled` and replaces the inert `.cr-stats__bottom` div with
   `<a class="cr-stats__bottom link block bold" href="/contest/{alias}/scoreboard">View Leaderboard</a>`,
   then stamps `container.dataset.scalerLeaderboardInjected = "true"`.

## Concurrency guard

A contest page mutates constantly (timers, submissions), so `enableContestLeaderboard()` is
protected by the module flag `_leaderboardFetchInProgress`, set before the alias fetch and cleared
in a `finally`. Without it a burst of mutations would fire several identical API calls.

## Observer

`observeForLeaderboard()` installs one `MutationObserver` scoped to `.classroom-contest` →
`.cr-stats-container` → `document.body`, debounced **300 ms**, which re-checks the setting on each
callback and only calls `enableContestLeaderboard()` when no fetch is in flight. Stored on
`window._leaderboardObserver`, guarded against double-creation.

`initContestLeaderboard()` runs on load (+2 s) and 2 s after any URL change on a contest page.

## Teardown

`content.js` key `contest-leaderboard`, off branch: disconnects and nulls
`window._leaderboardObserver`. The already-injected link is **not** reverted — as the code notes,
undoing it would mean restoring Scaler's original div, and the page reload does that anyway.

## Limits

- Purely a UI unlock: it constructs the public scoreboard URL. If Scaler enforces the restriction
  server-side, the page itself will refuse.
- Depends on the `cr-stats` markup and the trophy icon class names.
- The alias fetch needs an authenticated session; a failure logs a warning and leaves the card
  untouched.
