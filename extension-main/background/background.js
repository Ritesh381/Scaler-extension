// ============================================================
// background.js — Scaler++ Service Worker Entry Point
// ─────────────────────────────────────────────────────────────
// All feature logic lives in separate modules loaded below.
// importScripts() runs each file in the same global scope, so
// all their functions and listeners are immediately active.
// ============================================================

importScripts("./companionBypass.js"); // Smart Companion Mode Bypass
importScripts("../content/utils/stringUtils.js"); // Shared title/statement matching helpers
importScripts("./leetcodeLink.js"); // LeetCode Problem Search & Verification
importScripts("./videoTracker.js"); // Capture media streams
importScripts("./calendarSync.js"); // Syncing classes directly into Google Calendar
importScripts("./messagesProxy.js"); // Proxies CORS requests for custom messages
importScripts("./summaryProxy.js"); // Lecture summary cache + LLM proxy
importScripts("./revisionBadge.js"); // Smart Revision badge count on extension icon
