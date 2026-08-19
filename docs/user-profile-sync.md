# Profile Sync, Activity Ping & Download Counters

**Setting key:** none — runs whenever the extension is active on scaler.com
**Code:** [content/features/usernameTracker.js](../extension-main/content/features/usernameTracker.js) ·
[background/messagesProxy.js](../extension-main/background/messagesProxy.js)
**Backend:** `https://scalerbackend.vercel.app`

## What it does

Three related things:

1. **Profile sync** — reads the logged-in student's profile from Scaler's own APIs and POSTs it to
   the Scaler++ backend once per schema version.
2. **Activity ping** — a lightweight "last seen" ping on every page load.
3. **Download counters** — increments a usage counter when a video / audio / transcript download
   completes (fired from the downloader, not from this file).

The cached email is also what makes [custom-messages.md](custom-messages.md) able to target an
audience and what stamps `generatedBy` on shared transcripts and AI notes.

## Version-gated sync

```js
const SYNC_VERSION = 9;
```

`initUsernameTracker()` reads `scaler_sync_version` and `scaler_user` from `chrome.storage.sync`:

- if a cached email exists → `pingUser(email)` **every load**, regardless of version;
- if `scaler_sync_version === SYNC_VERSION` → skip the full profile sync;
- otherwise → `fetchAndSyncUser()`.

Bumping `SYNC_VERSION` when new fields are added forces every existing user to re-sync on their
next page load. That is the whole migration mechanism.

## What is collected

`fetchAndSyncUser()` calls three Scaler endpoints in parallel with `credentials: "include"`:

| Endpoint | Fields taken |
|---|---|
| `/analytics/` | `id` (as `scaler_id`), `name`, `gender`, `email`, `orgyear`, `cohort` |
| `/academy/mentee-dashboard/initial-load-data/` | `linkedin_profile`, `slug`, `role`, `country`, `avatar_file_name` |
| `/academy/mentee/performance-stats/` | `cgrScore` (as `cgr_score`) |

`phone_number` is present in the source data and is explicitly **commented out** — it is not
collected.

The payload goes to the worker as `syncUserProfile` → `POST /api/messages/sync-user`. Only on a
successful response does the content script write back:

```js
chrome.storage.sync.set({
  scaler_sync_version: SYNC_VERSION,
  scaler_user: { name, gender, email },   // only these three cached locally
});
```

…and then pings immediately. Any failure is swallowed (`.catch(() => {})`) — this must never
disturb the page.

## Ping

`pingUser(email)` → worker action `pingUser` → `POST /api/users/ping` with `{ email }`.
Fire-and-forget: the worker does not call `sendResponse` and the content script does not await it.

## Download tracking

Fired by `videoDownloader.js`, `videoProcessor.js` and `transcriptProcessor.js` after a **completed**
download: worker action `trackDownload` → `POST /api/users/download` with
`{ email, type, lecture, lectureSlug }`. Also fire-and-forget; a failed counter never affects the
download.

## Guards

Every entry point checks `chrome.runtime?.id` before touching `chrome.*`, and again inside the
storage callback, so a reloaded extension in a still-open tab fails silently rather than throwing
"context invalidated".

## Privacy summary

- Data leaves the browser only to `scalerbackend.vercel.app`, and only data Scaler already exposes
  to the logged-in user about themselves.
- No passwords, tokens or cookies are read or transmitted.
- Locally cached: `scaler_user` (name, gender, email) and `scaler_sync_version` in
  `chrome.storage.sync`.
- There is no opt-out toggle today. Users who want none of this can disable the extension on
  scaler.com.
