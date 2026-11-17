// ============================================================
// background/calendarSync.js — Google Calendar Auto-Sync
// ─────────────────────────────────────────────────────────────
//
// Lifecycle:
//   • On install / update → schedules a 24-hour repeating alarm; a *fresh*
//     install also runs one silent sync immediately.
//   • On browser startup  → re-creates the alarm if it went missing.
//   • On each alarm fire  → silently re-syncs in the background.
//   • On SYNC_CALENDAR message → interactive sync (shows OAuth consent).
//   • On CALENDAR_SYNC_TOGGLED message → creates or clears the alarm so no
//     API calls are ever made while the toggle is OFF.
// ============================================================

const CALENDAR_ALARM_NAME = "autoSyncCalendar";
const CALENDAR_ALARM_PERIOD = 1440; // minutes — 24 hours

// ─── Scope ───────────────────────────────────────────────────
// calendar.app.created: "Make secondary Google calendars, and see, create,
// change, and delete events on them." The extension can only touch the one
// calendar it creates — never the user's own calendars or events.
//
// It used to ask for calendar.events ("view and edit events on ALL your
// calendars"). Google classes that scope as SENSITIVE, and an unverified app
// asking for a sensitive scope gets "This app is blocked — This app tried to
// access sensitive info in your Google Account" (issue #29). Keep this the
// ONLY scope, and keep manifest.oauth2.scopes identical to it: adding any
// sensitive Calendar scope back brings the block back.
const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.app.created";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
// The secondary calendar the classes go into.
const CALENDAR_NAME = "Scaler classes";
// chrome.storage.sync: ids of calendars this extension created, newest first.
// A list, not one id, because the same Chrome profile can sync with different
// Google accounts on different devices; each account finds its own calendar
// in the list (another account's id is simply not found).
const CALENDAR_IDS_KEY = "scaler_calendar_ids";
const CALENDAR_IDS_MAX = 5;

// ─── OAuth Clients ───────────────────────────────────────────
// TWO different Google OAuth clients are needed. They are NOT
// interchangeable, and mixing them up is what broke background sync:
//
//   1. manifest.oauth2.client_id MUST be a **Chrome Extension** client
//      (Cloud Console → Credentials → Create OAuth client ID → application
//      type "Chrome Extension", Item ID = this extension's ID). Only that
//      type works with chrome.identity.getAuthToken, and only getAuthToken
//      hands Chrome a *refreshable* token cache — which is the one thing
//      that makes a 24 h background sync possible at all.
//
//   2. WEB_CLIENT_ID is a **Web application** client, used only by
//      launchWebAuthFlow, for browsers that have no working getAuthToken
//      (Brave, Arc) or Chrome profiles with no signed-in Google account.
//      chrome.identity.getRedirectURL() must be registered as an Authorized
//      Redirect URI on that client.
//
// Passing a Web client id to getAuthToken fails 100% of the time ("bad
// client id") because Web clients are confidential clients and an extension
// has no client secret to offer. That was the real cause of issue #13:
// attempt 1 never succeeded, Chrome's refreshable cache was therefore never
// populated, so every background (interactive:false) sync threw — while
// manual syncs fell through to the implicit web flow and appeared to work.
const WEB_CLIENT_ID =
  "240142215084-so5ckgh5al2d6aipa0fg9bsokt2gdp61.apps.googleusercontent.com";

// Replace this in manifest.json with the Chrome-Extension-type client id.
// Until that happens the getAuthToken path is skipped instead of failing
// noisily on every call, so behaviour is no worse than before.
const EXT_CLIENT_ID_PLACEHOLDER =
  "REPLACE_WITH_CHROME_EXTENSION_CLIENT_ID.apps.googleusercontent.com";

/**
 * The Chrome-Extension-type client id from the manifest, or null when it is
 * still unset / left as the placeholder / wrongly set to the Web client.
 */
function _extensionClientId() {
  const id = chrome.runtime.getManifest().oauth2?.client_id ?? "";
  if (!id || id === EXT_CLIENT_ID_PLACEHOLDER || id === WEB_CLIENT_ID) {
    return null;
  }
  return id;
}

// ─── Install Hook ────────────────────────────────────────────

/**
 * Runs once when the extension is installed or updated.
 * Chrome drops an extension's alarms on update, so the alarm is
 * (re)created on both reasons; only a fresh install syncs immediately.
 */
