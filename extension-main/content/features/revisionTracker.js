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

// ─── DOM ──────────────────────────────────────────────────────

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _injectPanel(dueProblems) {
  const anchor =
    document.querySelector("main") ||
    document.body;

  const count = dueProblems.length;
  const collapsed =
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem("scalerpp_revision_collapsed") === "true";

  const itemsHtml =
    count === 0
      ? '<p class="srp-empty">Nothing due today ✓</p>'
      : dueProblems
          .map(
            (p) =>
              `<div class="srp-item" data-pid="${_escapeHtml(p.id)}">` +
              `<span class="srp-item-title">${_escapeHtml(p.title)}</span>` +
              `<button class="srp-revisit-btn" data-pid="${_escapeHtml(p.id)}" ` +
              `data-url="${_escapeHtml(p.url)}">Revisit</button></div>`
          )
          .join("");

  const panel = document.createElement("div");
  panel.className = "scaler-revision-panel";
  panel.setAttribute(PANEL_ATTR, "true");
  panel.innerHTML =
    `<div class="srp-header">` +
    `<span class="srp-title">📚 Revise Today${count > 0 ? ` (${count})` : ""}</span>` +
    `<button class="srp-toggle" aria-label="Toggle panel">${collapsed ? "+" : "−"}</button>` +
    `</div>` +
    `<div class="srp-body${collapsed ? " srp-hidden" : ""}">${itemsHtml}</div>`;

  anchor.prepend(panel);

  panel.querySelector(".srp-toggle").addEventListener("click", () => {
    const body = panel.querySelector(".srp-body");
    const isNowCollapsed = body.classList.toggle("srp-hidden");
    panel.querySelector(".srp-toggle").textContent = isNowCollapsed ? "+" : "−";
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("scalerpp_revision_collapsed", String(isNowCollapsed));
    }
  });

  panel.querySelectorAll(".srp-revisit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.pid;
      const url = btn.dataset.url || "https://www.scaler.com/academy";
      window.open(url, "_blank");
      try {
        const log = await _readLog();
        if (!log[pid]) return;
        const updated = _advanceStage(log[pid]);
        if (updated === null) {
          delete log[pid];
        } else {
          log[pid] = updated;
        }
        await _writeLog(log);

        const item = panel.querySelector(`.srp-item[data-pid="${pid}"]`);
        if (item) item.remove();

        const remaining = panel.querySelectorAll(".srp-revisit-btn").length;
        const titleEl = panel.querySelector(".srp-title");
        if (titleEl) {
          titleEl.textContent =
            `📚 Revise Today${remaining > 0 ? ` (${remaining})` : ""}`;
        }
        if (remaining === 0) {
          const body = panel.querySelector(".srp-body");
          if (body) body.innerHTML = '<p class="srp-empty">Nothing due today ✓</p>';
        }
      } catch (e) {
        console.warn("[Scaler++ Revision] Failed to update log:", e);
      }
    });
  });
}

// ─── Main entry point ─────────────────────────────────────────

async function initRevisionTracker() {
  if (!isExtensionValid()) return;
  if (typeof currentSettings !== "undefined" && !currentSettings["revision-tracker"]) return;
  if (document.querySelector(`[${PANEL_ATTR}]`)) return;

  // Only inject on the main Scaler dashboard / todos page
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
