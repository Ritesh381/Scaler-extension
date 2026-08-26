// ============================================================
// content/features/revisionTracker.js — Smart Revision
// Storage + scheduling logic for the user-controlled revision queue.
// Problems are added manually via the "Mark for Revision" button
// on problem pages (revisionMarker.js), not auto-detected.
// Queue is displayed in the extension popup + icon badge.
// ============================================================

const REVISION_LOG_KEY = "scalerpp_revision_log";
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_INTERVALS = [1, 3, 7, 14, 30]; // days

// ─── Storage ──────────────────────────────────────────────────

function _readLog() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(REVISION_LOG_KEY, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result[REVISION_LOG_KEY] || {});
    });
  });
}

function _writeLog(log) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [REVISION_LOG_KEY]: log }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ─── Pure helpers ─────────────────────────────────────────────

function _buildEntry(title, url, ib_problem_id) {
  const now = Date.now();
  return {
    title: title || `Problem #${ib_problem_id}`,
    url,
    ib_problem_id: String(ib_problem_id),
    solvedAt: now,
    intervals: [...REVISION_INTERVALS],
    stage: 0,
    nextDue: now + REVISION_INTERVALS[0] * DAY_MS,
  };
}

function _getDueToday(log) {
  const now = Date.now();
  return Object.entries(log)
    .filter(([, entry]) => entry.nextDue <= now)
    .map(([id, entry]) => ({ id, ...entry }));
}

// Returns updated entry, or null when all intervals exhausted (graduated).
function _advanceStage(entry) {
  const nextStage = entry.stage + 1;
  if (nextStage >= entry.intervals.length) return null;
  return {
    ...entry,
    stage: nextStage,
    nextDue: Date.now() + entry.intervals[nextStage] * DAY_MS,
  };
}

// ─── Public API (called by revisionMarker.js) ─────────────────

// Adds a problem to the revision queue. Returns true if added, false if already present.
async function markProblemForRevision(title, url, ib_problem_id) {
  if (!isExtensionValid()) return false;
  try {
    const log = await _readLog();
    const id = String(ib_problem_id);
    if (log[id]) return false;
    log[id] = _buildEntry(title, url, ib_problem_id);
    await _writeLog(log);
    return true;
  } catch (e) {
    console.warn("[Scaler++ Revision] Failed to mark problem:", e);
    return false;
  }
}

window.markProblemForRevision = markProblemForRevision;

// Expose for tests
window._buildEntry = _buildEntry;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._readLog = _readLog;
window._writeLog = _writeLog;
