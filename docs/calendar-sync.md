# Google Calendar Sync

**Setting key:** `calendar-sync` (default `true`)
**Code:** [background/calendarSync.js](../extension-main/background/calendarSync.js), popup UI in
[popup.js](../extension-main/popup.js) (`#syncCalendarBtn`, `#syncStatus`)
**Permissions used:** `identity`, `alarms`, `oauth2` client in the manifest, host
`https://www.googleapis.com/calendar/*`

## What it does

Pushes the student's upcoming Scaler lessons into their primary Google Calendar, automatically in
the background and on demand from the popup's **Sync Now** button.

## Lifecycle

| Trigger | Behaviour |
|---|---|
| `chrome.runtime.onInstalled` | if the toggle is on, schedule the alarm; on a *fresh install* also run one non-interactive sync immediately |
| `chrome.alarms.onAlarm` (`autoSyncCalendar`) | re-reads the toggle (so a mid-period disable is respected) and syncs non-interactively |
| popup message `SYNC_CALENDAR` | interactive sync — shows the OAuth consent screen if needed |
| popup message `CALENDAR_SYNC_TOGGLED` | on → schedule alarm + immediate interactive sync; off → `chrome.alarms.clear`, so **zero** API calls happen while disabled |

`CALENDAR_ALARM_PERIOD` is `1440` minutes (24 h). Chrome deduplicates alarms by name, so
`_scheduleAlarm()` is safe to call repeatedly.

## OAuth: why interactivity is forwarded

`_getOAuthToken(isInteractive)` tries two strategies:

1. **`chrome.identity.getAuthToken({ interactive })`** — Chrome-native, and importantly Chrome
   keeps a *refreshable* token cache for it.
2. **`chrome.identity.launchWebAuthFlow`** — fallback for Brave / Edge / Arc, which don't
   implement `getAuthToken`. Implicit flow, so the token is not cached and expires in ~1 h.

The caller's interactivity is forwarded into attempt 1 on purpose. A manual sync calls it with
`interactive: true`, which both shows consent *and* seeds Chrome's refreshable cache; only then
can a later background sync (`interactive: false`) get a token 24 h on. An earlier version always
passed `interactive: false` in attempt 1, so the cache was never seeded and every background sync
failed silently (issue #13).

A background call with no cached token throws early with a clear message rather than popping an
unexpected window.

> For `launchWebAuthFlow` to work, the URI from `chrome.identity.getRedirectURL()` must be
> registered as an Authorized Redirect URI on the OAuth 2.0 **Web application** client in Google
> Cloud Console.

## Sync algorithm (`performSync`)

1. **Date range** — today → today + 7 days, formatted as local `YYYY-MM-DD`.
2. **Fetch from Scaler** —
   `GET https://www.scaler.com/academy/mentee/events/?start_date=…&end_date=…&include_offline_events=true`.
   The service worker shares the browser cookie jar, so the Scaler session cookie is attached
   automatically; a non-OK response throws "make sure you are logged into Scaler".
3. **Flatten + filter** — `pastEvents` and `futureEvents` are concatenated (so a class that
   already started today is still captured), then filtered to `event_type === "lesson"`. Labs,
   mentor sessions and unknown types are dropped. Zero lessons → early return.
4. **Token** — `_getOAuthToken(isInteractive)`.
5. **Per lesson**:
   - build the event: `summary = lesson.title`, description = instructor + course
     (`super_batch_name`), `start.dateTime = lesson.date`, `end.dateTime = lesson.end_time`;
   - **duplicate check** — `GET /calendar/v3/calendars/primary/events?q=<title>&timeMin=<start>&timeMax=<end>`;
     any hit → skip;
   - otherwise `POST` the event.
6. Failures are per-event: a Google rejection or network error is logged with the exact status and
   body, counted as skipped, and the loop continues. A single bad event never aborts the run.
7. Logs a final `X added, Y skipped` line.

## Popup UI

`#syncCalendarBtn` disables itself, shows "Syncing…", sends `SYNC_CALENDAR`, and renders
`✓ Classes added to Calendar` or `✗ Sync failed: <reason>`, clearing after 5 s. The
`calendar-sync` toggle also reveals/hides the `#calendar-sync-options` sub-panel via
`_syncSubOptions()`.

## Limits and notes

- Only the **primary** calendar is written to; no calendar picker.
- Duplicate detection is a title+time-window text query, not an idempotency key. A renamed lesson
  can be added twice; a differently-titled class in the same slot is correctly treated as new.
- No event is ever deleted or updated — a rescheduled class leaves the old entry behind.
- Range is fixed at 7 days ahead; nothing further out syncs until a later run.
- Everything happens in the service worker; there is no content-script half and nothing to tear
  down on the page.