chrome.runtime.onInstalled.addListener(async (details) => {
  const result = await chrome.storage.sync.get("cleanerSettings");
  const settings = result.cleanerSettings || {};

  // Default ON — only skip if the user has explicitly set it to false
  const isEnabled = settings["calendar-sync"] !== false;
  if (!isEnabled) return;

  _scheduleAlarm();

  if (details.reason === "install") {
    console.log("[Scaler++ Calendar] Fresh install — running initial sync.");
    // Non-interactive: if the user hasn't granted OAuth yet this
    // will fail silently; they can trigger it manually from the popup.
    performSync(false).catch((err) =>
      console.warn("[Scaler++ Calendar] Initial sync skipped:", err.message),
    );
  }
});

// ─── Startup Self-Heal ───────────────────────────────────────

/**
 * Alarms survive a browser restart, but they do NOT survive a profile
 * repair, a crashed service worker mid-create, or a manual chrome://extensions
 * reload. Without this, one lost alarm means auto-sync stays dead forever
 * because nothing else re-creates it.
 */
chrome.runtime.onStartup.addListener(async () => {
  const result = await chrome.storage.sync.get("cleanerSettings");
  const settings = result.cleanerSettings || {};
  if (settings["calendar-sync"] === false) return;

  const existing = await chrome.alarms.get(CALENDAR_ALARM_NAME);
  if (!existing) {
    console.warn("[Scaler++ Calendar] Alarm was missing at startup — recreating.");
    _scheduleAlarm();
  }
});

// ─── Alarm Listener ──────────────────────────────────────────

/**
 * Fires every CALENDAR_ALARM_PERIOD minutes.
 * Checks the toggle before running so a mid-alarm disable is
 * respected without waiting for the alarm to be cleared.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CALENDAR_ALARM_NAME) return;

  chrome.storage.sync.get("cleanerSettings", (result) => {
    const settings = result.cleanerSettings || {};
    if (settings["calendar-sync"] === false) return; // toggle was flipped off

    performSync(false).catch((err) =>
      console.error("[Scaler++ Calendar] Auto-sync failed:", err),
    );
  });
});

// ─── Message Listener ────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // ── Manual "Sync Now" button in the popup ──────────────────
  if (request.action === "SYNC_CALENDAR") {
    performSync(/* isInteractive */ true)
      .then((result) => sendResponse({ success: true, ...(result || {}) }))
      .catch((err) => {
        console.error("[Scaler++ Calendar] Manual sync failed:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep the message channel open for the async response
  }

  // ── Toggle switched ON or OFF from the popup ───────────────
  if (request.action === "CALENDAR_SYNC_TOGGLED") {
    if (request.enabled) {
      _scheduleAlarm();
      // Immediately sync on first enable so the user sees feedback
      performSync(true).catch((err) =>
        console.warn(
          "[Scaler++ Calendar] On-enable sync skipped:",
          err.message,
        ),
      );
    } else {
      _clearAlarm();
    }
    sendResponse({ success: true });
    return true;
  }
});

// ─── Alarm Helpers ───────────────────────────────────────────

/**
 * Create (or silently replace) the 24-hour repeating alarm.
 * Chrome deduplicates alarms by name, so calling this more than
 * once is safe — it simply resets the period.
 */
function _scheduleAlarm() {
  chrome.alarms.create(CALENDAR_ALARM_NAME, {
    periodInMinutes: CALENDAR_ALARM_PERIOD,
  });
  console.log(
    `[Scaler++ Calendar] Alarm scheduled — fires every ${CALENDAR_ALARM_PERIOD} min.`,
  );
}

/**
 * Remove the alarm entirely.
 * After this call no background syncs will occur until the alarm
 * is re-created via _scheduleAlarm().
 */
function _clearAlarm() {
  chrome.alarms.clear(CALENDAR_ALARM_NAME, (wasCleared) => {
    console.log(
      "[Scaler++ Calendar] Alarm removed (wasCleared=" +
        wasCleared +
        ")." +
        " No further background syncs will run.",
    );
  });
}

// ─── OAuth ───────────────────────────────────────────────────

/**
 * Chrome-native token via chrome.identity.getAuthToken.
 * Resolves null (never throws) so the caller can decide whether falling
 * back to the web flow is appropriate.
 *
 * This is the ONLY path that yields a token Chrome will silently refresh,
 * so it is also the only path that can serve a background sync.
 */
