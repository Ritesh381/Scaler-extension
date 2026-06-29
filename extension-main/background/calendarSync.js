// ============================================================
// background/calendarSync.js — Google Calendar Auto-Sync
// ─────────────────────────────────────────────────────────────

// Lifecycle:
//   • On first install  → schedules a 12-hour repeating alarm
//     and immediately runs an initial sync (if the toggle is on).
//   • On each alarm fire → silently re-syncs in the background.
//   • On SYNC_CALENDAR message → runs an interactive sync
//     (shows OAuth consent screen if not yet authenticated).
//   • On CALENDAR_SYNC_TOGGLED message → creates or clears the
//     alarm so no API calls are ever made while the toggle is OFF.
// ============================================================

const CALENDAR_ALARM_NAME = "autoSyncCalendar";
const CALENDAR_ALARM_PERIOD = 1440; // minutes — 24 hours

// ─── Install Hook ────────────────────────────────────────────

/**
 * Runs once when the extension is installed or updated.
 * For fresh installs we schedule the alarm AND do an immediate
 * sync so the user doesn't have to wait 12 hours for their
 * first calendar entries.  Updates leave existing alarms alone.
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
      .then(() => sendResponse({ success: true }))
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
 * Create (or silently replace) the 12-hour repeating alarm.
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

// ─── Core Sync ───────────────────────────────────────────────

/**
 * Fetch today + tomorrow's Scaler lessons and push each one to
 * the user's primary Google Calendar.
 *
 * @param {boolean} isInteractive
 *   Pass `true` when the user explicitly triggered the sync
 *   (e.g. the "Sync Now" button).  Chrome.identity will then
 *   show the OAuth consent screen if a token isn't cached yet.
 *   Pass `false` for background / alarm-driven calls — if the
 *   user hasn't authenticated the call fails quietly rather than
 *   popping up an unexpected browser window.
 */ // ─── OAuth Helper ─────────────────────────────────────────────

/**
 * Attempts getAuthToken (Chrome-native, zero config needed).
 * Falls back to launchWebAuthFlow for Brave / Edge / Arc.
 *
 * WHY interactivity is forwarded (fixes 24h auto-sync, issue #13):
 * A *manual* sync must call getAuthToken with interactive:true so Chrome shows
 * the consent screen AND populates its refreshable token cache. Only then can
 * the *background* (interactive:false) call return a token 24h later — Chrome
 * auto-refreshes cached getAuthToken tokens. Previously Attempt 1 was always
 * interactive:false, so the cache was never populated and every background sync
 * failed silently (the launchWebAuthFlow implicit token is not cached, expires
 * in ~1h, and has no refresh token) — forcing users to sync manually each time.
 *
 * NOTE: For launchWebAuthFlow to succeed, the URI returned by
 * chrome.identity.getRedirectURL() must be added as an
 * Authorized Redirect URI in Google Cloud Console under the
 * OAuth 2.0 Web Application client.
 */
async function _getOAuthToken(isInteractive) {
  // ── Attempt 1: Chrome native (getAuthToken) ───────────────
  // Forward the caller's interactivity: interactive:true on a manual sync
  // seeds the refreshable cache; interactive:false in the background reuses it.
  try {
    const token = await new Promise((resolve, reject) => {
      chrome.identity.getAuthToken({ interactive: isInteractive }, (t) => {
        if (chrome.runtime.lastError || !t) {
          reject(new Error(chrome.runtime.lastError?.message ?? "no token"));
        } else {
          resolve(t);
        }
      });
    });
    return token;
  } catch (_) {
    // Not cached yet — fall through to interactive flow below
    if (!isInteractive) {
      throw new Error(
        "No cached token and running in background — " +
          "user must trigger a manual sync first.",
      );
    }
  }
  // ── Attempt 2: launchWebAuthFlow (all Chromium browsers) ──
  const CLIENT_ID = chrome.runtime.getManifest().oauth2.client_id;
  const redirectUrl = chrome.identity.getRedirectURL();

  const authUrl =
    `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&response_type=token` +
    `&redirect_uri=${encodeURIComponent(redirectUrl)}` +
    `&scope=${encodeURIComponent("https://www.googleapis.com/auth/calendar.events")}`;

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl, interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(
            new Error(
              chrome.runtime.lastError?.message ??
                "Auth cancelled. On Brave/Edge, ensure the redirect URI is " +
                  "registered in Google Cloud Console.",
            ),
          );
          return;
        }
        const match = responseUrl.match(/access_token=([^&]+)/);
        if (match) resolve(match[1]);
        else reject(new Error("No access token in redirect URL"));
      },
    );
  });
}

async function performSync(isInteractive = false) {
  // ── 1. Build date range: today → tomorrow ─────────────────
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
  // The service worker shares the browser's cookie jar, so the
  // user's Scaler session cookie is attached automatically.
  const scalerUrl =
    `https://www.scaler.com/academy/mentee/events/` +
    `?start_date=${startDate}&end_date=${endDate}&include_offline_events=true`;

  const scalerRes = await fetch(scalerUrl);
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
    return;
  }

  // ── 3. Obtain Google OAuth token ──────────────────────────
  const token = await _getOAuthToken(isInteractive);

  // ── 4. Push each lesson to Google Calendar ────────────────
  let addedCount = 0;
  let skippedCount = 0;

  for (const lesson of lessons) {
    // Build a minimal Calendar event.  Including the course name
    // in the description helps when a user has multiple batches.
    const gCalEvent = {
      summary: lesson.title,
      description:
        `Instructor: ${lesson.instructors_name}\n` +
        `Course: ${lesson.super_batch_name}`,
      start: { dateTime: lesson.date },
      end: { dateTime: lesson.end_time },
    };

    console.log(`[Scaler++ Calendar]   → "${lesson.title}"`);

    // Check if this class already exists in Google Calendar
    const searchRes = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events` +
        `?q=${encodeURIComponent(lesson.title)}` +
        `&timeMin=${new Date(lesson.date).toISOString()}` +
        `&timeMax=${new Date(lesson.end_time).toISOString()}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const searchData = await searchRes.json();
    if (searchData.items?.length > 0) {
      console.log(`[Scaler++ Calendar]   ⏭ Already exists: "${lesson.title}"`);
      skippedCount++;
      continue;
    }

    try {
      const gCalRes = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(gCalEvent),
        },
      );

      if (gCalRes.ok) {
        console.log(`[Scaler++ Calendar]   ✓ Added: "${lesson.title}"`);
        addedCount++;
      } else {
        // Log the exact Google error reason and continue — a single
        // bad event (e.g. duplicate, malformed date) should not
        // abort the rest of the sync run.
        const errorBody = await gCalRes.text();
        console.error(
          `[Scaler++ Calendar]   ✗ Google rejected "${lesson.title}" ` +
            `(HTTP ${gCalRes.status}): ${errorBody}`,
        );
        skippedCount++;
      }
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
      `${addedCount} added, ${skippedCount} skipped.`,
  );
}
