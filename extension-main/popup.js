// ============================================
// Scaler++ - Popup Script
// Instant Apply Mode - No Save Button Needed
// ============================================

// Default settings - all enabled by default
const DEFAULT_SETTINGS = {
  // Todos Page
  "2025-revisited": true,
  "referral-stats": true,
  "mess-fee": true,
  attendance: true,
  "refer-earn": true,
  "scaler-coins": true,
  "continue-watching": true,
  "referral-banner": true,

  // Global
  "notebook-widget": true,
  "referral-popup": true,
  "auto-close-modals": true,

  // Sidebar
  "sst-goodies": true,
  "refer-friends": true,
  "sidebar-refer-banner": true,

  // Enhancements
  "core-curriculum": true,
  "problem-search": true,
  "leetcode-link": true,
  "problem-picker": true,
  "practice-mode": false,
  "practice-mode-days": 7,
  "practice-mode-start": null,
  "join-session": true,
  "companion-bypass": true,
  "subject-sort": true,
  "live-stream-recorder": false,
  "video-downloader": true,
  "calendar-sync": true,
  "lecture-info": true,
  "instructor-info": true,
  "lecture-summary": true,
  "mess-fee-filled-timestamp": null,

  // Contest
  "contest-leaderboard": true,

  // Assignment
  companion: true,

  // Spotlight Search
  "spotlight-search": true,

  // Appearance — site-wide theme (default "dark"; "off" = native Scaler look)
  theme: "dark",
};

// All toggle IDs mapped to their setting keys
const TOGGLE_MAP = {
  "toggle-2025-revisited": "2025-revisited",
  "toggle-referral-stats": "referral-stats",
  "toggle-mess-fee": "mess-fee",
  "toggle-attendance": "attendance",
  "toggle-refer-earn": "refer-earn",
  "toggle-scaler-coins": "scaler-coins",
  "toggle-continue-watching": "continue-watching",
  "toggle-referral-banner": "referral-banner",
  "toggle-notebook-widget": "notebook-widget",
  "toggle-referral-popup": "referral-popup",
  "toggle-auto-close-modals": "auto-close-modals",
  "toggle-sst-goodies": "sst-goodies",
  "toggle-refer-friends": "refer-friends",
  "toggle-sidebar-refer-banner": "sidebar-refer-banner",
  "toggle-core-curriculum": "core-curriculum",
  "toggle-problem-search": "problem-search",
  "toggle-problem-picker": "problem-picker",
  "toggle-leetcode-link": "leetcode-link",
  "toggle-practice-mode": "practice-mode",
  "toggle-lecture-info": "lecture-info",
  "toggle-instructor-info": "instructor-info",
  "toggle-lecture-summary": "lecture-summary",
  "toggle-join-session": "join-session",
  "toggle-companion-bypass": "companion-bypass",
  "toggle-companion": "companion",
  "toggle-subject-sort": "subject-sort",
  "toggle-live-stream-recorder": "live-stream-recorder",
  "toggle-video-downloader": "video-downloader",
  "toggle-calendar-sync": "calendar-sync",
  "toggle-contest-leaderboard": "contest-leaderboard",
  "toggle-spotlight-search": "spotlight-search",
};

// Features hard-disabled in code (e.g. the Live Stream Recorder kill switch in
// liveStreamRecorder.js). Their popup toggles are forced OFF and locked so users
// can't enable a feature that won't run. Keep in sync with each feature's own
// FORCE_DISABLED flag — to re-ship a feature, remove it from this set AND flip
// its in-feature kill switch.
const FORCE_DISABLED_FEATURES = new Set(["live-stream-recorder"]);

/**
 * Force every hard-disabled feature's toggle OFF + locked (un-checkable, dimmed).
 * Called after any code that sets toggle state (load / reset) so it always wins.
 */
function lockForceDisabledToggles() {
  FORCE_DISABLED_FEATURES.forEach((settingKey) => {
    const toggleId = Object.keys(TOGGLE_MAP).find(
      (id) => TOGGLE_MAP[id] === settingKey,
    );
    const toggle = toggleId && document.getElementById(toggleId);
    if (!toggle) return;
    toggle.checked = false;
    toggle.disabled = true;
    const row = toggle.closest(".toggle-item");
    if (row) row.classList.add("toggle-item--locked");
  });
}

// Current settings state
let currentSettings = { ...DEFAULT_SETTINGS };

/**
 * Load settings from Chrome storage and update UI
 */
async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get("cleanerSettings");
    currentSettings = { ...DEFAULT_SETTINGS, ...result.cleanerSettings };

    // Update all toggles based on saved settings
    Object.entries(TOGGLE_MAP).forEach(([toggleId, settingKey]) => {
      const toggle = document.getElementById(toggleId);
      if (toggle) {
        toggle.checked = currentSettings[settingKey] !== false;
        _syncSubOptions(settingKey, toggle.checked);
      }
    });

    // Update days input
    const daysInput = document.getElementById("practice-mode-days");
    if (daysInput) daysInput.value = currentSettings["practice-mode-days"] || 7;

    // Update theme selector
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = currentSettings["theme"] || "off";

    // Force-disabled features always win over the saved state.
    lockForceDisabledToggles();
  } catch (error) {
    console.error("Error loading settings:", error);
  }
}

