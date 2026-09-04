// ============================================
// features/problemSearch.js
// Problem search bar feature for the problems page
// ============================================

let problemsData = null;
let searchBarInjected = false;
let isSearchActive = false;

/**
 * Check if current page is the problems page
 */
function isProblemsPage() {
  return /\/academy\/mentee-dashboard\/class\/[^/]+\/assignment\/problems\/?$/.test(
    location.pathname,
  );
}

/**
 * Inject search bar styles - LIGHT MODE to match Scaler UI
 */
function injectSearchStyles() {
  if (document.getElementById("scaler-search-styles")) return;

  const style = document.createElement("style");
  style.id = "scaler-search-styles";
  style.textContent = `
    .scaler-search-container {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      background: #ffffff;
      border: 1px solid #e0e0e0;
      border-radius: 10px;
      margin: 12px 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
      transition: all 0.3s ease;
    }
    
    .scaler-search-container:focus-within {
      border-color: #2563eb;
      box-shadow: 0 2px 12px rgba(37, 99, 235, 0.15);
    }
    
    .scaler-search-icon {
      color: #6b7280;
      font-size: 16px;
      display: flex;
      align-items: center;
    }
    
    .scaler-search-input {
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #1f2937;
      font-size: 14px;
      font-family: inherit;
    }
    
    .scaler-search-input::placeholder {
      color: #9ca3af;
    }
    
    .scaler-search-shortcut {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      color: #6b7280;
      font-size: 12px;
      font-weight: 500;
    }
    
    .scaler-search-shortcut kbd {
      background: #ffffff;
      padding: 2px 6px;
      border-radius: 4px;
      font-family: monospace;
      font-size: 11px;
      border: 1px solid #d1d5db;
      color: #374151;
    }
    
    .scaler-search-clear {
      display: none;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      background: #f3f4f6;
      border: none;
      border-radius: 50%;
      color: #6b7280;
      cursor: pointer;
      transition: background 0.2s;
      font-size: 12px;
    }
    
    .scaler-search-clear:hover {
      background: #e5e7eb;
      color: #374151;
    }
    
    .scaler-search-clear.visible {
      display: flex;
    }
    
    .scaler-search-results-count {
      color: #6b7280;
      font-size: 13px;
      white-space: nowrap;
    }
    
    .scaler-search-results-count strong {
      color: #2563eb;
    }
    
    /* Highlight matching text in problem names */
    .scaler-highlight {
      background: rgba(37, 99, 235, 0.15);
      color: #1e40af;
      padding: 1px 3px;
      border-radius: 3px;
      font-weight: 500;
    }
    
    /* Hidden row class for filtering */
    .scaler-search-hidden {
      display: none !important;
    }
    
    /* Search mode indicator */
    .scaler-search-mode {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      color: white;
      padding: 10px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 4px 12px rgba(37, 99, 235, 0.4);
      z-index: 10000;
      display: none;
      align-items: center;
      gap: 8px;
    }
    
    .scaler-search-mode.visible {
      display: flex;
      animation: slideIn 0.3s ease;
    }
    
    @keyframes slideIn {
      from {
        opacity: 0;
        transform: translateY(10px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
  `;
  document.head.appendChild(style);
}

/**
 * Inject the search bar into the problems page
 */
