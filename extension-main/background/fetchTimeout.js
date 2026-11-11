// ============================================================
// background/fetchTimeout.js
// fetch with a timeout, for every request the service worker makes.
// ─────────────────────────────────────────────────────────────
// A plain fetch has no timeout: a stuck backend or LLM held the message
// port open until Chrome killed the worker (~5 min), and the page sat on a
// spinner the whole time. Loaded first by background.js.
// ============================================================

// Backend, Google Calendar, Scaler and LeetCode requests.
const BG_FETCH_TIMEOUT_MS = 20000;
// LLM summary calls on a long transcript are legitimately slow; stay under
// Chrome's ~5 min limit per service-worker event.
const BG_LLM_FETCH_TIMEOUT_MS = 270000;

/**
 * fetch(), aborted after `timeoutMs` (the body read included). A caller that
 * passes its own `signal` keeps it unchanged. A timeout rejects with a
 * TimeoutError, which callers' existing catch paths already handle.
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {number} [timeoutMs]
 * @returns {Promise<Response>}
 */
function bgFetch(url, options = {}, timeoutMs = BG_FETCH_TIMEOUT_MS) {
  if (options.signal || typeof AbortSignal === "undefined" || !AbortSignal.timeout) {
    return fetch(url, options);
  }
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
}