/**
 * Handle theme dropdown change - INSTANT APPLY.
 * Theme is a multi-value <select> (not a boolean toggle), so it has its own
 * handler instead of living in TOGGLE_MAP.
 */
async function handleThemeChange(value) {
  currentSettings["theme"] = value;
  try {
    await chrome.storage.sync.set({ cleanerSettings: currentSettings });

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: "toggleSetting",
          key: "theme",
          value,
        });
      } catch (e) {
        // Content script not loaded on this page — fine.
      }
    }
    showToast(value === "off" ? "Theme off ✓" : "Theme applied ✓", "success");
  } catch (error) {
    console.error("Error saving theme:", error);
    showToast("Error saving", "error");
  }
}

/**
 * Handle individual toggle change - INSTANT APPLY
 */
async function handleToggleChange(toggleId, settingKey) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;

  // Hard-disabled features can never be enabled from the popup.
  if (FORCE_DISABLED_FEATURES.has(settingKey)) {
    toggle.checked = false;
    return;
  }

  const newValue = toggle.checked;
  currentSettings[settingKey] = newValue;

  try {
    // Special handling for practice mode
    if (settingKey === "practice-mode") {
      const optionsDiv = document.getElementById("practice-mode-options");
      if (optionsDiv) optionsDiv.style.display = newValue ? "block" : "none";

      if (newValue) {
        // Turning on: set start time
        currentSettings["practice-mode-start"] = Date.now();
      } else {
        // Turning off: clear reset history
        chrome.storage.local.get(null, (items) => {
          const keysToRemove = Object.keys(items).filter((k) =>
            k.startsWith("reset_history_"),
          );
          chrome.storage.local.remove(keysToRemove);
        });
        currentSettings["practice-mode-start"] = null;
      }
    }

    if (settingKey === "calendar-sync") {
      // Notify the background service worker so it can create or
      // destroy the 12-hour alarm.  The background also fires an
      // immediate (non-interactive) sync when the toggle is turned on
      // for the first time so the user sees instant feedback.
      chrome.runtime.sendMessage(
        { action: "CALENDAR_SYNC_TOGGLED", enabled: newValue },
        () => {
          /* response handled by background */
        },
      );
    }

    _syncSubOptions(settingKey, newValue);

    // Save to Chrome storage immediately
    await chrome.storage.sync.set({ cleanerSettings: currentSettings });

    // Notify content script to update visibility instantly
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: "toggleSetting",
          key: settingKey,
          value: newValue,
        });
      } catch (e) {
        // Content script might not be loaded on this page - that's okay
      }
    }

    // Show brief feedback based on feature type
    const isEnhancement = [
      "core-curriculum",
      "problem-search",
      "problem-picker",
      "leetcode-link",
      "practice-mode",
      "join-session",
      "companion-bypass",
      "subject-sort",
      "live-stream-recorder",
      "video-downloader",
      "contest-leaderboard",
      "spotlight-search",
    ].includes(settingKey);
    if (isEnhancement) {
      showToast(newValue ? "Enabled ✓" : "Disabled ✓", "success");
    } else {
      showToast(newValue ? "Hidden ✓" : "Visible ✓", "success");
    }
  } catch (error) {
    console.error("Error saving setting:", error);
    // Revert toggle on error
    toggle.checked = !newValue;
    currentSettings[settingKey] = !newValue;
    showToast("Error saving", "error");
  }
}

// ─── Sub-option Visibility ───────────────────────────────────

/**
 * Show or hide a toggle's companion sub-option panel.
 * Both the practice-mode options and the calendar-sync options
 * follow the same pattern.
 *
 * @param {string}  settingKey - The parent toggle's settings key
 * @param {boolean} visible    - Whether the parent toggle is ON
 */
function _syncSubOptions(settingKey, visible) {
  const panelIds = {
    "practice-mode": "practice-mode-options",
    "calendar-sync": "calendar-sync-options",
  };

  const panelId = panelIds[settingKey];
  if (!panelId) return;

  const panel = document.getElementById(panelId);
  if (panel) panel.style.display = visible ? "block" : "none";
}

/**
 * Reset all settings to default
 */
async function resetSettings() {
  try {
    currentSettings = { ...DEFAULT_SETTINGS };

    // Reset storage
    await chrome.storage.sync.set({ cleanerSettings: DEFAULT_SETTINGS });

    // Update UI
    Object.entries(TOGGLE_MAP).forEach(([toggleId, settingKey]) => {
      const toggle = document.getElementById(toggleId);
      if (toggle) {
        toggle.checked = DEFAULT_SETTINGS[settingKey];
        _syncSubOptions(settingKey, DEFAULT_SETTINGS[settingKey]);
      }
    });

    // Reset theme selector
    const themeSelect = document.getElementById("theme-select");
    if (themeSelect) themeSelect.value = DEFAULT_SETTINGS["theme"];

    // Keep force-disabled features locked off even after a reset.
    lockForceDisabledToggles();

    // Notify content script
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]?.id) {
      try {
        await chrome.tabs.sendMessage(tabs[0].id, {
          action: "settingsUpdated",
          settings: DEFAULT_SETTINGS,
        });
      } catch (e) {
        // Content script might not be loaded
      }
    }

    showToast("Reset to defaults ✓", "success");
  } catch (error) {
    console.error("Error resetting settings:", error);
    showToast("Error resetting", "error");
  }
}

