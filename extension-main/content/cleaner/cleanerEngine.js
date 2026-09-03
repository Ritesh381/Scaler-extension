// ============================================
// cleaner/cleanerEngine.js
// Core DOM cleaning and visibility logic
// ============================================

/**
 * Check if current page is the todos page
 */
function isTodosPage() {
  return location.pathname.includes("/academy/mentee-dashboard/todos");
}

/**
 * Process elements - hide or show based on settings
 */
function processElementsByConfig(configs) {
  configs.forEach((config) => {
    const elements = document.querySelectorAll(config.selector);
    elements.forEach((element) => {
      if (config.verify(element)) {
        // Mark the element with our attribute for tracking
        element.setAttribute(CLEANER_ATTR, config.key);

        // Hide or show based on current setting
        if (shouldHide(config.key)) {
          element.classList.add(HIDDEN_CLASS);
        } else {
          element.classList.remove(HIDDEN_CLASS);
        }
      }
    });
  });
}

/**
 * Update visibility for a specific key
 */
function updateVisibilityForKey(key, hide) {
  // First, try to find already marked elements
  let elements = document.querySelectorAll(`[${CLEANER_ATTR}="${key}"]`);

  // If no marked elements found, try to find and mark them now
  if (elements.length === 0) {
    const allConfigs = [
      ...TODOS_PAGE_SELECTORS,
      ...GLOBAL_SELECTORS,
      ...SIDEBAR_SELECTORS,
      ...ASSIGNMENT_SELECTORS,
    ];
    const configs = allConfigs.filter((c) => c.key === key);
    configs.forEach((config) => {
      const potentialElements = document.querySelectorAll(config.selector);
      potentialElements.forEach((el) => {
        if (config.verify(el)) {
          el.setAttribute(CLEANER_ATTR, key);
        }
      });
    });
    elements = document.querySelectorAll(`[${CLEANER_ATTR}="${key}"]`);
  }

  elements.forEach((el) => {
    if (hide) {
      el.classList.add(HIDDEN_CLASS);
    } else {
      el.classList.remove(HIDDEN_CLASS);
    }
  });

  // Special handling for auto-close modals
  if (key === "auto-close-modals") {
    if (hide) {
      autoCloseReferralModals();
    }
  }
}

/**
 * Handle core curriculum link visibility (enhancement - different logic)
 */
function handleCoreCurriculumVisibility() {
  const curriculumLinks = document.querySelectorAll(
    `[${CLEANER_ATTR}="core-curriculum"]`,
  );
  const shouldShow = shouldHide("core-curriculum"); // For enhancements, "enabled" means show

  curriculumLinks.forEach((el) => {
    if (shouldShow) {
      el.classList.remove(HIDDEN_CLASS);
    } else {
      el.classList.add(HIDDEN_CLASS);
    }
  });
}

/**
 * Apply all settings - update visibility for all tracked elements
 */
function applyAllSettings() {
  // Re-process all elements to find any new ones
  if (isTodosPage()) {
    processElementsByConfig(TODOS_PAGE_SELECTORS);
  }
  processElementsByConfig(GLOBAL_SELECTORS);
  processElementsByConfig(SIDEBAR_SELECTORS);
  processElementsByConfig(ASSIGNMENT_SELECTORS);

  // Handle core curriculum links
  handleCoreCurriculumVisibility();

  // Handle referral popup
  hideReferralPopup();

  // Auto close modals if enabled
  if (shouldHide("auto-close-modals")) {
    autoCloseReferralModals();
  }
}

/**
 * Hide referral popup modal
 */
function hideReferralPopup() {
  if (!shouldHide("referral-popup")) return;

  // Hide the main popup modal
  const popup = document.querySelector("div.ug-referral-popup-modal");
  if (popup) {
    popup.setAttribute(CLEANER_ATTR, "referral-popup");
    popup.classList.add(HIDDEN_CLASS);
  }

  // Hide the backdrop (find the one specifically for referral popup)
  const backdrops = document.querySelectorAll(
    "div.sr-backdrop.ug-referral-popup-modal__backdrop",
  );
  backdrops.forEach((backdrop) => {
    backdrop.setAttribute(CLEANER_ATTR, "referral-popup");
    backdrop.classList.add(HIDDEN_CLASS);
  });
}

