# Google Calendar Sync

**Setting key:** `calendar-sync` (default `true`)
**Code:** [background/calendarSync.js](../extension-main/background/calendarSync.js), popup UI in
[popup.js](../extension-main/popup.js) (`#syncCalendarBtn`, `#syncStatus`)
**Permissions used:** `identity`, `alarms`, `oauth2` client in the manifest, host
`https://www.googleapis.com/calendar/*`
**Google scope:** `https://www.googleapis.com/auth/calendar.app.created` — only

## What it does

Keeps the student's upcoming Scaler lessons in a **Scaler classes** calendar that the extension
creates in their Google account, automatically in the background and on demand from the popup's
**Sync Now** button.

## The scope, and why it is the only one (issue #29)

Until this change the extension asked for `calendar.events` ("view and edit events on all your
calendars") and wrote into the primary calendar. Google classes `calendar.events` as a
**sensitive** scope. An app that asks for a sensitive scope without having passed Google's
verification gets a dead end instead of a consent screen:

> This app is blocked — This app tried to access sensitive info in your Google Account. To keep
> your account safe, Google blocked this access.

`calendar.app.created` ("make secondary Google calendars, and see, create, change, and delete
events on them") covers everything the sync does — `calendars.insert`, `calendars.get`,
`events.get`, `events.insert`, `events.patch` all accept it — and can't see or change anything
else in the account. Developers widely report that the Cloud Console lists it under
**non-sensitive** scopes, which need no verification. Google's API docs don't state a
classification, so the maintainer should confirm it once on the consent screen's Data Access page
(see [Google Cloud Console setup](#google-cloud-console-setup)).

**Keep it the only scope.** `manifest.oauth2.scopes` and `CALENDAR_SCOPE` must stay identical,
and adding any sensitive Calendar scope back (`calendar`, `calendar.events`,
`calendar.readonly`, …) brings the block back. `tests/calendarSync.test.js` fails if either asks
for one.

### Google Cloud Console setup

In the project that owns both OAuth clients (`240142215084`):

1. **Google Auth Platform → Data Access → Add or remove scopes.** Remove `…/auth/calendar.events`,
   add `…/auth/calendar.app.created`, save. It should appear under *Your non-sensitive scopes*.
   If the console shows it as sensitive instead, the app still needs verification and this
   change alone won't remove the block.
2. Publishing status stays **In production** (an app in *Testing* only signs in listed test users).

### Accounts an organisation controls

A school or work Google account (Google Workspace) can be barred from third-party apps by its
administrator, whatever scope is asked for. Nothing in the extension can change that. The web
flow passes `prompt=select_account` so the user can pick a personal account instead, and a
refused or closed sign-in now says so (`_signInRefusedMessage`) instead of "No access token in
redirect URL". On Chrome, `getAuthToken` always uses the profile's account; when the user closes
its window the sync falls back to the web flow, where another account can be chosen. A web-flow
token can't be refreshed, so with an account that isn't the Chrome profile's own, **Sync Now**
works but the 24 h background sync doesn't.

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
5. **Calendar** — `_ensureCalendar()`. `calendar.app.created` can't list the user's calendars, so
   the ids of calendars the extension created are kept in `chrome.storage.sync`
   (`scaler_calendar_ids`, newest first, at most 5) and checked with `calendars.get`. The first one
   found is used. None found (first sync, the user deleted it, or every id belongs to another
   Google account) → `POST /calendars` with `summary: "Scaler classes"` and the browser's time
   zone, and its id goes to the front of the list. A list rather than one id because one Chrome
   profile can sync across devices signed in to different Google accounts: each account finds its
   own calendar, and another account's id is simply not found.
6. **Per lesson** — the event is `summary = lesson.title`, description = instructor + course
   (`super_batch_name`), `start.dateTime = lesson.date`, `end.dateTime = lesson.end_time`, and a
   **fixed id**: `scalerpp<sbat_id>` (event ids are base32hex, `0-9a-v`, 5–1024 chars; a lesson
   with no numeric `sbat_id` gets an FNV-1a hash of title + start in base 32). Then
   `GET /calendars/<ours>/events/<id>`:
   - **404** → `POST` the event (with its id) → *added*;
   - **found, `status: "cancelled"`** → the user deleted it → left alone;
   - **found, same title, description, start and end** (times compared as instants, since Google
     echoes them back in the calendar's offset) → *skipped*;
   - **found, different** → `PATCH` the changed fields → *updated* (a rescheduled or renamed class
     moves instead of being added twice).
7. Failures are per-event: a Google rejection or network error is logged with the exact status and
   body, counted as skipped, and the loop continues. A single bad event never aborts the run. A
   401/403 ends the run; if nothing was added or updated it throws.
8. Returns `{ added, updated, skipped }`; `SYNC_CALENDAR` passes the counts to the popup, which
   shows `✓ N classes synced to “Scaler classes”` or `✓ “Scaler classes” calendar is up to date`.

## Popup UI

`#syncCalendarBtn` disables itself, shows "Syncing…", sends `SYNC_CALENDAR`, and renders
`✓ N classes synced to “Scaler classes”` (or `✓ “Scaler classes” calendar is up to date`) or
`✗ Sync failed: <reason>`, clearing after 5 s. The
`calendar-sync` toggle also reveals/hides the `#calendar-sync-options` sub-panel via
`_syncSubOptions()`.

## Limits and notes

- Classes go only into the **Scaler classes** calendar; the scope can't write anywhere else.
- **Upgrading from the `calendar.events` version:** classes it put into the primary calendar stay
  there (the new scope can't read or remove them), so the next week's classes show twice until
  they pass. Chrome also asks for consent again on the first **Sync Now**, because the scope
  changed; background syncs fail quietly until then.
- A class cancelled on Scaler is not removed from the calendar (the sync only reads the next 7
  days and never deletes).
- Deleting the **Scaler classes** calendar doesn't turn sync off: the next run creates it again.
  The toggle is the off switch.
- Range is fixed at 7 days ahead; nothing further out syncs until a later run.
- Everything happens in the service worker; there is no content-script half and nothing to tear
  down on the page.
