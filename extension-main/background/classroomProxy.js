// ============================================================
// classroomProxy.js — Proxy for the crowdsourced classroom tags
// ─────────────────────────────────────────────────────────────
// Runs in the service worker for two reasons: CORS (the content script's
// origin is scaler.com), and secrecy — the shared bearer token never enters a
// page context this way.
// ============================================================

// Base URL for the backend API (toggle for dev / prod).
//
// The classroom routes must be DEPLOYED for this to work: an undeployed backend
// answers /api/classroom/* with 404, which the UI shows as an unreachable vote
// server. For local work use the storage override below rather than editing
// this line — _classroomBaseUrl() warns on every worker start while a
// non-HTTPS base is in use, so a dev URL cannot ship unnoticed.
const CLASSROOM_BACKEND_BASE_URL = "https://scalerbackend.vercel.app";
// const CLASSROOM_BACKEND_BASE_URL = "http://localhost:3001";

// Overrides the constant above without editing this file:
//   chrome.storage.local.set({ scalerpp_backend_override: "http://localhost:3001" })
// Set it from an EXTENSION context (service worker console), not the page
// console — the page has no chrome.storage. Needs the matching host permission.
const CLASSROOM_BACKEND_OVERRIDE_KEY = "scalerpp_backend_override";

/** Warn once per worker lifetime, not once per request. */
let _classroomBaseAnnounced = false;

const CLASSROOM_EXTENSION_TOKEN =
  "Ritesh-Prajapati-created-started-this-extension-super-secret-key-12345";

/** Resolve the base URL, honouring a dev override if one is stored. */
async function _classroomBaseUrl() {
  let base = CLASSROOM_BACKEND_BASE_URL;
  let source = "built-in default";

  try {
    const stored = await chrome.storage.local.get(CLASSROOM_BACKEND_OVERRIDE_KEY);
    const override = stored?.[CLASSROOM_BACKEND_OVERRIDE_KEY];
    if (override && /^https?:\/\//.test(override)) {
      base = String(override).replace(/\/+$/, "");
      source = "scalerpp_backend_override";
    }
  } catch (_err) {
    // storage unavailable — keep the compiled-in default
  }

  // Silent on the happy path — a published build must not chatter in the
  // service worker console. Only an unusual base is worth announcing.
  if (!_classroomBaseAnnounced && (source !== "built-in default" || !base.startsWith("https://"))) {
    _classroomBaseAnnounced = true;
    console.warn(`Scaler++: classroom API → ${base} (${source})`);
  }

  return base;
}

/**
 * One request, with the refusal reason preserved.
 *
 * A refused vote (window closed, already changed once, daily cap) comes back as
 * a 409 with a machine-readable `error`. Collapsing that into "HTTP 409" would
 * leave the UI unable to explain itself, so the body is read on failure too.
 */
async function _classroomFetch(path, body) {
  const base = await _classroomBaseUrl();

  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CLASSROOM_EXTENSION_TOKEN}`,
    },
    body: JSON.stringify(body),
  });

  let payload = null;
  try {
    payload = await res.json();
  } catch (_err) {
    payload = null;
  }

  if (!res.ok) {
    const reason = payload?.error || `HTTP ${res.status}`;
    throw new Error(reason);
  }

  return payload;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Room state for every visible class card, in one round trip ────────────
  if (message.action === "fetchClassroomStates") {
    _classroomFetch("/api/classroom/states", {
      email: message.email || "",
      classes: Array.isArray(message.classes) ? message.classes : [],
    })
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.warn("Scaler++: Error fetching classroom states:", error.message);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }

  // ── Cast or change one vote ──────────────────────────────────────────────
  if (message.action === "voteClassroom") {
    const meta = message.meta || {};

    _classroomFetch(
      `/api/classroom/${encodeURIComponent(message.classId || "")}/vote`,
      {
        email: message.email || "",
        // null is a withdrawal and has to reach the server as null, not "".
        room: message.room == null ? null : message.room,
        subject: meta.subject || null,
        batch: meta.batch || null,
        lectureTitle: meta.lectureTitle || null,
        classDate: meta.classDate || null,
        startsAt: meta.startsAt || null,
        endsAt: meta.endsAt || null,
      },
    )
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.warn("Scaler++: Error voting on classroom:", error.message);
        sendResponse({ success: false, error: error.message });
      });

    return true;
  }
});
