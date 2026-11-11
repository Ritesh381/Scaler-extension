// ============================================
// features/joinClassButton.js
// Adds a "Join Session" button directly on the dashboard class cards,
// but ONLY when:
//   1. The active date tab matches today's date.
//   2. The current time is within the class's scheduled window.
// ============================================

/**
 * Parse a 12-hour time string like "02:30 PM" into today's Date object.
 * Returns null if the string cannot be parsed.
 *
 * @param {string} timeStr  e.g. "02:30 PM"
 * @returns {Date|null}
 */
function parseClassTime(timeStr) {
  if (!timeStr) return null;

  const match = timeStr.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3].toUpperCase();

  if (meridiem === "AM") {
    if (hours === 12) hours = 0; // 12 AM → 0
  } else {
    if (hours !== 12) hours += 12; // 1–11 PM → 13–23
  }

  const d = new Date();
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * Returns true if right now is between startTime and endTime
 * (inclusive of start, exclusive of end).
 *
 * @param {string} startStr  e.g. "02:30 PM"
 * @param {string} endStr    e.g. "04:30 PM"
 * @returns {boolean}
 */
function isClassLiveNow(startStr, endStr) {
  const now = new Date();
  const start = parseClassTime(startStr);
  const end = parseClassTime(endStr);

  if (!start || !end) return false;

  return now >= start && now < end;
}

/**
 * Read the currently active date tab on the dashboard.
 * The tabs look like:
 *   <div class="tabs__header ...">
 *     <div class="tabs__tab ...">20 Feb</div>
 *     <div class="tabs__tab ... tabs__tab--active ...">23 Feb</div>
 *     ...
 *   </div>
 *
 * Returns a Date set to midnight of the active tab's date,
 * or null if the tab cannot be found / parsed.
 *
 * @returns {Date|null}
 */
function getActiveDashboardDate() {
  const activeTab = document.querySelector(".tabs__tab--active");
  if (!activeTab) return null;

  const text = activeTab.textContent.trim(); // e.g. "23 Feb"
  const match = text.match(/^(\d{1,2})\s+([A-Za-z]+)$/);
  if (!match) return null;

  const day = parseInt(match[1], 10);
  const monthStr = match[2];

  // Map abbreviated / full month names to 0-indexed month numbers
  const MONTHS = [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ];
  const monthIndex = MONTHS.findIndex((m) =>
    monthStr.toLowerCase().startsWith(m),
  );
  if (monthIndex === -1) return null;

  // Infer the year: use current year, but if the resulting date is more than
  // 60 days in the past it's likely a year-boundary edge case — bump to next year.
  const today = new Date();
  let year = today.getFullYear();
  const candidate = new Date(year, monthIndex, day);
  if (today - candidate > 60 * 24 * 60 * 60 * 1000) {
    year += 1;
  }

  return new Date(year, monthIndex, day, 0, 0, 0, 0);
}

/**
 * Returns true when the active dashboard date tab is today.
 *
 * @returns {boolean}
 */
function isActiveDateToday() {
  const activeDate = getActiveDashboardDate();
  if (!activeDate) return false;

  const today = new Date();
  return (
    activeDate.getFullYear() === today.getFullYear() &&
    activeDate.getMonth() === today.getMonth() &&
    activeDate.getDate() === today.getDate()
  );
}

/**
 * Extract the start and end time strings from a classroom card element.
 * The card contains:
 *   <div class="_1EQZYaGMSYVhKTiIKY-qXP">
 *     <div>
 *       <span>02:30 PM</span>
 *       <span class="m-l-5 m-r-5">-</span>
 *       <span>04:30 PM</span>
 *     </div>
 *     <span class="_3cg2nc-UIVR1CzIB7nNQ8Z">View Details</span>
 *   </div>
 *
 * @param {Element} card
 * @returns {{ start: string, end: string } | null}
 */