async function _getChromeToken(isInteractive) {
  if (typeof chrome.identity?.getAuthToken !== "function") {
    return null; // Brave / Arc — no native implementation
  }
  if (!_extensionClientId()) {
    console.warn(
      "[Scaler++ Calendar] manifest.oauth2.client_id is not a Chrome-Extension " +
        "type client — skipping getAuthToken. Background sync stays disabled " +
        "until a Chrome Extension OAuth client id is set.",
    );
    return null;
  }

  return new Promise((resolve) => {
    try {
      chrome.identity.getAuthToken({ interactive: isInteractive }, (token) => {
        if (chrome.runtime.lastError || !token) {
          console.warn(
            "[Scaler++ Calendar] getAuthToken failed:",
            chrome.runtime.lastError?.message ?? "no token returned",
          );
          resolve(null);
        } else {
          resolve(token);
        }
      });
    } catch (err) {
      console.warn("[Scaler++ Calendar] getAuthToken threw:", err.message);
      resolve(null);
    }
  });
}

/**
 * Implicit-flow token via launchWebAuthFlow, for browsers where
 * getAuthToken is unavailable or the profile has no Google account.
 * Interactive only — the token is not cached and expires in ~1 h.
 */
async function _getWebToken() {
  const redirectUrl = chrome.identity.getRedirectURL();

  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(WEB_CLIENT_ID)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&scope=${encodeURIComponent(CALENDAR_SCOPE)}` +
    // A school or work account can be barred from third-party apps by its
    // organisation; letting the user pick an account is the way out.
    `&prompt=select_account`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(_signInRefusedMessage(chrome.runtime.lastError?.message)));
          return;
        }
        const match = responseUrl.match(/access_token=([^&]+)/);
        const error = responseUrl.match(/[#?&]error=([^&]+)/);
        if (match) resolve(match[1]);
        else reject(new Error(_signInRefusedMessage(error && decodeURIComponent(error[1]))));
      },
    );
  });
}

/**
 * What to tell the user when Google sign-in ends without a token. Google's
 * "This app is blocked" page and an organisation's block both end with the
 * window closed or `error=access_denied`, which on their own say nothing.
 */
function _signInRefusedMessage(reason) {
  const detail = reason ? ` (${reason})` : "";
  return (
    `Google sign-in didn't complete${detail}. If Google said the app is blocked, ` +
    "you may be signed in with a school or work account whose organisation doesn't " +
    "allow it — run Sync Now again and pick a personal Google account."
  );
}

/**
 * Resolve an access token.
 *
 * @param {boolean} isInteractive
 *   true  → user-triggered: consent windows are allowed, and a successful
 *           getAuthToken call seeds Chrome's refreshable cache so later
 *           background runs can get a token with interactive:false.
 *   false → alarm-driven: only the silently-refreshable Chrome cache is
 *           acceptable; never pop an unexpected window.
 *
 * @returns {Promise<{token: string, source: "chrome"|"web"}>}
 *   `source` matters for 401 recovery — only "chrome" tokens can be
 *   invalidated and silently re-minted.
 */
async function _getOAuthToken(isInteractive) {
  const chromeToken = await _getChromeToken(isInteractive);
  if (chromeToken) return { token: chromeToken, source: "chrome" };

  if (!isInteractive) {
    throw new Error(
      "No refreshable Google token available in the background — " +
        "run a manual sync from the popup once to grant access.",
    );
  }

  const webToken = await _getWebToken();
  return { token: webToken, source: "web" };
}

/**
 * Calendar API fetch with one-shot 401 recovery.
 *
 * Chrome caches getAuthToken results aggressively: once a cached token is
 * revoked or stale, every later call returns the same dead token and every
 * request 401s. Without removeCachedAuthToken the extension stays broken
 * until the profile is restarted — and because per-event failures are only
 * counted as "skipped", the popup still reported success.
 *
 * `auth` is mutated in place on a successful refresh so the remaining
 * lessons in the run reuse the new token.
 */
async function _calendarFetch(url, init, auth, isInteractive) {
  const withAuth = (token) => ({
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });

  const res = await bgFetch(url, withAuth(auth.token));
  if (res.status !== 401) return res;

  // Implicit web-flow tokens have no refresh path — nothing to retry with.
  if (auth.source !== "chrome") return res;

  console.warn("[Scaler++ Calendar] Token rejected (401) — invalidating cache.");
  await new Promise((resolve) =>
    chrome.identity.removeCachedAuthToken({ token: auth.token }, resolve),
  );

  const fresh = await _getChromeToken(isInteractive);
  if (!fresh) return res; // hand the 401 back to the caller

  auth.token = fresh;
  return bgFetch(url, withAuth(auth.token));
}

// ─── Calendar & events ───────────────────────────────────────

async function _readCalendarIds() {
  const stored = (await chrome.storage.sync.get(CALENDAR_IDS_KEY))[CALENDAR_IDS_KEY];
  return Array.isArray(stored) ? stored.filter((id) => typeof id === "string") : [];
}

