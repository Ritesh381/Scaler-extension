# Practice Mode (auto-reset assignment code)

**Setting keys:** `practice-mode` (default `false`), `practice-mode-days` (default `7`),
`practice-mode-start` (timestamp, internal)
**Code:** [content/features/practiceMode.js](../extension-main/content/features/practiceMode.js)

## What it does

While practice mode is on, opening an assignment problem you have already solved automatically
clicks Scaler's **Reset code** button (and confirms the modal), so you get a blank editor and can
re-solve the problem from scratch. Each problem is reset at most once every 5 hours.

Intended for revision runs before an interview or a contest.

## Entry point

`handlePracticeMode()` is called from `runCleanup()` (so on load and on every SPA navigation) and
again ~2 s after each URL change from `content.js`.

## Gates, in order

1. `isExtensionValid()` — bail if the extension context was invalidated.
2. `currentSettings["practice-mode"]` must be true.
3. **Expiry** — if `practice-mode-start` is set and
   `Date.now() - start > practice-mode-days × 24 h`, the feature switches *itself* off:
   `practice-mode = false`, `practice-mode-start = null`, written back to
   `chrome.storage.sync`. This is why the popup stamps `practice-mode-start = Date.now()` when
   the toggle is turned on — practice mode is a temporary study mode, not a permanent setting.
4. URL must contain `assignment` and match `/class/(\d+)/assignment/problems/(\d+)`.

## Per-problem throttle

Storage key: `reset_history_${classId}_${problemId}` in `chrome.storage.local`, value = last reset
timestamp. A reset only happens when there is no entry or it is older than **5 hours**.

Two writes keep it accurate:

- the extension writes the timestamp when it triggers a reset;
- a click listener is attached to Scaler's own reset button (guarded by
  `reloadBtn.dataset.resetListener`) so a **manual** reset also records the timestamp and the
  extension doesn't immediately reset again on the next visit.

## Reset sequence

1. Find `i.cr-icon-refresh` and take its `closest("a.tappable")` — that is the reset control.
2. Click it.
3. Scaler shows a confirmation modal. After **800 ms**, scan `.sr-modal` nodes whose text contains
   `Are you sure?` / `Reset!` / `Code would be replaced`, and click
   `a.dialog__action.btn-danger` whose text includes `Reset!`; if that specific selector misses,
   fall back to scanning all `button, a` inside the modal for the exact text `Reset!`.
4. Write the timestamp.

If the reset button isn't in the DOM yet, the whole function retries **once** after 2 s, guarded
by `window._practiceModeRetry` so it can't loop.

## Popup behaviour

Turning the toggle on stamps `practice-mode-start` and reveals the `#practice-mode-options`
sub-panel (days input). Turning it off clears `practice-mode-start` **and deletes every
`reset_history_*` key** from `chrome.storage.local`, so a later re-enable starts clean.
Changing the days input writes `practice-mode-days` and messages the tab.

## Limits

- Modal text matching is English-only and tied to Scaler's current copy.
- This feature *destroys the user's saved code by design*. The 5-hour throttle and the auto-expiry
  are the only safety rails, which is why it ships default-off.
- `content.js`'s toggle branch only handles turning it **on** (`handlePracticeMode()`); turning it
  off simply stops future runs — there is nothing injected to remove.
