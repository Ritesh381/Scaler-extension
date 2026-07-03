// ============================================================
// usernameTracker.js — Fetches and synchronizes user profile
// ============================================================

// Bump this number whenever new fields are added to the payload.
// All existing users will automatically re-sync on next page load.
const SYNC_VERSION = 9;

function initUsernameTracker() {
  if (typeof chrome === "undefined" || !chrome.runtime?.id) return;

  // To force a re-sync during dev, uncomment:
  // chrome.storage.sync.remove("scaler_sync_version");

  // Always fetch both version AND user so we can ping on every load
  chrome.storage.sync.get(["scaler_sync_version", "scaler_user"], (result) => {
    if (chrome.runtime.lastError || !chrome.runtime?.id) return;

    // Always ping if we have a stored email — regardless of sync version
    if (result?.scaler_user?.email) {
      pingUser(result.scaler_user.email);
    }

    // Only skip full profile sync if version already matches
    if (result?.scaler_sync_version === SYNC_VERSION) return;

    fetchAndSyncUser();
  });
}

function pingUser(email) {
  if (!chrome.runtime?.id) return;
  chrome.runtime.sendMessage({ action: "pingUser", email });
}

function fetchAndSyncUser() {
  if (!chrome.runtime?.id) return;

  const BASE = "https://www.scaler.com";
  const opts = { credentials: "include" };

  Promise.all([
    fetch(`${BASE}/analytics/`, opts).then((r) => (r.ok ? r.json() : null)),
    fetch(`${BASE}/academy/mentee/performance-stats/`, opts).then((r) =>
      r.ok ? r.json() : null,
    ),
    fetch(`${BASE}/academy/mentee-dashboard/initial-load-data/`, opts).then(
      (r) => (r.ok ? r.json() : null),
    ),
  ])
    .then(([analyticsJson, perfJson, loadJson]) => {
      if (!chrome.runtime?.id) return;

      // ── /analytics/ ─────────────────────────────────────
      const attr = analyticsJson?.data?.attributes;
      if (!attr) return;

      // ── /performance-stats/ ──────────────────────────────
      const perf = perfJson?.performance;

      // ── /initial-load-data/ ──────────────────────────────
      const currentUser = loadJson?.user_data?.current_user;
      const role = loadJson?.user_data?.role;
      const country = loadJson?.user_data?.super_batch?.country;

      const user = {
        // from /analytics/
        scaler_id: attr.id,
        name: attr.name,
        gender: attr.gender,
        email: attr.email,
        orgyear: attr.orgyear,
        cohort: attr.cohort,

        // from /initial-load-data/
        linkedin_profile: currentUser?.linkedin_profile ?? null,
        slug: currentUser?.slug ?? null,
        role: role ?? null,
        country: country ?? null,
        avatar_file_name: currentUser?.avatar_file_name ?? null,
        // phone_number: currentUser?.phone_number ?? null,

        // from /performance-stats/
        cgr_score: perf?.cgrScore ?? null,
      };

      chrome.runtime.sendMessage(
        { action: "syncUserProfile", user },
        (response) => {
          if (response && response.success) {
            chrome.storage.sync.set({
              scaler_sync_version: SYNC_VERSION,
              scaler_user: {
                name: user.name,
                gender: user.gender,
                email: user.email,
              },
            });
            // Also ping immediately after sync
            pingUser(user.email);
          }
        },
      );
    })
    .catch(() => {
      /* fail silently */
    });
}
