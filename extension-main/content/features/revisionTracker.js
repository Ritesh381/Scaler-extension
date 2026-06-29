// ============================================================
// content/features/revisionTracker.js — Smart Revision
// Detect solved Scaler problems and schedule spaced revision.
// Queue is shown in the extension popup, NOT injected into the page.
// ============================================================

const REVISION_LOG_KEY = "scalerpp_revision_log";
const REVISION_SEEDED_KEY = "scalerpp_revision_seeded";
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

// The problems-data API uses inconsistent field names across versions.
// Try known candidates; fall back to a stable "Problem #ID" label.
function _getProblemTitle(p) {
  return (
    p.name ||
    p.problem_name ||
    p.title ||
    p.heading ||
    `Problem #${p.ib_problem_id}`
  );
}

function _buildEntry(apiProblem, nextDue) {
  const now = Date.now();
  return {
    title: _getProblemTitle(apiProblem),
    url: _buildProblemUrl(apiProblem),
    solvedAt: now,
    intervals: [...REVISION_INTERVALS],
    stage: 0,
    nextDue: nextDue !== undefined ? nextDue : now + REVISION_INTERVALS[0] * DAY_MS,
  };
}

// Matches any non-null, non-"unsolved" status to catch all Scaler API variants.
function _detectNewSolves(apiProblems, log) {
  return apiProblems.filter(
    (p) =>
      p.status != null &&
      p.status !== "unsolved" &&
      !log[String(p.ib_problem_id)]
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

function _readSeeded() {
  return new Promise((resolve) => {
    chrome.storage.local.get(REVISION_SEEDED_KEY, (result) => {
      resolve(!!result[REVISION_SEEDED_KEY]);
    });
  });
}

function _markSeeded() {
  chrome.storage.local.set({ [REVISION_SEEDED_KEY]: true });
}

// ─── Main entry point (detection only — no DOM injection) ─────

async function initRevisionTracker() {
  if (!isExtensionValid()) return;
  if (typeof currentSettings !== "undefined" && !currentSettings["revision-tracker"]) return;

  // Only run detection on the Scaler dashboard (not on problem/class pages)
  if (!location.href.includes("/academy/mentee-dashboard")) return;
  if (location.pathname.includes("/problems/") || location.pathname.includes("/class/")) return;

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

  // One-time backfill: seed ALL already-solved problems as immediately due
  // so students who installed the extension after solving see them right away.
  const alreadySeeded = await _readSeeded().catch(() => false);
  if (!alreadySeeded) {
    const allSolved = apiProblems.filter(
      (p) => p.status != null && p.status !== "unsolved"
    );
    allSolved.forEach((p) => {
      const id = String(p.ib_problem_id);
      if (!log[id]) {
        log[id] = _buildEntry(p, Date.now());
      }
    });
    try {
      await _writeLog(log);
      _markSeeded();
    } catch (e) {
      console.warn("[Scaler++ Revision] Backfill write failed:", e);
    }
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
  // Badge is updated reactively by background/revisionBadge.js via storage.onChanged
}

window.initRevisionTracker = initRevisionTracker;

// Expose for tests
window._detectNewSolves = _detectNewSolves;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._buildEntry = _buildEntry;
window._getProblemTitle = _getProblemTitle;
