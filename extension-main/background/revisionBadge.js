// ============================================================
// revisionBadge.js — keeps the extension icon badge in sync
// with the number of Smart Revision problems due today.
// ============================================================

const _REVISION_LOG_KEY = "scalerpp_revision_log";

function _updateRevisionBadge() {
  chrome.storage.local.get(_REVISION_LOG_KEY, (result) => {
    if (chrome.runtime.lastError) return;
    const log = result[_REVISION_LOG_KEY] || {};
    const now = Date.now();
    const due = Object.values(log).filter((e) => e.nextDue <= now).length;
    chrome.action.setBadgeText({ text: due > 0 ? String(due) : "" });
    if (due > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#5865f2" });
    }
  });
}

// Sync badge on service-worker startup
_updateRevisionBadge();

// Reactively update whenever the revision log changes (new solve detected or revisit clicked)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && _REVISION_LOG_KEY in changes) {
    _updateRevisionBadge();
  }
});
