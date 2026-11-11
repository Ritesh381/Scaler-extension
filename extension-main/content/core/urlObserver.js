// ============================================
// core/urlObserver.js
// SPA URL change detection and routing hooks
// ============================================

// Debounce timer for URL change handler — prevents thundering-herd of
// callbacks when the SPA fires many mutations in a short burst.
let _urlChangeDebounceTimer = null;

// Feature re-init callbacks, run once per actual URL change (see onUrlChange).
const _urlChangeHooks = [];

/**
 * Register a callback for SPA navigation. It runs once per real URL change,
 * after the debounce — never for a replaceState that kept the same URL.
 * @param {() => void} fn
 */
function onUrlChange(fn) {
  _urlChangeHooks.push(fn);
}

/**
 * Handle URL changes (SPA navigation).
 * Debounced — multiple rapid calls collapse into a single execution.
 */
function handleUrlChange() {
  clearTimeout(_urlChangeDebounceTimer);
  _urlChangeDebounceTimer = setTimeout(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    setTimeout(runCleanup, 1500);
    setTimeout(runCleanup, 3000);
    for (const hook of _urlChangeHooks) {
      try {
        hook();
      } catch (error) {
        console.error("[Scaler++] URL change hook failed:", error);
      }
    }
  }, 300);
}

/**
 * Setup URL change detection
 */
function setupUrlChangeDetection() {
  if (window._scalerUrlDetectionSetUp) return;
  window._scalerUrlDetectionSetUp = true;

  window.addEventListener("popstate", () => handleUrlChange());

  // Content scripts run in an isolated world, so patching history.pushState
  // here never sees the page's own navigations. Instead, watch for the DOM
  // churn that follows one: the check is a string compare, and
  // handleUrlChange is debounced.
  let _mutationDebounceTimer = null;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      clearTimeout(_mutationDebounceTimer);
      _mutationDebounceTimer = setTimeout(handleUrlChange, 150);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window._scalerUrlObserver = observer;

  // The Navigation API (Chrome 102+) reports the page's navigations directly.
  // Once it has proven itself with one event, the body-wide observer above is
  // dead weight on every DOM change, so drop it.
  if (window.navigation && typeof window.navigation.addEventListener === "function") {
    window.navigation.addEventListener("currententrychange", () => {
      if (window._scalerUrlObserver) {
        window._scalerUrlObserver.disconnect();
        window._scalerUrlObserver = null;
        clearTimeout(_mutationDebounceTimer);
      }
      handleUrlChange();
    });
  }
}
