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
| `chrome.runtime.onStartup` | re-creates the alarm if it went missing (profile repair, extension reload) — otherwise one lost alarm kills auto-sync permanently |
| `chrome.alarms.onAlarm` (`autoSyncCalendar`) | re-reads the toggle (so a mid-period disable is respected) and syncs non-interactively |
| popup message `SYNC_CALENDAR` | interactive sync — shows the OAuth consent screen if needed |
| popup message `CALENDAR_SYNC_TOGGLED` | on → schedule alarm + immediate interactive sync; off → `chrome.alarms.clear`, so **zero** API calls happen while disabled |

`CALENDAR_ALARM_PERIOD` is `1440` minutes (24 h). Chrome deduplicates alarms by name, so
`_scheduleAlarm()` is safe to call repeatedly.

## OAuth: two clients, not one

Two **different** Google OAuth clients are required, and they are not interchangeable:

| Client | Type | Used by | Gives a refreshable token? |
|---|---|---|---|
| `manifest.oauth2.client_id` | **Chrome Extension** (Item ID = extension id) | `chrome.identity.getAuthToken` | **yes** — Chrome refreshes it silently |
| `WEB_CLIENT_ID` in `calendarSync.js` | **Web application** | `chrome.identity.launchWebAuthFlow` | no — implicit token, ~1 h, no refresh |

`getAuthToken` only accepts a Chrome-Extension-type client whose Item ID matches this
extension. Handing it the Web client id fails every single time with `bad client id` — Web
clients are confidential clients and an extension has no client secret to present.

That was the real cause of issue #13, and the earlier "forward the interactivity" fix did not
address it: attempt 1 could never succeed, so Chrome's refreshable cache was never populated, so
every background (`interactive: false`) sync threw `no token` — while manual syncs quietly fell
through to the implicit web flow and *looked* healthy. Forwarding interactivity is still correct,
but it only helps once the manifest holds a Chrome-Extension client id.

`_extensionClientId()` returns `null` while the manifest still carries the placeholder (or the Web
client id by mistake), and `_getChromeToken()` then skips `getAuthToken` with one warning instead
of failing on every call — so nothing regresses before the new client id is pasted in.

A background call with no refreshable token throws early with a clear message rather than popping
an unexpected window.

> For `launchWebAuthFlow` to work, the URI from `chrome.identity.getRedirectURL()` must be
> registered as an Authorized Redirect URI on the OAuth 2.0 **Web application** client in Google
> Cloud Console. Unpacked installs get a random extension id, hence a different redirect URI, and
> fail with `redirect_uri_mismatch` unless the manifest pins `"key"`.

### 401 recovery

Chrome caches `getAuthToken` results aggressively. Once a cached token is revoked or stale, every
subsequent call hands back the same dead token. `_calendarFetch()` therefore retries once per
request: on a 401 it calls `chrome.identity.removeCachedAuthToken`, re-mints via
`_getChromeToken()`, and mutates the shared `auth` object so the rest of the run reuses the fresh
token. Implicit web-flow tokens have no refresh path, so they are handed straight back as 401.

If a run ends with authorization failures and zero events added, `performSync` **throws** — it
used to return normally, so the popup printed `✓ Classes added to Calendar` after adding nothing.

## Sync algorithm (`performSync`)

1. **Date range** — today → today + 7 days, formatted as local `YYYY-MM-DD`.
2. **Fetch from Scaler** —
   `GET https://www.scaler.com/academy/mentee/events/?start_date=…&end_date=…&include_offline_events=true`.
   `credentials: "include"` is mandatory — a service-worker `fetch` defaults to `same-origin` and
   `chrome-extension://` is cross-origin to scaler.com, so the session cookie would be dropped; a non-OK response throws "make sure you are logged into Scaler".
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