async function _rememberCalendarId(id, known) {
  const ids = [id, ...known.filter((k) => k !== id)].slice(0, CALENDAR_IDS_MAX);
  await chrome.storage.sync.set({ [CALENDAR_IDS_KEY]: ids });
}

function _authRejected(status) {
  return status === 401 || status === 403;
}

/**
 * The id of this extension's "Scaler classes" calendar in the signed-in
 * account, creating the calendar if there is none (first sync, or the user
 * deleted it).
 *
 * calendar.app.created can't list the user's calendars, so the ids of the
 * calendars it created are remembered and checked one by one: a calendar
 * that was deleted, or that belongs to another Google account, is not found.
 */
async function _ensureCalendar(auth, isInteractive) {
  const known = await _readCalendarIds();
  for (const id of known) {
    const res = await _calendarFetch(
      `${CALENDAR_API}/calendars/${encodeURIComponent(id)}`,
      {},
      auth,
      isInteractive,
    );
    if (res.ok) {
      if (known[0] !== id) await _rememberCalendarId(id, known);
      return id;
    }
    if (res.status === 401) {
      throw new Error("Google rejected the authorization. Re-run Sync Now and grant access.");
    }
    // 404 / 403: deleted, or another account's calendar — try the next one.
  }

  const res = await _calendarFetch(
    `${CALENDAR_API}/calendars`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: CALENDAR_NAME,
        description: "Your Scaler classes, kept up to date by the Scaler++ extension.",
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    },
    auth,
    isInteractive,
  );
  if (!res.ok) {
    if (_authRejected(res.status)) {
      throw new Error("Google rejected the authorization. Re-run Sync Now and grant access.");
    }
    throw new Error(`Couldn't create the "${CALENDAR_NAME}" calendar (HTTP ${res.status}).`);
  }
  const { id } = await res.json();
  await _rememberCalendarId(id, known);
  return id;
}

/**
 * A stable Google event id for a lesson, so a re-sync finds the event it made
 * before instead of guessing by title. Event ids use base32hex (0-9, a-v), 5
 * to 1024 characters; Number#toString(32) produces exactly that alphabet.
 */