/**
 * Auto-close referral modals by clicking the close button
 */
function autoCloseReferralModals() {
  if (!shouldHide("auto-close-modals")) return;

  // Find and click close button on referral popup
  const referralPopup = document.querySelector("div.ug-referral-popup-modal");
  if (referralPopup && !referralPopup.classList.contains(HIDDEN_CLASS)) {
    const closeBtn = referralPopup.querySelector("a.sr-modal__close-alt");
    if (closeBtn) {
      closeBtn.click();
    }
  }

  // Also try to close any other referral-related modals
  const modals = document.querySelectorAll("div.sr-modal");
  modals.forEach((modal) => {
    // Check if it's a referral-related modal
    const isReferralModal =
      modal.classList.contains("ug-referral-popup-modal") ||
      modal.textContent.includes("Referral") ||
      modal.textContent.includes("Refer") ||
      modal.textContent.includes("NSET registration");

    if (isReferralModal) {
      const closeBtn = modal.querySelector(
        "a.sr-modal__close-alt, a.sr-modal__close, div.sr-modal__close",
      );
      if (closeBtn) {
        closeBtn.click();
      }
    }
  });
}
/**
 * Helper function to append the curriculum icon to a container
 */
function appendCurriculumIcon(container) {
  if (container.querySelector('a[href*="core-curriculum"]')) return;

  const anchor = document.createElement("a");
  anchor.href =
    "https://www.scaler.com/academy/mentee-dashboard/core-curriculum/m/";
  anchor.className = "tappable";
  anchor.style.display = "inline-flex";
  anchor.style.alignItems = "center";
  anchor.style.marginLeft = "6px";
  anchor.style.padding = "2px";
  anchor.style.borderRadius = "50px";
  anchor.style.border = "1px solid #e2e8f0";
  anchor.style.background = "#ffffff";
  anchor.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)";
  anchor.style.transition = "box-shadow 0.2s, border-color 0.2s";
  anchor.title = "Core Curriculum";
  anchor.setAttribute(CLEANER_ATTR, "core-curriculum");

  anchor.addEventListener("mouseenter", () => {
    anchor.style.boxShadow = "0 2px 10px rgba(0,0,0,0.10)";
    anchor.style.borderColor = "#cbd5e1";
  });
  anchor.addEventListener("mouseleave", () => {
    anchor.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)";
    anchor.style.borderColor = "#e2e8f0";
  });

  // Apply visibility based on settings
  if (!shouldHide("core-curriculum")) {
    anchor.classList.add(HIDDEN_CLASS);
  }

  const icon = document.createElement("i");
  icon.className = "icon-curriculum-outlined sidebar__item-icon";
  anchor.appendChild(icon);
  container.appendChild(anchor);
}

/**
 * Append the Spotlight Search button to the header (next to the curriculum icon).
 * Clicking it opens the spotlight; keyboard shortcut is Alt+/.
 */
