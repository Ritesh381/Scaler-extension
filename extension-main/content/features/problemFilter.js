// ============================================
// features/problemFilter.js
// Filter Scaler problems by difficulty, type,
// status, score and submission state.
// ============================================

let problemFilterInjected = false;
let problemFilterRetryTimer = null;

const PROBLEM_FILTER_HIDDEN_CLASS = "scaler-filter-hidden";
const PROBLEM_FILTER_ID = "scaler-problem-filters";
const PROBLEM_FILTER_STYLE_ID = "scaler-problem-filter-styles";

/**
 * Check whether the current page is Scaler's problems page.
 *
 * problemSearch.js already defines isProblemsPage(), but keeping a
 * feature-local fallback makes this file safer if load order changes.
 */
function isProblemFilterPage() {
  return typeof isProblemsPage === "function" && isProblemsPage();
}

/**
 * Return only actual problem rows.
 *
 * Scaler also uses .table__row for the table header, so requiring
 * .me-cr-problem-list__name prevents us from treating the header as
 * a problem.
 */
function getProblemFilterRows() {
  return Array.from(document.querySelectorAll("tr.table__row")).filter((row) =>
    row.querySelector(".me-cr-problem-list__name"),
  );
}

/**
 * Inject styles for the filter controls.
 */
function injectProblemFilterStyles() {
  if (document.getElementById(PROBLEM_FILTER_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = PROBLEM_FILTER_STYLE_ID;

  style.textContent = `
    .scaler-problem-filters {
      margin: 0 0 12px;
      padding: 8px 0 10px;
      background: transparent;
      border: 0;
      border-bottom: 1px solid #e5e7eb;
      border-radius: 0;
      box-shadow: none;
      font-family: inherit;
    }

    .scaler-filter-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 8px;
    }

    .scaler-filter-label {
      color: #374151;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
    }

    #scaler-filter-count {
      color: #6b7280;
      font-size: 12px;
      white-space: nowrap;
    }

    #scaler-filter-count strong {
      color: #111827;
      font-weight: 600;
    }

    .scaler-filter-controls {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }

    .scaler-filter-controls select {
      min-width: 120px;
      height: 32px;
      padding: 0 28px 0 10px;
      background: #ffffff;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      color: #374151;
      font-family: inherit;
      font-size: 13px;
      line-height: 1.2;
      outline: none;
      cursor: pointer;
      transition:
        border-color 0.2s ease,
        box-shadow 0.2s ease;
    }

    .scaler-filter-controls select:hover {
      border-color: #9ca3af;
    }

    .scaler-filter-controls select:focus {
      border-color: #2563eb;
      box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.12);
    }

    #scaler-filter-reset {
      height: 32px;
      padding: 0 12px;
      background: #ffffff;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      color: #374151;
      font-family: inherit;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition:
        background 0.2s ease,
        border-color 0.2s ease;
    }

    #scaler-filter-reset:hover {
      background: #f9fafb;
      border-color: #9ca3af;
    }

    #scaler-filter-reset:disabled {
      background: #f9fafb;
      border-color: #e5e7eb;
      color: #9ca3af;
      cursor: default;
    }

    .${PROBLEM_FILTER_HIDDEN_CLASS} {
      display: none !important;
    }

    @media (max-width: 960px) {
      .scaler-filter-controls select {
        flex: 1 1 140px;
        min-width: 0;
      }

      #scaler-filter-reset {
        flex: 1 1 100px;
      }
    }
  `;

  document.head.appendChild(style);
}

/**
 * Determine the problem type using Scaler's judge icon.
 *
 * Verified from Scaler DOM:
 * cr-icon-code      -> Coding
 * cr-icon-objective -> MCQ / Objective
 */
function getProblemType(row) {
  const icon = row.querySelector(".me-cr-problem-list__judge-type");

  if (!icon) return "unknown";

  if (icon.classList.contains("cr-icon-code")) {
    return "coding";
  }

  if (icon.classList.contains("cr-icon-objective")) {
    return "mcq";
  }

  return "unknown";
}

/**
 * Extract difficulty from the problem row.
 *
 * Verified Scaler structure:
 * column 0 -> problem
 * column 1 -> type
 * column 2 -> difficulty
 */
function getProblemDifficulty(row) {
  return row.children[2]?.textContent.trim().toLowerCase() || "unknown";
}

/**
 * Extract problem status such as solved, attempted, or unsolved.
 */
function getProblemStatus(row) {
  const statusText = row.children[4]?.textContent.trim().toLowerCase() || "";

  if (statusText.includes("unsolved")) {
    return "unsolved";
  }

  if (statusText.includes("attempted")) {
    return "attempted";
  }

  if (statusText.includes("solved")) {
    return "solved";
  }

  return "unknown";
}

/**
 * Parse a Scaler score such as:
 *
 * 200.0/200 -> full
 * 75/200    -> partial
 * 0/200     -> zero
 */
function getProblemScoreState(row) {
  const scoreText = row.children[3]?.textContent.trim() || "";

  const match = scoreText.match(
    /(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/,
  );

  if (!match) {
    return "unknown";
  }

  const earned = Number.parseFloat(match[1]);
  const total = Number.parseFloat(match[2]);

  if (!Number.isFinite(earned) || !Number.isFinite(total)) {
    return "unknown";
  }

  if (earned <= 0) {
    return "zero";
  }

  if (total > 0 && earned >= total) {
    return "full";
  }

  return "partial";
}

/**
 * Determine whether the problem has been attempted from the
 * submissions column.
 *
 * Examples:
 * "3 submissions" -> attempted
 * "0 submissions" -> unattempted
 */
function getProblemSubmissionState(row) {
  const text = row.children[5]?.textContent.trim().toLowerCase() || "";

  const match = text.match(/(\d+)\s+submissions?/);

  if (match) {
    const count = Number.parseInt(match[1], 10);

    return count > 0 ? "attempted" : "unattempted";
  }

  // Some Scaler states may render no submission link/text at all.
  // Treat an empty submissions cell as no submissions.
  if (!text) {
    return "unattempted";
  }

  return "unknown";
}

/**
 * Read the currently selected filter values.
 */
function getActiveProblemFilters() {
  return {
    difficulty:
      document.getElementById("scaler-difficulty-filter")?.value || "all",

    type: document.getElementById("scaler-type-filter")?.value || "all",

    status: document.getElementById("scaler-status-filter")?.value || "all",

    score: document.getElementById("scaler-score-filter")?.value || "all",

    submissions:
      document.getElementById("scaler-submission-filter")?.value || "all",
  };
}

/**
 * Check whether any filter is currently active.
 */
function hasActiveProblemFilters(filters = getActiveProblemFilters()) {
  return Object.values(filters).some((value) => value !== "all");
}

/**
 * Apply all selected filters.
 *
 * Filters use AND logic:
 *
 * Medium + Coding + Unsolved
 *
 * means a row must satisfy all three conditions.
 */
function applyProblemFilters() {
  const rows = getProblemFilterRows();
  const filters = getActiveProblemFilters();

  let visibleCount = 0;

  rows.forEach((row) => {
    const rowDifficulty = getProblemDifficulty(row);
    const rowType = getProblemType(row);
    const rowStatus = getProblemStatus(row);
    const rowScore = getProblemScoreState(row);
    const rowSubmissions = getProblemSubmissionState(row);

    const matchesDifficulty =
      filters.difficulty === "all" ||
      rowDifficulty === filters.difficulty;

    const matchesType =
      filters.type === "all" ||
      rowType === filters.type;

    const matchesStatus =
      filters.status === "all" ||
      rowStatus === filters.status;

    const matchesScore =
      filters.score === "all" ||
      rowScore === filters.score;

    const matchesSubmissions =
      filters.submissions === "all" ||
      rowSubmissions === filters.submissions;

    const matches =
      matchesDifficulty &&
      matchesType &&
      matchesStatus &&
      matchesScore &&
      matchesSubmissions;

    row.classList.toggle(PROBLEM_FILTER_HIDDEN_CLASS, !matches);

    if (matches) {
      visibleCount++;
    }
  });

  updateProblemFilterCount(visibleCount, rows.length);
  updateProblemFilterResetButton();
}

/**
 * Update result count.
 */
function updateProblemFilterCount(visibleCount, totalCount) {
  const count = document.getElementById("scaler-filter-count");

  if (!count) return;

  if (!hasActiveProblemFilters()) {
    count.textContent = `${totalCount} problems`;
    return;
  }

  count.innerHTML =
    `<strong>${visibleCount}</strong> of ${totalCount} problems`;
}

/**
 * Disable Reset when nothing is selected.
 */
function updateProblemFilterResetButton() {
  const resetButton = document.getElementById("scaler-filter-reset");

  if (!resetButton) return;

  resetButton.disabled = !hasActiveProblemFilters();
}

/**
 * Reset every filter.
 */
function resetProblemFilters() {
  const filterIds = [
    "scaler-difficulty-filter",
    "scaler-type-filter",
    "scaler-status-filter",
    "scaler-score-filter",
    "scaler-submission-filter",
  ];

  filterIds.forEach((id) => {
    const element = document.getElementById(id);

    if (element) {
      element.value = "all";
    }
  });

  applyProblemFilters();
}

/**
 * Attach listeners to the controls.
 */
function setupProblemFilterListeners() {
  const filterIds = [
    "scaler-difficulty-filter",
    "scaler-type-filter",
    "scaler-status-filter",
    "scaler-score-filter",
    "scaler-submission-filter",
  ];

  filterIds.forEach((id) => {
    const element = document.getElementById(id);

    if (element) {
      element.addEventListener("change", applyProblemFilters);
    }
  });

  const resetButton = document.getElementById("scaler-filter-reset");

  if (resetButton) {
    resetButton.addEventListener("click", resetProblemFilters);
  }
}

/**
 * Inject filter controls.
 */
function injectProblemFilters() {
  if (!isProblemFilterPage()) return false;

  const existing = document.getElementById(PROBLEM_FILTER_ID);

  if (existing) {
    problemFilterInjected = true;
    return true;
  }

  /*
   * Find the actual problem table.
   *
   * We deliberately locate it through a known problem element instead
   * of depending entirely on a table class that may change.
   */
  const problemName = document.querySelector(".me-cr-problem-list__name");
  const table =
    problemName?.closest("table") ||
    document.querySelector("table.me-cr-problem-list") ||
    document.querySelector(".problems-list__table");

  if (!table) {
    return false;
  }

  injectProblemFilterStyles();

  const container = document.createElement("div");
  container.id = PROBLEM_FILTER_ID;
  container.className = "scaler-problem-filters";

  container.innerHTML = `
    <div class="scaler-filter-header">
      <span class="scaler-filter-label">Filter Problems</span>
      <span id="scaler-filter-count"></span>
    </div>

    <div class="scaler-filter-controls">

      <select
        id="scaler-difficulty-filter"
        aria-label="Filter by difficulty"
      >
        <option value="all">All Difficulties</option>
        <option value="very easy">Very Easy</option>
        <option value="easy">Easy</option>
        <option value="medium">Medium</option>
        <option value="hard">Hard</option>
      </select>

      <select
        id="scaler-type-filter"
        aria-label="Filter by problem type"
      >
        <option value="all">All Types</option>
        <option value="coding">Coding</option>
        <option value="mcq">MCQ</option>
      </select>

      <select
        id="scaler-status-filter"
        aria-label="Filter by status"
      >
        <option value="all">All Statuses</option>
        <option value="solved">Solved</option>
        <option value="attempted">Attempted</option>
        <option value="unsolved">Unsolved</option>
      </select>

      <select
        id="scaler-score-filter"
        aria-label="Filter by score"
      >
        <option value="all">All Scores</option>
        <option value="full">Full Score</option>
        <option value="partial">Partial Score</option>
        <option value="zero">Zero Score</option>
      </select>

      <select
        id="scaler-submission-filter"
        aria-label="Filter by submissions"
      >
        <option value="all">All Submissions</option>
        <option value="attempted">Attempted</option>
        <option value="unattempted">Not Attempted</option>
      </select>

      <button
        id="scaler-filter-reset"
        type="button"
      >
        Reset
      </button>

    </div>
  `;

  table.insertAdjacentElement("beforebegin", container);

  setupProblemFilterListeners();

  problemFilterInjected = true;

  applyProblemFilters();

  return true;
}

/**
 * Initialize problem filters.
 *
 * Scaler renders the problems table asynchronously, so retry for a
 * short period if the table is not available yet.
 */
function initProblemFilters(retries = 0) {
  if (!isProblemFilterPage()) {
    removeProblemFilters();
    return;
  }

  if (injectProblemFilters()) {
    return;
  }

  if (retries >= 10) {
    return;
  }

  if (problemFilterRetryTimer) {
    clearTimeout(problemFilterRetryTimer);
  }

  problemFilterRetryTimer = setTimeout(() => {
    problemFilterRetryTimer = null;
    initProblemFilters(retries + 1);
  }, 750);
}

/**
 * Remove filter UI and restore rows.
 */
function removeProblemFilters() {
  if (problemFilterRetryTimer) {
    clearTimeout(problemFilterRetryTimer);
    problemFilterRetryTimer = null;
  }

  document.getElementById(PROBLEM_FILTER_ID)?.remove();

  document
    .querySelectorAll(`.${PROBLEM_FILTER_HIDDEN_CLASS}`)
    .forEach((row) => {
      row.classList.remove(PROBLEM_FILTER_HIDDEN_CLASS);
    });

  problemFilterInjected = false;
}