function _eventIdFor(lesson) {
  const raw = String(lesson.sbat_id ?? "");
  if (/^[0-9]+$/.test(raw)) return `scalerpp${raw}`;
  // No class id: hash title + start (FNV-1a) instead.
  const key = `${lesson.title}|${lesson.date}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `scalerpp${hash.toString(32)}`;
}

/** The Google Calendar event for a Scaler lesson. */
function _eventFor(lesson) {
  return {
    id: _eventIdFor(lesson),
    summary: lesson.title,
    description:
      `Instructor: ${lesson.instructors_name}\n` + `Course: ${lesson.super_batch_name}`,
    start: { dateTime: lesson.date },
    end: { dateTime: lesson.end_time },
  };
}

/** Does the stored event already say what `wanted` says? Times compare as instants. */
function _eventMatches(current, wanted) {
  const same = (a, b) => Date.parse(a?.dateTime) === Date.parse(b?.dateTime);
  return (
    current.summary === wanted.summary &&
    (current.description || "") === wanted.description &&
    same(current.start, wanted.start) &&
    same(current.end, wanted.end)
  );
}

// ─── Core Sync ───────────────────────────────────────────────

/**
 * Fetch the next 7 days of Scaler lessons and keep them in the extension's
 * own "Scaler classes" Google calendar: new lessons are added, rescheduled or
 * renamed ones updated in place, and an event the user deleted stays deleted.
 *
 * @param {boolean} isInteractive See _getOAuthToken.
 * @returns {Promise<{added: number, updated: number, skipped: number}|undefined>}
 */
async function performSync(isInteractive = false) {
  // ── 1. Build date range: today → +7 days ──────────────────
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const localDate = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  const startDate = localDate(now);
  const endDate = localDate(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7),
  );

  console.log(
    `[Scaler++ Calendar] Fetching events for ${startDate} → ${endDate}`,
  );

  // ── 2. Fetch events from Scaler ───────────────────────────
  // credentials:"include" is required — a service-worker fetch defaults to
  // "same-origin", and chrome-extension:// is cross-origin to scaler.com,
  // so the session cookie would not be attached. Every other Scaler fetch
  // in this codebase passes it too.
  const scalerUrl =
    `https://www.scaler.com/academy/mentee/events/` +
    `?start_date=${startDate}&end_date=${endDate}&include_offline_events=true`;

  const scalerRes = await bgFetch(scalerUrl, { credentials: "include" });
  if (!scalerRes.ok) {
    throw new Error(
      `Scaler API error (HTTP ${scalerRes.status}). ` +
        `Make sure you are logged into Scaler.`,
    );
  }

  const responseData = await scalerRes.json();

  // Combine past and future arrays into one flat list so we
  // capture classes that started before the current moment too
  const allEvents = [
    ...(responseData.pastEvents || []),
    ...(responseData.futureEvents || []),
  ];
  console.log(
    `[Scaler++ Calendar] Scaler returned ${allEvents.length} event(s) total.`,
  );

  // Keep only proper lesson events — filter out standalone labs,
  // mentor sessions, and any unknown event_type values
  const lessons = allEvents.filter((e) => e.event_type === "lesson");
  console.log(
    `[Scaler++ Calendar] ${lessons.length} lesson(s) eligible for sync.`,
  );

  if (lessons.length === 0) {
    console.log("[Scaler++ Calendar] Nothing to sync — exiting early.");
    return { added: 0, updated: 0, skipped: 0 };
  }

  // ── 3. Obtain Google OAuth token and our calendar ─────────
  const auth = await _getOAuthToken(isInteractive);
  const calendarId = await _ensureCalendar(auth, isInteractive);
  const eventsUrl = `${CALENDAR_API}/calendars/${encodeURIComponent(calendarId)}/events`;

  // ── 4. Upsert each lesson by its stable event id ──────────
  let addedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let authFailures = 0;

  for (const lesson of lessons) {
    const event = _eventFor(lesson);
    console.log(`[Scaler++ Calendar]   → "${lesson.title}"`);

    try {
      const existingRes = await _calendarFetch(
        `${eventsUrl}/${event.id}`,
        {},
        auth,
        isInteractive,
      );
      if (_authRejected(existingRes.status)) {
        // Auth is dead for the whole run — no point hammering the rest
        authFailures++;
        console.error(
          `[Scaler++ Calendar]   ✗ Auth rejected (HTTP ${existingRes.status}) ` +
            `while checking "${lesson.title}".`,
        );
        break;
      }

      let writeRes;
      if (existingRes.ok) {
        const current = await existingRes.json();
        if (current.status === "cancelled") {
          // The user deleted it from the calendar: respect that.
          skippedCount++;
          continue;
        }
        if (_eventMatches(current, event)) {
          console.log(`[Scaler++ Calendar]   ⏭ Already exists: "${lesson.title}"`);
          skippedCount++;
          continue;
        }
        const changes = { ...event };
        delete changes.id; // it's in the URL
        writeRes = await _calendarFetch(
          `${eventsUrl}/${event.id}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(changes),
          },
          auth,
          isInteractive,
        );
        if (writeRes.ok) {
          updatedCount++;
          continue;
        }
      } else if (existingRes.status === 404) {
        writeRes = await _calendarFetch(
          eventsUrl,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(event),
          },
          auth,
          isInteractive,
        );
        if (writeRes.ok) {
          console.log(`[Scaler++ Calendar]   ✓ Added: "${lesson.title}"`);
          addedCount++;
          continue;
        }
      } else {
        writeRes = existingRes;
      }

      if (_authRejected(writeRes.status)) {
        authFailures++;
        console.error(
          `[Scaler++ Calendar]   ✗ Auth rejected (HTTP ${writeRes.status}) ` +
            `while saving "${lesson.title}".`,
        );
        break;
      }
      // Log the exact Google error reason and continue — a single bad
      // event (e.g. malformed date) should not abort the rest of the run.
      const errorBody = await writeRes.text();
      console.error(
        `[Scaler++ Calendar]   ✗ Google rejected "${lesson.title}" ` +
          `(HTTP ${writeRes.status}): ${errorBody}`,
      );
      skippedCount++;
    } catch (networkError) {
      // Network failure for a single event — log and move on
      console.error(
        `[Scaler++ Calendar]   ✗ Network error for "${lesson.title}":`,
        networkError,
      );
      skippedCount++;
    }
  }

  console.log(
    `[Scaler++ Calendar] Sync complete — ` +
      `${addedCount} added, ${updatedCount} updated, ${skippedCount} skipped.`,
  );

  // Never report success when the run died on authorization — the popup
  // used to print "✓ Classes added to Calendar" after adding nothing.
  if (authFailures > 0 && addedCount + updatedCount === 0) {
    throw new Error(
      "Google rejected the authorization. Re-run Sync Now and grant access.",
    );
  }
  return { added: addedCount, updated: updatedCount, skipped: skippedCount };
}
