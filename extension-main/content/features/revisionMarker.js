// ============================================================
// content/features/revisionMarker.js — Smart Revision
// Injects a "Mark for Revision" button on Scaler problem pages.
// Button sits next to the LeetCode link in the problem heading.
// ============================================================

const MARKER_ATTR = "data-revision-marker";

async function initRevisionMarker() {
  if (!isExtensionValid()) return;
  if (typeof currentSettings !== "undefined" && !currentSettings["revision-tracker"]) return;

  // Only on assignment/homework problem pages
  const path = location.pathname;
  if (!path.match(/\/(assignment|homework)\/problems\/\d+/)) return;

  const headingEl = document.querySelector(".cr-p-heading__text");
  if (!headingEl) return;

  // Avoid double injection
  if (headingEl.querySelector(`[${MARKER_ATTR}]`)) return;

  // Extract problem ID from URL
  const idMatch = path.match(/\/problems\/(\d+)/);
  if (!idMatch) return;
  const ib_problem_id = idMatch[1];

  // Get title using the same approach as leetcodeLink.js
  const titleEl =
    headingEl.querySelector(".cr-p-heading__text span") ||
    headingEl.querySelector("span") ||
    headingEl;
  const title = (titleEl.innerText || "")
    .replace(/^Q\d+\.\s*/i, "")
    .split("\n")[0]
    .trim() || `Problem #${ib_problem_id}`;

  const url = window.location.href;

  // Check if already in the revision queue
  let alreadyMarked = false;
  try {
    const result = await new Promise((resolve) =>
      chrome.storage.local.get("scalerpp_revision_log", resolve)
    );
    alreadyMarked = !!(result.scalerpp_revision_log || {})[String(ib_problem_id)];
  } catch {
    // ignore storage read failure
  }

  const btn = document.createElement("button");
  btn.setAttribute(MARKER_ATTR, "true");
  btn.className = "scaler-revision-marker-btn";

  if (alreadyMarked) {
    btn.textContent = "✓ Revision Scheduled";
    btn.disabled = true;
  } else {
    btn.textContent = "📌 Mark for Revision";
    btn.addEventListener("click", async () => {
      if (typeof markProblemForRevision !== "function") return;
      const added = await markProblemForRevision(title, url, ib_problem_id);
      if (added) {
        btn.textContent = "✓ Revision Scheduled";
        btn.disabled = true;
      }
    });
  }

  headingEl.appendChild(btn);
}

window.initRevisionMarker = initRevisionMarker;
