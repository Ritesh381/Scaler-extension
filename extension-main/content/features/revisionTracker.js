// ============================================================
// content/features/revisionTracker.js — Smart Revision
// Detect solved Scaler problems and schedule spaced revision.
// ============================================================

const REVISION_LOG_KEY = "scalerpp_revision_log";
const REVISION_SEEDED_KEY = "scalerpp_revision_seeded";
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

function _buildEntry(apiProblem, nextDue) {
  const now = Date.now();
  return {
    title: apiProblem.title,
    url: _buildProblemUrl(apiProblem),
    solvedAt: now,
    intervals: [...REVISION_INTERVALS],
    stage: 0,
    nextDue: nextDue !== undefined ? nextDue : now + REVISION_INTERVALS[0] * DAY_MS,
  };
}

// Matches any non-null, non-"unsolved" status so we catch "solved", "completed", etc.
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

// ─── Session state ────────────────────────────────────────────
let _problemsCache = null;
// Track the URL where panel was last injected; prevents multiple panels on SPA nav.
let _lastInjectedUrl = null;

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

  // Only inject on the main Scaler dashboard / todos page
  if (!location.href.includes("/academy/mentee-dashboard")) return;
  if (location.pathname.includes("/problems/") || location.pathname.includes("/class/")) return;

  // URL-keyed guard: if panel was already injected for this exact URL, skip.
  // Using URL (not a DOM attribute) so Scaler SPA DOM replacement can't fool us.
  if (_lastInjectedUrl === location.href) return;

  // Remove any stale panel left from a previous URL if Scaler didn't clean up.
  document.querySelector(`[${PANEL_ATTR}]`)?.remove();

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
        // nextDue = now so they appear immediately in today's queue
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

  const due = _getDueToday(log);
  _injectPanel(due);
  _lastInjectedUrl = location.href;
}

window.initRevisionTracker = initRevisionTracker;

// Expose for tests
window._detectNewSolves = _detectNewSolves;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._buildEntry = _buildEntry;