function injectSearchBar() {
  if (!isProblemsPage()) return;

  // Check if search bar already exists in DOM (prevents duplicates)
  const existingSearchBar = document.getElementById("scaler-problem-search");
  if (existingSearchBar) {
    searchBarInjected = true;
    return;
  }

  if (searchBarInjected) return;

  // Find the problem tabs container
  const problemTabs = document.querySelector(
    ".problem-tabs.problem-tabs__right-padding",
  );
  if (!problemTabs) return;

  injectSearchStyles();

  // Create search container
  const searchContainer = document.createElement("div");
  searchContainer.className = "scaler-search-container";
  searchContainer.id = "scaler-problem-search";
  searchContainer.innerHTML = `
    <span class="scaler-search-icon">🔍</span>
    <input 
      type="text" 
      class="scaler-search-input" 
      id="scaler-search-input"
      placeholder="Search by name, topic, type, or day..."
      autocomplete="off"
    >
    <button class="scaler-search-clear" id="scaler-search-clear" title="Clear search">✕</button>
    <span class="scaler-search-results-count" id="scaler-search-count"></span>
    <span class="scaler-search-shortcut">
      Press <kbd>/</kbd> to focus
    </span>
  `;

  // Insert after problem tabs
  problemTabs.insertAdjacentElement("afterend", searchContainer);

  // Create search mode indicator (only if it doesn't exist)
  if (!document.getElementById("scaler-search-mode")) {
    const modeIndicator = document.createElement("div");
    modeIndicator.className = "scaler-search-mode";
    modeIndicator.id = "scaler-search-mode";
    modeIndicator.innerHTML = `
      <span>🔍 Search Mode Active</span>
      <span style="opacity: 0.7">Press Esc to exit</span>
    `;
    document.body.appendChild(modeIndicator);
  }

  // Setup event listeners
  setupSearchListeners();

  searchBarInjected = true;
}

/**
 * Setup search event listeners
 */
function setupSearchListeners() {
  const searchInput = document.getElementById("scaler-search-input");
  const clearBtn = document.getElementById("scaler-search-clear");

  if (!searchInput) return;

  // Input handler - filter as user types
  searchInput.addEventListener("input", (e) => {
    const query = e.target.value.trim();
    filterProblems(query);

    // Show/hide clear button
    clearBtn.classList.toggle("visible", query.length > 0);
  });

  // Focus handler
  searchInput.addEventListener("focus", () => {
    activateSearchMode();
  });

  // Blur handler (but keep search mode if there's a query)
  searchInput.addEventListener("blur", () => {
    const query = searchInput.value.trim();
    if (query.length === 0) {
      deactivateSearchMode();
    }
  });

  // Clear button handler
  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    clearBtn.classList.remove("visible");
    filterProblems("");
    searchInput.focus();
  });

  // Escape key to clear and exit search
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      searchInput.value = "";
      clearBtn.classList.remove("visible");
      filterProblems("");
      searchInput.blur();
      deactivateSearchMode();
    }
  });
}

// Global "/" key to focus search — registered ONCE at module load.
// Keeping this outside setupSearchListeners() prevents listener
// stacking when the search bar is torn down and re-created on navigation.
document.addEventListener("keydown", (e) => {
  // Skip if already in an input field
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    return;
  }

  // "/" key to focus search
  if (e.key === "/" && isProblemsPage()) {
    const searchInput = document.getElementById("scaler-search-input");
    if (searchInput) {
      e.preventDefault();
      activateSearchMode();
      searchInput.focus();
    }
  }
});

/**
 * Activate search mode - switch to All Problems tab
 */
function activateSearchMode() {
  if (isSearchActive) return;
  isSearchActive = true;

  // Show mode indicator
  const indicator = document.getElementById("scaler-search-mode");
  if (indicator) {
    indicator.classList.add("visible");
  }

  // Click on "All Problems" tab to load all problems
  const allProblemsTab = document.querySelector(
    ".problem-tabs-navigation__header:first-child",
  );
  if (allProblemsTab && !allProblemsTab.classList.contains("active")) {
    allProblemsTab.click();
  }
}

/**
 * Deactivate search mode
 */
function deactivateSearchMode() {
  isSearchActive = false;

  // Hide mode indicator
  const indicator = document.getElementById("scaler-search-mode");
  if (indicator) {
    indicator.classList.remove("visible");
  }

  // Clear the result count
  const countEl = document.getElementById("scaler-search-count");
  if (countEl) {
    countEl.textContent = "";
  }
}

/**
 * Filter problems based on search query
 */
