// ============================================================
// background/companionBypass.js — Smart Companion Bypass
// ─────────────────────────────────────────────────────────────
// Loaded by background.js via importScripts().
// Activates IP-spoofing declarativeNetRequest headers for ~5 s
// whenever the user navigates to a /session?joinSession=1 URL,
// then automatically removes them — keeping the browser fast
// the rest of the time.
// ============================================================

const BYPASS_RULE_IDS = [101, 102, 103, 104, 105, 106]; // IDs offset from 100 to avoid clashes
const BYPASS_DURATION_MS = 5000; // how long rules stay active (ms)

let _bypassTimer = null; // active auto-deactivation timer handle

// Spoofed IP pool (RFC-5737 test ranges + real CDN IPs)
const SPOOFED_IPS = {
  primary: "203.0.113.195",
  secondary: "198.51.100.1",
  tertiary: "192.0.2.1",
  india: "103.21.125.1",
  usa: "104.16.0.1",
  uk: "31.55.185.1",
  germany: "46.4.0.1",
  japan: "133.242.0.1",
};

/** Returns a random IP from the pool. */
function _randomIP() {
  const keys = Object.keys(SPOOFED_IPS);
  return SPOOFED_IPS[keys[Math.floor(Math.random() * keys.length)]];
}

/**
 * Build a single declarativeNetRequest rule that sets one request header.
 * @param {number} id      - Rule ID (must be unique across all dynamic rules)
 * @param {string} header  - Header name  e.g. "X-Forwarded-For"
 * @param {string} value   - Header value
 */
function _makeHeaderRule(id, header, value) {
  return {
    id,
    priority: 10,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header, operation: "set", value }],
    },
    condition: {
      urlFilter: "||scaler.com^",
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "stylesheet",
        "script",
        "image",
        "font",
        "object",
        "xmlhttprequest",
        "ping",
        "csp_report",
        "media",
        "websocket",
        "other",
      ],
    },
  };
}

/**
 * Inject all 6 IP-spoofing rules with a freshly-picked random IP.
 * Removes any stale rules first to prevent ID collisions.
 */
async function activateCompanionBypass() {
  const ip = _randomIP();

  const rules = [
    _makeHeaderRule(101, "X-Forwarded-For", ip),
    _makeHeaderRule(102, "X-Real-IP", ip),
    _makeHeaderRule(103, "X-Client-IP", ip),
    _makeHeaderRule(104, "CF-Connecting-IP", ip),
    _makeHeaderRule(105, "X-Forwarded-Proto", "https"),
    _makeHeaderRule(106, "X-Forwarded-Host", "www.scaler.com"),
  ];

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: BYPASS_RULE_IDS,
    });
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
    console.log("[Scaler++ Bypass] Rules activated with IP:", ip);
  } catch (e) {
    console.error("[Scaler++ Bypass] Failed to activate rules:", e);
  }
}

/**
 * Remove all bypass rules — restores normal browser performance.
 */
async function deactivateCompanionBypass() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: BYPASS_RULE_IDS,
    });
    console.log(
      "[Scaler++ Bypass] Rules deactivated — browser back to normal.",
    );
  } catch (e) {
    console.error("[Scaler++ Bypass] Failed to deactivate rules:", e);
  }
}

/**
 * Activate bypass for BYPASS_DURATION_MS, then auto-deactivate.
 * If called while already active, the timer is reset (handles double-clicks).
 */
async function triggerBypass() {
  if (_bypassTimer !== null) {
    clearTimeout(_bypassTimer);
    _bypassTimer = null;
  }

  await activateCompanionBypass();

  _bypassTimer = setTimeout(async () => {
    await deactivateCompanionBypass();
    _bypassTimer = null;
  }, BYPASS_DURATION_MS);
}

// ── Cold-start safety net: clear stranded bypass rules ──
// The 5 s auto-deactivate in triggerBypass() lives in a setTimeout, which —
// unlike the dynamic DNR rules it is meant to remove — does NOT survive a
// service-worker restart. MV3 can terminate this worker at any point during the
// 5 s window (a pending setTimeout does not keep the worker alive). The timer
// then dies, but the IP-spoofing headers persist and would stay attached to
// EVERY scaler.com request indefinitely.
//
// This top-level call runs on every worker cold start (the worker script is
// re-evaluated each time it wakes). At that instant no bypass from the CURRENT
// worker is active yet, so it can only ever remove rules orphaned by a
// previously-killed worker — never a live window. And because the remove call
// is dispatched synchronously here (before any awaited work), it is ordered
// ahead of any same-wake activation from the onUpdated handler below, so it
// cannot race-clear a freshly-added rule. This covers every restart path
// (browser launch, extension update, and a plain event-driven wake) — which
// onStartup/onInstalled alone would miss.
deactivateCompanionBypass();

/**
 * Listen for tab navigations.
 * Fires triggerBypass() when a join-session URL is detected and the
 * companion-bypass setting is enabled.
 */
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Only act on fully completed navigations that have a URL
  if (changeInfo.status !== "complete" || !tab.url) return;

  const isJoinSessionUrl =
    tab.url.includes("scaler.com") &&
    tab.url.includes("/session") &&
    tab.url.includes("joinSession=1");

  if (!isJoinSessionUrl) return;

  try {
    const result = await chrome.storage.sync.get("cleanerSettings");
    const settings = result.cleanerSettings || {};
    const bypassEnabled = settings["companion-bypass"] !== false; // default ON

    if (bypassEnabled) {
      console.log(
        "[Scaler++ Bypass] Join session detected — activating bypass.",
      );
      await triggerBypass();
    }
  } catch (e) {
    console.error("[Scaler++ Bypass] Error reading settings:", e);
  }
});
