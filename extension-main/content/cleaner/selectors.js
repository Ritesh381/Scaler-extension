// ============================================
// cleaner/selectors.js
// DOM selectors category config and constants
// ============================================

// Unique attribute to mark elements we've processed
const CLEANER_ATTR = "data-scaler-cleaner";
const HIDDEN_CLASS = "scaler-cleaner-hidden";

// Default settings - all enabled by default (true = hide element)
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

  // Enhancements (true = show the feature)
  "core-curriculum": true,
  "problem-search": true,
  "leetcode-link": true,
  "problem-picker": true,
  "practice-mode": false,
  "practice-mode-days": 7,
  "practice-mode-start": null,

  companion: true,
  "subject-sort": true,
  "lecture-info": true,
  "instructor-info": true,
  "lecture-summary": true,
  "mess-fee-filled-timestamp": null,

  // Contest
  "contest-leaderboard": true,

  // Spotlight Search
  "spotlight-search": true,

  // Appearance — site-wide theme ("off" = native Scaler look)
  theme: "off",
};

// Elements config for /academy/mentee-dashboard/todos page
const TODOS_PAGE_SELECTORS = [
  {
    key: "2025-revisited",
    selector: "a._3l2QS_TrEOIiff69Oqtw-",
    verify: (el) =>
      el.textContent.includes("2025") && el.textContent.includes("Revisited"),
  },
  {
    key: "referral-stats",
    selector: "div.referral-live-counter__container",
    verify: (el) =>
      el
        .querySelector(".referral-live-counter__title")
        ?.textContent.includes("Referral Stats"),
  },
  {
    key: "attendance",
    selector: "div.progressed-performance",
    verify: (el) =>
      el
        .querySelector(".progressed-performance__title")
        ?.textContent.includes("Attendance"),
  },
  {
    key: "mess-fee",
    selector: "a.mentee-card",
    verify: (el) => el.textContent.includes("Mess Fee"),
  },
  {
    key: "continue-watching",
    selector: "div.section.continue-watch",
    verify: (el) =>
      el
        .querySelector(".section-header__title")
        ?.textContent.includes("Continue Watching"),
  },
  {
    key: "referral-banner",
    selector: "div.ug-referral-banner-sst",
    verify: (el) =>
      el.textContent.includes("Referral") && el.textContent.includes("Rewards"),
  },
];

// Global elements on ALL scaler.com pages (header elements, popups, etc.)
const GLOBAL_SELECTORS = [
  {
    key: "refer-earn",
    selector: "a.refer-and-earn-nudge-sst",
    verify: (el) =>
      el.textContent.includes("Refer") && el.textContent.includes("Earn"),
  },
  {
    key: "scaler-coins",
    selector: 'a.mentee-header__stats[href="/store"]',
    verify: (el) => el.querySelector('img[alt="scaler coin"]') !== null,
  },
  {
    key: "notebook-widget",
    selector: "a",
    verify: (el) =>
      el.querySelector('img[alt="widget-icon"][src*="notebook-widget"]') !==
      null,
  },
  {
    key: "referral-popup",
    selector: "div.ug-referral-popup-modal",
    verify: (el) => true, // Always match this modal
  },
  {
    key: "referral-popup",
    selector: "div.ug-referral-popup-modal__backdrop",
    verify: (el) => true, // Also hide the backdrop
  },
];

// Sidebar elements
const SIDEBAR_SELECTORS = [
  {
    key: "sst-goodies",
    selector: 'a[href="/academy/store"]',
    verify: (el) => el.textContent.includes("SST Goodies"),
  },
  {
    key: "refer-friends",
    selector: "a.me-sidebar-refer-and-earn-sst__nav",
    verify: (el) => el.textContent.includes("Refer Friends"),
  },
  {
    key: "sidebar-refer-banner",
    selector: "div.me-sidebar-refer-and-earn-sst",
    verify: (el) => el.getAttribute("role") === "presentation",
  },
];

const ASSIGNMENT_SELECTORS = [
  {
    key: "companion",
    selector: "div.Companion-module_root__ZGYyu",
    verify: (el) =>
      el.querySelector(".SolveBotWidget-module_container__Sttx-") !== null ||
      el.querySelector('img[alt="solve bot icon"]') !== null,
  },
];

// All selectors combined for easy iteration
const ALL_SELECTORS = [
  ...TODOS_PAGE_SELECTORS,
  ...GLOBAL_SELECTORS,
  ...SIDEBAR_SELECTORS,
  ...ASSIGNMENT_SELECTORS,
];
