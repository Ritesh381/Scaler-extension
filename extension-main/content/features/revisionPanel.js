// ============================================================
// content/features/revisionPanel.js — Smart Revision
// Injects a "Revise Today" panel into the mentee dashboard
// sidebar, above the Performance section.
// ============================================================

const REVISION_PANEL_ID = "scaler-revision-panel-sidebar";
const REVISION_PANEL_ATTR = "data-srp-injected";

// ─── Helpers ──────────────────────────────────────────────────

function _srpEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _srpReadLog() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get("scalerpp_revision_log", (result) => {
        resolve((result && result["scalerpp_revision_log"]) || {});
      });
    } catch {
      resolve({});
    }
  });
}

function _srpWriteLog(log) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ scalerpp_revision_log: log }, resolve);
    } catch {
      resolve();
    }
  });
}

function _srpAdvanceStage(entry) {
  const nextStage = entry.stage + 1;
  if (nextStage >= entry.intervals.length) return null; // graduated
  return {
    ...entry,
    stage: nextStage,
    nextDue: Date.now() + entry.intervals[nextStage] * 24 * 60 * 60 * 1000,
  };
}

// ─── Panel rendering ──────────────────────────────────────────

function _srpRenderItems(due, listEl, countEl) {
  if (countEl) countEl.textContent = `${due.length} due today`;

  listEl.innerHTML = due
    .map(
      (p) =>
        `<div class="srp-item" data-pid="${_srpEscape(p.id)}">` +
        `<span class="srp-item-title" title="${_srpEscape(p.title || "Problem #" + p.id)}">${_srpEscape(p.title || "Problem #" + p.id)}</span>` +
        `<button class="srp-revisit-btn" data-pid="${_srpEscape(p.id)}" data-url="${_srpEscape(p.url || "https://www.scaler.com/academy")}">Revisit</button>` +
        `</div>`
    )
    .join("");

  listEl.querySelectorAll(".srp-revisit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.pid;
      const url = btn.dataset.url;

      // Open problem in new tab. "noopener" matters: without it the new tab
      // keeps a live window.opener handle back to the dashboard.
      window.open(url, "_blank", "noopener");

      // Advance stage in storage
      try {
        const log = await _srpReadLog();
        if (log[pid]) {
          const advanced = _srpAdvanceStage(log[pid]);
          if (advanced === null) {
            delete log[pid];
          } else {
            log[pid] = advanced;
          }
          await _srpWriteLog(log);
        }
      } catch (e) {
        console.warn("[Scaler++ Revision] Failed to advance stage:", e);
      }

      // Remove this item from the panel optimistically
      const row = listEl.querySelector(`[data-pid="${CSS.escape(pid)}"]`);
      if (row) row.remove();

      // Re-check if panel is empty
      const remaining = listEl.querySelectorAll(".srp-item").length;
      const panel = document.getElementById(REVISION_PANEL_ID);
      if (remaining === 0 && panel) panel.remove();
    });
  });
}

// ─── Panel injection ──────────────────────────────────────────

async function initRevisionPanel() {
  if (!isExtensionValid()) return;
  if (
    typeof currentSettings !== "undefined" &&
    !currentSettings["revision-tracker"]
  )
    return;

  // Only on mentee-dashboard pages
  if (!location.pathname.includes("/academy/mentee-dashboard")) return;

  // Avoid double-injection
  if (document.getElementById(REVISION_PANEL_ID)) return;

  // Read revision log
  const log = await _srpReadLog();
  const now = Date.now();
  const due = Object.entries(log)
    .filter(([, entry]) => entry.nextDue <= now)
    .map(([id, entry]) => ({ id, ...entry }));

  // Nothing due → don't inject anything
  if (due.length === 0) return;

  // Find the sidebar anchor: inject before .profile-page-performance
  const sidebar = document.querySelector(".mentee-home__sidebar");
  const perfSection = sidebar
    ? sidebar.querySelector(".profile-page-performance")
    : null;

  if (!sidebar || !perfSection) return;

  // Build the panel
  const panel = document.createElement("div");
  panel.id = REVISION_PANEL_ID;
  panel.setAttribute(REVISION_PANEL_ATTR, "true");
  panel.className = "scaler-revision-panel";
  panel.innerHTML =
    `<div class="srp-header">` +
    `<span class="srp-title">📚 Revise Today</span>` +
    `<span class="srp-count" id="srp-due-count"></span>` +
    `<button class="srp-toggle" id="srp-toggle-btn" title="Collapse">▾</button>` +
    `</div>` +
    `<div class="srp-body" id="srp-body">` +
    `<div id="srp-list"></div>` +
    `</div>`;

  sidebar.insertBefore(panel, perfSection);

  // Render items
  const listEl = panel.querySelector("#srp-list");
  const countEl = panel.querySelector("#srp-due-count");
  _srpRenderItems(due, listEl, countEl);

  // Collapse toggle
  const toggleBtn = panel.querySelector("#srp-toggle-btn");
  const bodyEl = panel.querySelector("#srp-body");
  toggleBtn.addEventListener("click", () => {
    const collapsed = bodyEl.classList.toggle("srp-hidden");
    toggleBtn.textContent = collapsed ? "▸" : "▾";
    toggleBtn.title = collapsed ? "Expand" : "Collapse";
  });
}

window.initRevisionPanel = initRevisionPanel;
