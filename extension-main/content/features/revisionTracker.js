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

// Expose for tests
window._detectNewSolves = _detectNewSolves;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._buildEntry = _buildEntry;