/**
 * Show a toast notification
 */
function showToast(message, type = "success") {
  // Remove existing toast if any
  const existingToast = document.querySelector(".toast");
  if (existingToast) {
    existingToast.remove();
  }

  // Create new toast
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });

  // Remove after delay
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 1200);
}

/**
 * Initialize popup
 */
document.addEventListener("DOMContentLoaded", () => {
  // Set version dynamically
  const versionElement = document.getElementById("extension-version");
  if (versionElement) {
    const manifest = chrome.runtime.getManifest();
    versionElement.textContent = `v${manifest.version}`;
  }

  // Load saved settings
  loadSettings();

  // Setup toggle change handlers - INSTANT APPLY
  Object.entries(TOGGLE_MAP).forEach(([toggleId, settingKey]) => {
    const toggle = document.getElementById(toggleId);
    if (toggle) {
      toggle.addEventListener("change", () => {
        handleToggleChange(toggleId, settingKey);
      });
    }
  });

  // Reset button handler
  const resetBtn = document.getElementById("reset-btn");
  if (resetBtn) {
    resetBtn.addEventListener("click", resetSettings);
  }

  const rateBtn = document.getElementById("rate-btn");
  if (rateBtn) {
    rateBtn.addEventListener("click", () => {
      chrome.tabs.create({
        url: "https://chromewebstore.google.com/detail/scaler++/fpnleckmeeahiognlpphbadchogfjgcg",
      });
    });
  }

  const feedbackBtn = document.getElementById("feedback-btn");
  if (feedbackBtn) {
    feedbackBtn.addEventListener("click", () => {
      chrome.tabs.create({
        url: "https://docs.google.com/forms/d/e/1FAIpQLScBQg_MLdb3H8FXQKDGFeGhzynLvDuF9528voMW16JzVDZXbQ/viewform?usp=dialog",
      });
    });
  }

  // GitHub button handler
  const githubBtn = document.getElementById("github-btn");
  if (githubBtn) {
    githubBtn.addEventListener("click", () => {
      chrome.tabs.create({
        url: "https://github.com/Ritesh381/Scaler-extension",
      });
    });
  }

  // Theme selector change handler
  const themeSelect = document.getElementById("theme-select");
  if (themeSelect) {
    themeSelect.addEventListener("change", () => {
      handleThemeChange(themeSelect.value);
    });
  }

  // Practice mode days change handler
  const daysInput = document.getElementById("practice-mode-days");
  if (daysInput) {
    daysInput.addEventListener("change", async () => {
      const val = parseInt(daysInput.value) || 7;
      currentSettings["practice-mode-days"] = val;
      await chrome.storage.sync.set({ cleanerSettings: currentSettings });

      // Notify content script
      const tabs = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (tabs[0]?.id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "toggleSetting",
          key: "practice-mode-days",
          value: val,
        });
      }
    });
  }

  // ── Calendar Sync — "Sync Now" button ────────────────────
  document.getElementById("syncCalendarBtn")?.addEventListener("click", () => {
    const statusEl = document.getElementById("syncStatus");
    const btn = document.getElementById("syncCalendarBtn");

    // Disable the button and show an in-progress message while
    // waiting for the background to complete the sync
    btn.disabled = true;
    statusEl.textContent = "Syncing…";
    statusEl.className = "sync-status syncing";

    chrome.runtime.sendMessage({ action: "SYNC_CALENDAR" }, (response) => {
      btn.disabled = false;

      if (response?.success) {
        statusEl.textContent = "✓ Classes added to Calendar";
        statusEl.className = "sync-status success";
      } else {
        const reason = response?.error ?? "Unknown error";
        statusEl.textContent = `✗ Sync failed: ${reason}`;
        statusEl.className = "sync-status error";
      }

      // Clear the status message after a few seconds
      setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "sync-status";
      }, 5000);
    });
  });

  // Add hover effect for toggle items
  document.querySelectorAll(".toggle-item").forEach((item) => {
    item.addEventListener("mouseenter", () => {
      item.style.transform = "scale(1.01)";
    });
    item.addEventListener("mouseleave", () => {
      item.style.transform = "scale(1)";
    });
  });

  const devRateLink = document.getElementById("dev-rate-link");
  if (devRateLink) {
    devRateLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://chromewebstore.google.com/detail/scaler++/fpnleckmeeahiognlpphbadchogfjgcg",
      });
    });
  }

  const devContactLink = document.getElementById("dev-contact-link");
  if (devContactLink) {
    devContactLink.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.tabs.create({
        url: "https://www.riteshprajapati.me/",
      });
    });
  }
});
