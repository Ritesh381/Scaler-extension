// ============================================
// content.js — Entry point & message handler
// All logic is split across:
//   cleaner/  → selectors, cleanerEngine, modalHandler, sidebarHandler
//   core/     → settings, styleInjector, urlObserver
//   features/ → problemSearch, practiceMode, leetcodeLink, joinClassButton, spotlightSearch
//   utils/    → domUtils, stringUtils
// ============================================

/**
 * Listen for messages from popup - INSTANT UPDATES
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "settingsUpdated") {
    currentSettings = { ...DEFAULT_SETTINGS, ...message.settings };
    applyAllSettings();
    if (typeof applyTheme === "function") applyTheme(currentSettings.theme);
    sendResponse({ success: true });
  } else if (message.action === "toggleSetting") {
    // Handle individual toggle change
    const { key, value } = message;
    currentSettings[key] = value;

    // Special handling for different feature types
    if (key === "core-curriculum") {
      handleCoreCurriculumVisibility();
    } else if (key === "referral-popup") {
      if (value) {
        hideReferralPopup();
      } else {
        // Show the popup (remove hidden class)
        const elements = document.querySelectorAll(
          `[${CLEANER_ATTR}="referral-popup"]`,
        );
        elements.forEach((el) => el.classList.remove(HIDDEN_CLASS));
      }
    } else if (key === "auto-close-modals") {
      if (value) {
        autoCloseReferralModals();
      }
    } else if (key === "problem-search") {
      // Toggle problem search bar
      if (value) {
        initProblemsSearch();
      } else {
        removeSearchBar();
      }
    } else if (key === "problem-picker") {
      if (value) {
        initProblemPicker();
      } else {
        const btn = document.querySelector(".scaler-pick-random-btn");
        if (btn) btn.remove();
      }
    } else if (key === "practice-mode") {
      if (value) {
        handlePracticeMode();
      }
    } else if (key === "leetcode-link") {
      // Toggle LeetCode link
      if (value) {
        initLeetCodeLink();
      } else {
        // Remove existing link
        const existingLink = document.querySelector(".scaler-leetcode-link");
        if (existingLink) {
          existingLink.remove();
        }
      }
    } else if (key === "join-session") {
      // Toggle Join Session buttons
      if (value) {
        initJoinSessionButtons();
      } else {
        // Remove any injected buttons and restore "View Details" text
        document.querySelectorAll(".scaler-join-session-btn").forEach((btn) => {
          // Recreate the original "View Details" span
          const span = document.createElement("span");
          span.className = "_3cg2nc-UIVR1CzIB7nNQ8Z";
          span.textContent = "View Details";
          btn.replaceWith(span);
        });
        // Reset injection guards so they can be re-injected if re-enabled
        document
          .querySelectorAll('[data-join-session-injected="true"]')
          .forEach((card) => {
            delete card.dataset.joinSessionInjected;
          });
        // Disconnect observer so it stops watching
        if (window._joinSessionObserver) {
          window._joinSessionObserver.disconnect();
          window._joinSessionObserver = null;
        }
      }
    } else if (key === "subject-sort") {
      if (value) {
        initSubjectSort();
      } else {
        restoreSubjectSort();
        if (window._subjectSortObserver) {
          window._subjectSortObserver.disconnect();
          window._subjectSortObserver = null;
        }
      }
    } else if (key === "contest-leaderboard") {
      if (value) {
        initContestLeaderboard();
      } else {
        // Remove injected leaderboard links by reloading the page
        // or simply disconnect the observer
        if (window._leaderboardObserver) {
          window._leaderboardObserver.disconnect();
          window._leaderboardObserver = null;
        }
      }
    } else if (key === "spotlight-search") {
      if (!value && typeof closeSpotlight === "function") {
        closeSpotlight();
      }
    } else if (key === "theme") {
      // Site-wide theme switch — value is a theme id ("off", "dark", ...)
      if (typeof applyTheme === "function") applyTheme(value);
    } else if (key === "lecture-info") {
      if (value) {
        if (typeof initLectureInfo === "function") initLectureInfo();
      } else {
        // teardown lecture-info: disconnect observer and remove injected tags
        try {
          if (window._instructorInfoObserver_lecture) {
            window._instructorInfoObserver_lecture.disconnect();
            window._instructorInfoObserver_lecture = null;
          }
        } catch (e) {
          console.warn("Error tearing down lecture-info observer", e);
        }

        document.querySelectorAll('.scaler-lecture-instructor-info, .scaler-lecture-instructor-tag').forEach(el => el.remove());
        document.querySelectorAll('[data-lecture-instructor-info-id]').forEach(el => el.removeAttribute('data-lecture-instructor-info-id'));
      }
    } else if (key === "instructor-info") {
      if (value) {
        if (typeof initInstructorInfo === "function") initInstructorInfo();
      } else {
        // teardown instructor-info: disconnect tab/session observers and remove UI
        try {
          if (window._instructorTabObserver) {
            window._instructorTabObserver.disconnect();
            window._instructorTabObserver = null;
          }
          if (window._instructorInfoObserver) {
            window._instructorInfoObserver.disconnect();
            window._instructorInfoObserver = null;
          }
        } catch (e) {
          console.warn("Error tearing down instructor-info observers", e);
        }

        document.querySelectorAll('.scaler-instructor-info, .scaler-instructor-tag').forEach(el => el.remove());
        const tab = document.getElementById('classroom-instructor-info'); if (tab) tab.remove();
        const panel = document.getElementById('scaler-instructor-panel'); if (panel) panel.remove();
        document.querySelectorAll('[data-instructor-info-id]').forEach(el => el.removeAttribute('data-instructor-info-id'));
      }
    } else if (key === "lecture-summary") {
      if (value) {
        if (typeof initLectureSummary === "function") initLectureSummary();
      } else {
        // teardown lecture-summary: disconnect observer and remove tab/panel
        try {
          if (window._summaryTabObserver) {
            window._summaryTabObserver.disconnect();
            window._summaryTabObserver = null;
          }
        } catch (e) {
          console.warn("Error tearing down lecture-summary observer", e);
        }
        const sTab = document.getElementById('classroom-lecture-summary'); if (sTab) sTab.remove();
        const sPanel = document.getElementById('scaler-summary-panel'); if (sPanel) sPanel.remove();
      }
    } else {
      updateVisibilityForKey(key, value);
    }

    sendResponse({ success: true });
  }
  return true;
});

// ============================================
// Initialize
// ============================================

window.addEventListener("load", async () => {
  await loadSettings();
  injectStyles();
  if (typeof initThemeManager === "function") initThemeManager();
  setupUrlChangeDetection();
  setupModalObserver();
  setTimeout(runCleanup, 1000);
  setTimeout(runCleanup, 2500);
  setTimeout(runCleanup, 5000);

  // Initialize problems search if on problems page
  setTimeout(initProblemsSearch, 1500);

  // Initialize LeetCode link
  setTimeout(initLeetCodeLink, 2000);

  // Initialize Join Session buttons on dashboard
  setTimeout(initJoinSessionButtons, 1500);

  // Initialize Lecture & Instructor info on dashboard/session (respect settings)
  setTimeout(() => {
    if (currentSettings && currentSettings["lecture-info"] && typeof initLectureInfo === "function") {
      initLectureInfo();
    }
    if (currentSettings && currentSettings["instructor-info"] && typeof initInstructorInfo === "function") {
      initInstructorInfo();
    }
    if (currentSettings && currentSettings["lecture-summary"] && typeof initLectureSummary === "function") {
      initLectureSummary();
    }
  }, 1700);

  // Initialize Contest Leaderboard on contest pages
  setTimeout(initContestLeaderboard, 2000);

  // Initialize custom message checking
  setTimeout(initCustomMessages, 1000);

  // Initialize Problem Picker
  setTimeout(initProblemPicker, 1500);

  // Track username from header
  setTimeout(initUsernameTracker, 1500);

  // Initialize Spotlight Search (Ctrl+Space)
  if (typeof initSpotlightSearch === "function") initSpotlightSearch();
});

document.addEventListener("DOMContentLoaded", async () => {
  await loadSettings();
  injectStyles();
  if (typeof initThemeManager === "function") initThemeManager();
  setupModalObserver();
  setTimeout(runCleanup, 500);

  // Initialize problems search if on problems page
  setTimeout(initProblemsSearch, 1000);

  // Initialize Problem Picker
  setTimeout(initProblemPicker, 1200);
});

// ============================================
// URL change hooks for features
// ============================================

// Extend handleUrlChange to support problemSearch + leetcodeLink + practiceMode
const _baseHandleUrlChange = handleUrlChange;
handleUrlChange = function () {
  _baseHandleUrlChange();

  // Reset search bar state on navigation
  searchBarInjected = false;
  isSearchActive = false;

  // Re-initialize search if on problems page
  if (isProblemsPage()) {
    setTimeout(initProblemsSearch, 1500);
  }

  // Handle practice mode on URL change
  setTimeout(handlePracticeMode, 2000);

  // Check for assignment problem pages (LeetCode link)
  if (isAssignmentProblemPage()) {
    setTimeout(initLeetCodeLink, 2000);
  }

  // Re-inject Join Session buttons on any dashboard navigation
  setTimeout(initJoinSessionButtons, 1500);

  // Re-inject Lecture & Instructor info on any dashboard navigation (respect settings)
  setTimeout(() => {
    if (currentSettings && currentSettings["lecture-info"] && typeof initLectureInfo === "function") {
      initLectureInfo();
    }
    if (currentSettings && currentSettings["instructor-info"] && typeof initInstructorInfo === "function") {
      initInstructorInfo();
    }
    if (currentSettings && currentSettings["lecture-summary"] && typeof initLectureSummary === "function") {
      initLectureSummary();
    }
  }, 1700);

  // Re-initialize Subject Sort on curriculum navigation
  if (window.location.href.includes("/core-curriculum")) {
    setTimeout(initSubjectSort, 1500);
  }

  // Re-initialize Contest Leaderboard on contest navigation
  if (isContestPage()) {
    setTimeout(initContestLeaderboard, 2000);
  }

  // Re-initialize Problem Picker on dashboard
  setTimeout(initProblemPicker, 1500);
};