function filterProblems(query) {
  const problemRows = document.querySelectorAll(
    ".problems-list__table .column",
  );
  const countEl = document.getElementById("scaler-search-count");

  if (!problemRows.length) return;

  let visibleCount = 0;
  let totalCount = problemRows.length;

  if (query.length === 0) {
    // Show all problems
    problemRows.forEach((row) => {
      row.classList.remove("scaler-search-hidden");
      // Remove any highlights
      const nameEl = row.querySelector(".problem__item--name a");
      if (nameEl && nameEl.dataset.originalText) {
        nameEl.innerHTML = nameEl.dataset.originalText;
      }
    });

    if (countEl) {
      countEl.textContent = "";
    }
    return;
  }

  const searchTerms = query.toLowerCase().split(/\s+/);

  problemRows.forEach((row) => {
    const nameEl = row.querySelector(".problem__item--name a");
    const dayEl = row.querySelector(".problem__item--days");
    const typeEl = row.querySelector(".problem__item--judge");
    const topicEl = row.querySelector(".problem__item--topic");

    if (!nameEl) return;

    // Store original text if not already stored
    if (!nameEl.dataset.originalText) {
      nameEl.dataset.originalText = nameEl.textContent;
    }

    const problemName = nameEl.dataset.originalText.toLowerCase();
    const dayText = dayEl ? dayEl.textContent.toLowerCase() : "";

    // Get type text (Code/Objective)
    const typeText = typeEl ? typeEl.textContent.toLowerCase().trim() : "";

    // Try to extract topic from the problem URL or other sources
    let topicText = "";
    if (topicEl) {
      topicText = topicEl.textContent.toLowerCase().trim();
    }

    // Combine all searchable text
    const searchText =
      `${problemName} ${dayText} ${typeText} ${topicText}`.toLowerCase();

    // Check if all search terms match
    const matches = searchTerms.every((term) => searchText.includes(term));

    if (matches) {
      row.classList.remove("scaler-search-hidden");
      visibleCount++;

      // Highlight matching text in name
      let highlightedName = nameEl.dataset.originalText;
      searchTerms.forEach((term) => {
        if (term.length > 0) {
          const regex = new RegExp(`(${escapeRegex(term)})`, "gi");
          highlightedName = highlightedName.replace(
            regex,
            '<span class="scaler-highlight">$1</span>',
          );
        }
      });
      nameEl.innerHTML = highlightedName;
    } else {
      row.classList.add("scaler-search-hidden");
      // Restore original text
      nameEl.innerHTML = nameEl.dataset.originalText;
    }
  });

  // Update count
  if (countEl) {
    countEl.innerHTML = `<strong>${visibleCount}</strong> of ${totalCount} problems`;
  }
}

/**
 * Initialize problems search feature
 */
function initProblemsSearch(retries = 0) {
  if (!isProblemsPage()) {
    // Clean up if navigated away
    removeSearchBar();
    return;
  }

  // Check if feature is enabled
  if (!shouldHide("problem-search")) {
    // Feature is disabled
    removeSearchBar();
    return;
  }

  // Try to inject search bar
  injectSearchBar();

  // Retry if not injected (page might still be loading).
  // Cap at 8 retries (~8 seconds) to avoid an infinite loop if the
  // problems page never renders the expected container.
  if (!searchBarInjected && retries < 8) {
    setTimeout(() => initProblemsSearch(retries + 1), 1000);
  }
}

/**
 * Remove the search bar if it exists
 */
function removeSearchBar() {
  const searchContainer = document.getElementById("scaler-problem-search");
  const modeIndicator = document.getElementById("scaler-search-mode");

  if (searchContainer) {
    searchContainer.remove();
  }
  if (modeIndicator) {
    modeIndicator.remove();
  }

  // Reset state
  searchBarInjected = false;
  isSearchActive = false;

  // Show all problems that might have been hidden
  const hiddenRows = document.querySelectorAll(".scaler-search-hidden");
  hiddenRows.forEach((row) => row.classList.remove("scaler-search-hidden"));
}
