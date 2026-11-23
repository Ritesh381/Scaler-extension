# Calendar Sync: App-Created Calendar Scope — Reviewer Guide

## What is this PR?

The fix for issue #29: Google showing "This app is blocked — This app tried to access sensitive
info in your Google Account" when a user turns on calendar sync.

The sync asked for `calendar.events`, a **sensitive** scope, and the OAuth app is unverified.
It now asks only for `calendar.app.created` and keeps classes in a **Scaler classes** calendar it
creates. Because that calendar is new, events are matched by a fixed id instead of the old
title search, which also makes a rescheduled class move instead of being added twice.

**It needs one step in Google Cloud Console** before it takes effect: the consent screen's Data
Access list must swap `calendar.events` for `calendar.app.created`. See
[calendar-sync.md → Google Cloud Console setup](calendar-sync.md#google-cloud-console-setup).

## Suggested review order

1. **`manifest.json` `oauth2.scopes`** and **`CALENDAR_SCOPE`** at the top of
   `background/calendarSync.js`. They must stay identical; the comment above `CALENDAR_SCOPE`
   says why.
2. **`_ensureCalendar()`** with `_readCalendarIds()` / `_rememberCalendarId()`. This scope can't
   list the user's calendars, so the ids of calendars the extension created are remembered in
   `chrome.storage.sync`, newest first. Check the reasoning for a *list* of ids (one Chrome
   profile, several Google accounts across devices) and what a 401 vs a 404/403 does.
3. **`_eventIdFor()`, `_eventFor()`, `_eventMatches()`**. Event ids must be base32hex (`0-9a-v`),
   5–1024 chars. `Number#toString(32)` produces exactly that alphabet. Times are compared as
   instants because Google echoes them back in the calendar's offset.
4. **The loop in `performSync()`**: `GET` by id, then insert on 404, skip if cancelled (the user
   deleted it) or unchanged, `PATCH` if changed. Auth failures still end the run and still throw
   if nothing was written. It now returns `{ added, updated, skipped }`.
5. **`_getWebToken()`** (`prompt=select_account`, the `error=` parameter) and
   **`_signInRefusedMessage()`**.
6. **The `SYNC_CALENDAR` handler** (passes the counts on) and the success text in **`popup.js`**.
7. **`tests/calendarSync.test.js`**. `fakeGoogle()` is an in-memory Calendar API that answers 500
   to anything aimed at `primary`, and `fakeChrome()` covers `identity`, `alarms` and
   promise-style `storage.sync`.

## Files added

- `tests/calendarSync.test.js` (10 tests; there were none for calendar sync before)
- `docs/calendar-sync-reviewer-guide.md`

## Files modified

- `extension-main/background/calendarSync.js`
- `extension-main/manifest.json`: the scope, and version 1.11.9 → 1.11.10
- `extension-main/popup.js`, `popup.html`: success text and the toggle's description
- `docs/calendar-sync.md`: new sections on the scope, the console step and organisation
  accounts; the sync algorithm and limits rewritten
- `CLAUDE.md`: Google OAuth scopes count as permissions; ask for the narrowest
- `README.md`, `Feature-details.md`, `docs/popup-settings.md`, `docs/README.md`

## What was intentionally NOT changed

- **The OAuth clients**: the same two client ids (Chrome Extension + Web) and the same redirect
  URI. Only the scope changes, in the manifest and on the consent screen.
- **The lifecycle**: install hook, startup self-heal, 24 h alarm, toggle handling and
  `_calendarFetch()`'s 401 recovery are untouched.
- **The Scaler side**: same events feed, same 7-day window, same `lesson` filter.
- **Nothing is ever deleted**: a class cancelled on Scaler stays in the calendar, as before.
- **No migration of old events**: classes the old version put into the primary calendar can't
  be read or removed with the new scope. They age out within a week.
- **No logging added**: the new paths (calendar created, event updated, event deleted by the
  user) log nothing. The file's two existing per-event logs are kept as they were.

## Backward compatibility

- **Re-consent:** Chrome asks for consent once more on the first **Sync Now**, because the
  manifest's scope changed. Background syncs fail quietly until then, as they do for any user who
  hasn't granted access yet.
- **Duplicates:** the coming week's classes appear twice, once in the primary calendar (old) and
  once in **Scaler classes** (new), until they pass.
- **Response shape:** `SYNC_CALENDAR` still answers `{ success: true }`, now with
  `added`, `updated` and `skipped` alongside it. A popup that ignores them still works.

## Risk assessment

- **The console step is the main risk.** If `calendar.app.created` does not show under
  *non-sensitive scopes* on the Data Access page, the app still needs Google's verification
  and the block remains. Developers widely report it as non-sensitive, but Google's API docs
  don't state a classification, so it has to be checked there.
- **Code: low.** Every method used (`calendars.insert`, `calendars.get`, `events.get`,
  `events.insert`, `events.patch`) lists `calendar.app.created` in Google's reference. The run is
  covered against a fake API, and all 10 tests fail on `main`.
- **Not tested with a real Google sign-in.** That needs the Web Store build's extension id (the
  Chrome Extension client is bound to it) and the console change. Please follow the PR's
  "verify" steps after both.
