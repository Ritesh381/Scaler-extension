// ============================================================
// content/features/revisionTracker.js — Smart Revision
// Detect solved Scaler problems and schedule spaced revision.
// ============================================================

const REVISION_LOG_KEY = "scalerpp_revision_log";
const PANEL_ATTR = "data-revision-injected";
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_INTERVALS = [1, 3, 7, 14, 30]; // days

// ─── Pure helpers ─────────────────────────────────────────────

function _buildProblemUrl(p) {
  const segment = p.type === "assignment" ? "assignment" : "homework";
  return (
    `https://www.scaler.com/academy/mentee-dashboard/class/` +
    `${p.sbat_id}/${segment}/problems/${p.ib_problem_id}`
  );
}

function _buildEntry(apiProblem) {
  const now = Date.now();
  return {
    title: apiProblem.title,
    url: _buildProblemUrl(apiProblem),
    solvedAt: now,
    intervals: [...REVISION_INTERVALS],
    stage: 0,
    nextDue: now + REVISION_INTERVALS[0] * DAY_MS,
  };
}

function _detectNewSolves(apiProblems, log) {
  return apiProblems.filter(
    (p) => p.status === "solved" && !log[String(p.ib_problem_id)]
  );
}

function _getDueToday(log) {
  const now = Date.now();
  return Object.entries(log)
    .filter(([, entry]) => entry.nextDue <= now)
    .map(([id, entry]) => ({ id, ...entry }));
}

// Returns updated entry, or null when all intervals are exhausted (graduated).
function _advanceStage(entry) {
  const nextStage = entry.stage + 1;
  if (nextStage >= entry.intervals.length) return null;
  return {
    ...entry,
    stage: nextStage,
    nextDue: Date.now() + entry.intervals[nextStage] * DAY_MS,
  };
}

// ─── Session cache ────────────────────────────────────────────
let _problemsCache = null;

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

// ─── DOM (implemented in Task 3) ──────────────────────────────
function _injectPanel(dueProblems) {
  // stub — full implementation in Task 3
}

// ─── Main entry point ─────────────────────────────────────────

async function initRevisionTracker() {
  if (!isExtensionValid()) return;
  if (typeof currentSettings !== "undefined" && !currentSettings["revision-tracker"]) return;
  if (document.querySelector(`[${PANEL_ATTR}]`)) return;

  if (!_problemsCache) {
    try {
      const res = await fetch(
        "https://www.scaler.com/academy/mentee/problems-data",
        { credentials: "include" }
      );
      if (!res.ok) return;
      _problemsCache = await res.json();
    } catch {
      return;
    }
  }

  const apiProblems = Object.values(_problemsCache.problems || {});

  let log;
  try {
    log = await _readLog();
  } catch {
    log = {};
  }

  const newSolves = _detectNewSolves(apiProblems, log);
  if (newSolves.length > 0) {
    newSolves.forEach((p) => {
      log[String(p.ib_problem_id)] = _buildEntry(p);
    });
    try {
      await _writeLog(log);
    } catch (e) {
      console.warn("[Scaler++ Revision] Storage write failed:", e);
    }
  }

  const due = _getDueToday(log);
  _injectPanel(due);
}

window.initRevisionTracker = initRevisionTracker;

// Expose for tests
window._detectNewSolves = _detectNewSolves;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._buildEntry = _buildEntry;