function extractClassTimes(card) {
  // Grab all spans inside the time-wrapper div (excludes the separator span text)
  const timeWrapper = card.querySelector("._1EQZYaGMSYVhKTiIKY-qXP > div");
  if (!timeWrapper) return null;

  // Collect non-separator spans
  const spans = Array.from(timeWrapper.querySelectorAll("span")).filter(
    (s) => !s.classList.contains("m-l-5") && !s.classList.contains("m-r-5"),
  );

  if (spans.length < 2) return null;

  return {
    start: spans[0].textContent.trim(),
    end: spans[1].textContent.trim(),
  };
}

/**
 * Inject "Join Session" buttons on all classroom cards that are currently live.
 * Cards whose class window has not started or has already ended are skipped.
 */
function injectJoinSessionButtons() {
  // --- Date gate: only run when the active tab is today ---
  if (!isActiveDateToday()) return;

  const classroomCards = document.querySelectorAll(
    'a.me-cr-classroom-url[data-cy="classroom-link"]',
  );

  if (!classroomCards.length) return;

  classroomCards.forEach((card) => {
    // Re-check every call (time may have changed since last run), so
    // remove the guard to allow re-evaluation.
    // We only skip if the button is already injected AND still visible.
    if (
      card.dataset.joinSessionInjected === "true" &&
      card.querySelector(".scaler-join-session-btn")
    ) {
      return;
    }

    const classHref = card.getAttribute("href");
    if (!classHref) return;

    // --- Time gate ---
    const times = extractClassTimes(card);
    if (!times) return; // Can't determine time → skip

    if (!isClassLiveNow(times.start, times.end)) {
      // Class is not live right now — leave "View Details" as-is
      return;
    }

    // Find the "View Details" span — skip if already replaced
    const viewDetailsSpan = card.querySelector("._3cg2nc-UIVR1CzIB7nNQ8Z");
    if (!viewDetailsSpan) return;

    // Build the join session URL
    const joinUrl = `${classHref}/session?joinSession=1`;

    // Create the "Join Session" anchor
    const joinBtn = document.createElement("a");
    joinBtn.href = joinUrl;
    joinBtn.textContent = "Join Session";
    joinBtn.className = "scaler-join-session-btn";
    joinBtn.title = `Join live session (${times.start} – ${times.end})`;

    // Stop the parent card click from also firing when clicking the button
    joinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    // Replace the span with our button
    viewDetailsSpan.replaceWith(joinBtn);

    // Mark this card so we don't redundantly query further this cycle
    card.dataset.joinSessionInjected = "true";
  });
}

/**
 * Observe DOM mutations on the dashboard so cards loaded dynamically
 * (e.g., after a soft navigation) also get evaluated.
 */
function observeDashboardForClassCards() {
  // Scope to the dashboard content area if available, fall back to body.
  // Narrowing the scope dramatically reduces how often the observer fires.
  const dashboardRoot =
    document.querySelector(".mentee-dashboard__content") ||
    document.querySelector(".mentee-dashboard") ||
    document.body;

  // Already watching the live root. If the SPA replaced it, the observer
  // would pin the old subtree and never see new cards: re-root.
  if (window._joinSessionObserver) {
    const root = window._joinSessionObserverRoot;
    if (root === dashboardRoot && root.isConnected) return;
    stopJoinSessionObserver();
  }

  // Debounce: collapse rapid DOM mutation bursts into one evaluation.
  let _joinDebounceTimer = null;

  const observer = new MutationObserver(() => {
    clearTimeout(_joinDebounceTimer);
    _joinDebounceTimer = setTimeout(injectJoinSessionButtons, 200);
  });

  observer.observe(dashboardRoot, { childList: true, subtree: true });
  window._joinSessionObserver = observer;
  window._joinSessionObserverRoot = dashboardRoot;
}

function stopJoinSessionObserver() {
  if (window._joinSessionObserver) {
    window._joinSessionObserver.disconnect();
    window._joinSessionObserver = null;
  }
  window._joinSessionObserverRoot = null;
}

/**
 * Entry point — only activate on the mentee dashboard.
 */
function initJoinSessionButtons() {
  if (!location.href.includes("mentee-dashboard") || currentSettings["join-session"] === false) {
    stopJoinSessionObserver();
    return;
  }

  injectJoinSessionButtons();
  observeDashboardForClassCards();
}
