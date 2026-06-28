// ============================================================
// messagesProxy.js — Proxy for fetching messages from backend
// Bypasses content script CORS restrictions by making the
// fetch request from the background service worker context.
// ============================================================

// Base URL for the backend API (toggle for dev / prod)
const BACKEND_BASE_URL = "https://scalerbackend.vercel.app";
// const BACKEND_BASE_URL = "http://localhost:3001";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Fetch custom messages ────────────────────────────────
  if (message.action === "fetchCustomMessages") {
    fetch(`${BACKEND_BASE_URL}/api/messages/active`)
      .then((res) => res.json())
      .then((data) => {
        sendResponse(data);
      })
      .catch((error) => {
        console.error("Scaler++: Error fetching from backend", error);
        sendResponse({ success: false, error: error.toString() });
      });

    // Return true to indicate we wish to send a response asynchronously
    return true;
  }

  // ── Sync user profile to backend ─────────────────────────
  if (message.action === "syncUserProfile") {
    fetch(`${BACKEND_BASE_URL}/api/messages/sync-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message.user),
    })
      .then((res) => res.json())
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        // Shh... fail silently as per user request
        sendResponse({ success: false, error: error.toString() });
      });

    return true;
  }

  // ── Ping user activity (Last Seen) ──────────────────────────
  // Fire-and-forget — same pattern as /api/messages/active.
  // No sendResponse needed; the content script doesn't await a reply.
  if (message.action === "pingUser") {
    fetch(`${BACKEND_BASE_URL}/api/users/ping`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: message.email }),
    }).catch(() => {
      /* fail silently */
    });

    // No return true — we're not sending a response
  }

  // ── Track download usage (video / audio / transcript) ────────
  // Fire-and-forget — increments the counter in Supabase.
  if (message.action === "trackDownload") {
    fetch(`${BACKEND_BASE_URL}/api/users/download`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: message.email,
        type: message.downloadType,
        lecture: message.lecture,
        lectureSlug: message.lectureSlug || "",
      }),
    }).catch(() => {
      /* fail silently */
    });

    // No return true — fire-and-forget
  }

  // ── Proxy button click to backend ────────────────────────
  // Content scripts can't make cross-origin requests to our
  // backend, so we relay them through the service worker.
  // message shape:
  //   { action: "proxyButtonClick", endpoint: "/api/messages/button-click",
  //     method: "POST", body: { ... } }
  if (message.action === "proxyButtonClick") {
    const url = `${BACKEND_BASE_URL}${message.endpoint}`;
    const method = (message.method || "POST").toUpperCase();

    const fetchOptions = {
      method,
      headers: { "Content-Type": "application/json" },
    };

    // Only attach a body for methods that support one
    if (method !== "GET" && method !== "HEAD" && message.body) {
      fetchOptions.body = JSON.stringify(message.body);
    }

    fetch(url, fetchOptions)
      .then((res) => res.json())
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        console.error("Scaler++: Error proxying button click", error);
        sendResponse({ success: false, error: error.toString() });
      });

    return true;
  }

  // ── Check transcript cache ───────────────────────────────────
  if (message.action === "checkTranscriptCache") {
    fetch(`${BACKEND_BASE_URL}/api/transcript?slug=${encodeURIComponent(message.slug)}`, {
      method: "GET",
      headers: { Authorization: "Bearer Ritesh-Prajapati-created-started-this-extension-super-secret-key-12345" },
    })
      .then((res) => res.ok ? res.json() : { cached: false })
      .then((data) => {
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        console.error("Scaler++: Error checking transcript cache", error);
        sendResponse({ success: false, error: error.toString() });
      });
      
    return true;
  }

  // ── Save transcript to backend cache ────────────────────────
  // Handled here in the service worker so the save completes even
  // if the transcriptProcessor tab is closed right after the download
  // triggers (fire-and-forget from a page context would be aborted).
  if (message.action === "saveTranscriptToCache") {
    fetch(`${BACKEND_BASE_URL}/api/transcript/save`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer Ritesh-Prajapati-created-started-this-extension-super-secret-key-12345",
      },
      body: JSON.stringify({
        slug: (message.slug || "").trim(),
        title: (message.title || message.slug || "").trim(),
        text: (message.text || "").trim(),
        classId: (message.classId || "").toString().trim(),
        generatedBy: message.generatedBy || "",
      }),
    })
      .then((res) => {
        if (!res.ok) console.warn("Scaler++: Backend rejected transcript save:", res.status);
        else console.log("Scaler++: Transcript saved to cache for key:", message.slug);
      })
      .catch((error) => {
        console.warn("Scaler++: Failed to save transcript to cache:", error.message);
      });

    // Fire-and-forget — no sendResponse needed.
  }
});