function appendSpotlightButton(container) {
  if (container.querySelector("#scaler-spotlight-header-btn")) return;

  const btn = document.createElement("button");
  btn.id = "scaler-spotlight-header-btn";
  btn.title = "Spotlight Search (Alt + /)";
  btn.setAttribute("aria-label", "Open Spotlight Search");
  btn.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
         stroke="#94a3b8" stroke-width="2.2"
         stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="8"/>
      <line x1="21" y1="21" x2="16.65" y2="16.65"/>
    </svg>
    <span style="color:#94a3b8;font-size:14px;font-weight:400;letter-spacing:0.1px;pointer-events:none;">Search anything</span>
  `;

  // Wide search-bar style matching the reference image
  Object.assign(btn.style, {
    display: "inline-flex",
    alignItems: "center",
    gap: "10px",
    padding: "10px 20px",
    minWidth: "168px",
    border: "1px solid #e2e8f0",
    borderRadius: "50px",
    background: "#ffffff",
    boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
    cursor: "pointer",
    lineHeight: "1",
    transition: "box-shadow 0.2s, border-color 0.2s",
    verticalAlign: "middle",
    boxSizing: "border-box",
  });

  btn.addEventListener("mouseenter", () => {
    btn.style.boxShadow = "0 2px 10px rgba(0,0,0,0.10)";
    btn.style.borderColor = "#cbd5e1";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.boxShadow = "0 1px 4px rgba(0,0,0,0.06)";
    btn.style.borderColor = "#e2e8f0";
  });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    if (typeof window.initSpotlightSearch === "function") {
      window.initSpotlightSearch();
    }
    window.dispatchEvent(new CustomEvent("scaler-spotlight-open"));
  });

  container.appendChild(btn);
}

/**
 * Add Core-Curriculum icon link to the header container
 */
function addCoreCurriculumIconLink() {
  let container = document.querySelector(".e7ge61UPj54Me37pqU2Rd");

  if (container) {
    appendCurriculumIcon(container);
    appendSpotlightButton(container);
  } else {
    setTimeout(() => {
      const containerXPath =
        "/html/body/div[3]/div/div[1]/div/div[1]/div/div[2]/div/div[1]";
      const xpathContainer = getElementByXPath(containerXPath);
      if (xpathContainer) {
        appendCurriculumIcon(xpathContainer);
        appendSpotlightButton(xpathContainer);
      }
    }, 2000);
  }
}

/**
 * Forget the stored "mess fee filled" marker and persist the change.
 */
function clearMessFeeFilled() {
  if (
    !currentSettings["mess-fee-filled-link"] &&
    !currentSettings["mess-fee-filled-timestamp"]
  ) {
    return;
  }

  delete currentSettings["mess-fee-filled-link"];
  delete currentSettings["mess-fee-filled-timestamp"]; // legacy key
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync) {
    chrome.storage.sync.set({ cleanerSettings: currentSettings });
  }
}

/**
 * Inject Mess Fee 'Filled' checkbox dynamically
 */
function injectMessFeeCheckbox() {
  const cards = document.querySelectorAll("a.mentee-card");
  cards.forEach((card) => {
    if (!card.textContent.includes("Mess Fee")) return;

    // If mess-fee hiding is disabled in the popup, ensure the card stays
    // visible and don't inject the "Mark as Filled" checkbox at all.
    if (!shouldHide("mess-fee")) {
      card.classList.remove(HIDDEN_CLASS);
      // Remove any previously injected checkbox container
      if (card.hasAttribute("data-mess-fee-injected")) {
        const existing = card.querySelector("div[style*='z-index: 999']");
        if (existing) existing.remove();
        card.removeAttribute("data-mess-fee-injected");
      }
      return;
    }

    // ── Visibility gate ────────────────────────────────────────────────────
    // The link is the ONLY signal.  Show the card whenever Scaler's own
    // "Click here" typeform button is in the DOM, no matter what day of the
    // month it is — Scaler keeps the form open past the usual window when
    // students still haven't submitted.  No button → no action to take → hide.
    //
    // Because browsers break nested <a> tags out of the parent anchor, the
    // typeform link won't be found inside `card` itself — we check the
    // parent container, which holds both the card anchor and the action panel.
    const searchRoot = card.parentElement || card;
    const typeformBtn = searchRoot.querySelector('a[href*="typeform"]');

    if (!typeformBtn) {
      // No actionable button → hide the card.  Also forget any stored "filled"
      // marker: the window is closed, so the next link that appears belongs to
      // a fresh cycle and must show again.
      card.classList.add(HIDDEN_CLASS);
      clearMessFeeFilled();
      return;
    }

    // Button is present → card should be visible unless the user has already
    // manually marked *this* form as filled via our checkbox.  The marker is
    // the form URL, not a date, so a form that stays open longer than usual
    // keeps behaving correctly and a new form re-shows the card.
    const formLink = typeformBtn.href;
    const filledLink = currentSettings["mess-fee-filled-link"];
    const isFilled = Boolean(filledLink) && filledLink === formLink;

    if (isFilled) {
      // Keep hidden to survive React re-renders
      card.classList.add(HIDDEN_CLASS);
    } else {
      card.classList.remove(HIDDEN_CLASS);
      // Marker belongs to an older form → drop it
      if (filledLink) clearMessFeeFilled();
    }

    // ── Checkbox injection ─────────────────────────────────────────────────
    if (card.hasAttribute("data-mess-fee-injected")) {
      // Already injected — keep its state in sync with storage
      const existingBox = card.querySelector("#mess-fee-filled-checkbox");
      if (existingBox) existingBox.checked = isFilled;
      return;
    }
    card.setAttribute("data-mess-fee-injected", "true");

    // Inject a "Mark as Filled" checkbox so the user can dismiss the card
    // early once they've already submitted the form.
    const checkboxContainer = document.createElement("div");
    checkboxContainer.style.display = "flex";
    checkboxContainer.style.alignItems = "center";
    checkboxContainer.style.position = "absolute";
    checkboxContainer.style.bottom = "12px";
    checkboxContainer.style.left = "16px";
    checkboxContainer.style.zIndex = "999";
    checkboxContainer.style.background = "white";
    checkboxContainer.style.padding = "4px 8px";
    checkboxContainer.style.borderRadius = "4px";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.id = "mess-fee-filled-checkbox";
    checkbox.style.marginRight = "8px";
    checkbox.style.cursor = "pointer";
    checkbox.style.width = "16px";
    checkbox.style.height = "16px";
    checkbox.style.accentColor = "#0080FF";
    checkbox.checked = isFilled;

    const label = document.createElement("label");
    label.htmlFor = "mess-fee-filled-checkbox";
    label.textContent = "Mark as Filled [Scaler++]";
    label.style.fontSize = "12px";
    label.style.fontWeight = "600";
    label.style.cursor = "pointer";
    label.style.color = "#333";

    checkboxContainer.appendChild(checkbox);
    checkboxContainer.appendChild(label);

    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) {
        currentSettings["mess-fee-filled-link"] = typeformBtn.href;
      } else {
        delete currentSettings["mess-fee-filled-link"];
      }
      // Legacy key from the date-window era — never read again
      delete currentSettings["mess-fee-filled-timestamp"];

      if (
        typeof chrome !== "undefined" &&
        chrome.storage &&
        chrome.storage.sync
      ) {
        await chrome.storage.sync.set({ cleanerSettings: currentSettings });
      }

      if (checkbox.checked) {
        setTimeout(() => {
          card.classList.add(HIDDEN_CLASS);
        }, 400);
      }
    });

    // Prevent click-through navigation on the container
    checkboxContainer.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
    });

    checkbox.addEventListener("click", (e) => {
      e.stopPropagation();
      e.stopImmediatePropagation();
    });

    card.style.position = "relative"; // vital for absolute positioning the child
    card.appendChild(checkboxContainer);
  });
}

/**
 * Main cleanup function - runs on todos page
 */
function cleanupTodosPage() {
  if (!isTodosPage()) return;
  processElementsByConfig(TODOS_PAGE_SELECTORS);
  injectMessFeeCheckbox(); // Safely inject the mess fee checkbox
}

/**
 * Global cleanup - runs on all pages
 */
function cleanupGlobal() {
  processElementsByConfig(GLOBAL_SELECTORS);
  hideReferralPopup();

  // Add Core Curriculum icon to header (on all pages)
  addCoreCurriculumIconLink();

  // Auto close modals if enabled
  if (shouldHide("auto-close-modals")) {
    autoCloseReferralModals();
  }
}

/**
 * Cleanup sidebar elements
 */
function cleanupSidebar() {
  const sidebar = document.querySelector(".sidebar__content");
  if (!sidebar) return;
  processElementsByConfig(SIDEBAR_SELECTORS);
}

function cleanupAssignment() {
  if (!isAssignmentProblemPage()) return;
  processElementsByConfig(ASSIGNMENT_SELECTORS);
}

/**
 * Run all cleanup tasks.
 * Uses a 5-second settings cache to avoid hammering chrome.storage.sync
 * when called many times in quick succession (e.g. from MutationObservers).
 */
let _lastSettingsLoadTime = 0;
const SETTINGS_CACHE_TTL_MS = 5000;

async function runCleanup() {
  if (!isExtensionValid()) return;

  const now = Date.now();
  if (now - _lastSettingsLoadTime > SETTINGS_CACHE_TTL_MS) {
    await loadSettings();
    _lastSettingsLoadTime = now;
  }

  injectStyles();
  cleanupGlobal();
  cleanupTodosPage();
  cleanupSidebar();
  cleanupAssignment();
  setupSidebarObserver();
  setupModalObserver();
  handlePracticeMode();
}
