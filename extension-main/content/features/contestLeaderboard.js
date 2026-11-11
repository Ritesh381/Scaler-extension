// ============================================
// features/contestLeaderboard.js
// Always enables the "View Leaderboard" link on contest pages,
// even while the contest is ongoing.
// ============================================

function isContestPage() {
  return location.href.includes("/contest");
}

function extractContestId() {
  const match = location.href.match(/\/(?:class|classroom)\/(\d+)\/contest/);
  return match ? match[1] : null;
}

// contestId -> { alias, failures, nextTryAt }. Without it, a contest whose
// alias lookup fails was re-fetched on every debounced DOM change (a ticking
// contest timer means one request every few hundred ms, forever).
const _contestAliasCache = new Map();
const CONTEST_ALIAS_MAX_FAILURES = 3;
const CONTEST_ALIAS_RETRY_MS = 10000;

/**
 * Cached alias lookup: one request per contest when it works, at most
 * CONTEST_ALIAS_MAX_FAILURES spaced-out tries when it doesn't.
 */
async function getContestAlias(contestId) {
  const entry = _contestAliasCache.get(contestId) || { alias: null, failures: 0, nextTryAt: 0 };
  if (entry.alias) return entry.alias;
  if (entry.failures >= CONTEST_ALIAS_MAX_FAILURES || Date.now() < entry.nextTryAt) return null;

  const alias = await fetchContestAlias(contestId);
  if (alias) {
    entry.alias = alias;
  } else {
    entry.failures += 1;
    entry.nextTryAt = Date.now() + CONTEST_ALIAS_RETRY_MS;
  }
  _contestAliasCache.set(contestId, entry);
  return alias;
}

async function fetchContestAlias(contestId) {
  try {
    const url = `https://www.scaler.com/api/v2/classroom/${contestId}/contest`;
    const response = await fetch(url, {
      credentials: "include", // Send cookies for authentication
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      console.warn("[Scaler++] Failed to fetch contest page:", response.status);
      return null;
    }

    const result = await response.json();

    // The alias can be in several places in the response.
    // Based on the provided snippet, the primary path is:
    // result.data.attributes.current_contest.alias
    const attributes = result?.data?.attributes;
    const currentContest = attributes?.current_contest;

    const alias =
      currentContest?.alias ||
      currentContest?.tests?.[0]?.alias ||
      attributes?.alias ||
      result?.data?.attributes?.alias ||
      null;

    return alias;
  } catch (err) {
    console.warn("[Scaler++] Error fetching contest alias:", err);
    return null;
  }
}

function findDisabledLeaderboard() {
  const statsContainers = document.querySelectorAll(
    ".cr-stats.cr-stats--first",
  );

  for (const container of statsContainers) {
    // Check for the NON-filled trophy icon (disabled state)
    const icon = container.querySelector("i.cr-icon-trophy");
    if (!icon) continue;

    // Ensure it's NOT the filled variant (already enabled)
    if (icon.classList.contains("cr-icon-trophy-filled")) continue;

    // Confirm the "View Leaderboard" text exists as a plain div (not link)
    const bottom = container.querySelector(".cr-stats__bottom");
    if (
      bottom &&
      bottom.tagName.toLowerCase() !== "a" &&
      bottom.textContent.trim() === "View Leaderboard"
    ) {
      return container;
    }
  }

  return null;
}

function injectLeaderboardLink(container, alias) {
  // 1. Replace the trophy icon with the filled variant
  const icon = container.querySelector("i.cr-icon-trophy");
  if (icon) {
    icon.classList.remove("cr-icon-trophy");
    icon.classList.add("cr-icon-trophy-filled");
  }

  // 2. Replace the "View Leaderboard" div with a clickable <a> tag
  const bottom = container.querySelector(".cr-stats__bottom");
  if (bottom && bottom.tagName.toLowerCase() !== "a") {
    const link = document.createElement("a");
    link.className = "cr-stats__bottom link block bold";
    link.href = `/contest/${alias}/scoreboard`;
    link.textContent = "View Leaderboard";
    link.style.cursor = "pointer";
    bottom.replaceWith(link);
  }

  // Mark container so we don't re-process it
  container.dataset.scalerLeaderboardInjected = "true";
}

async function enableContestLeaderboard() {
  // Only run on contest pages
  if (!isContestPage()) return;

  // Find disabled leaderboard
  const container = findDisabledLeaderboard();
  if (!container) return; // Already enabled or not found

  // Skip if already processed
  if (container.dataset.scalerLeaderboardInjected === "true") return;

  // Guard against concurrent fetches triggered by rapid DOM mutations
  if (_leaderboardFetchInProgress) return;
  _leaderboardFetchInProgress = true;

  try {
    // Extract contest ID
    const contestId = extractContestId();
    if (!contestId) {
      console.warn("[Scaler++] Could not extract contest ID from URL");
      return;
    }

    // Fetch alias
    const alias = await getContestAlias(contestId);
    if (!alias) {
      console.warn("[Scaler++] Could not fetch contest alias for ID:", contestId);
      return;
    }

    // Inject the enabled leaderboard link
    injectLeaderboardLink(container, alias);
    console.log(`[Scaler++] Leaderboard enabled → /contest/${alias}/scoreboard`);
  } finally {
    _leaderboardFetchInProgress = false;
  }
}

let _leaderboardFetchInProgress = false;

let _leaderboardDebounceTimer = null;

/** Stop watching: on toggle-off and on leaving a contest page. */
function stopContestLeaderboard() {
  clearTimeout(_leaderboardDebounceTimer);
  _leaderboardDebounceTimer = null;
  if (window._leaderboardObserver) {
    window._leaderboardObserver.disconnect();
    window._leaderboardObserver = null;
  }
  window._leaderboardObserverRoot = null;
}

function observeForLeaderboard() {
  // Scope to the contest page content if possible, fall back to body.
  const contestRoot =
    document.querySelector(".classroom-contest") ||
    document.querySelector(".cr-stats-container") ||
    document.body;

  // Already watching the live root. A root the SPA has since replaced would
  // pin the old DOM and miss the new one, so re-root in that case.
  if (window._leaderboardObserver) {
    const root = window._leaderboardObserverRoot;
    if (root === contestRoot && root.isConnected) return;
    stopContestLeaderboard();
  }

  const observer = new MutationObserver(() => {
    if (currentSettings["contest-leaderboard"] === false) return;
    // Debounce: don't fire a fetch on every individual DOM mutation.
    clearTimeout(_leaderboardDebounceTimer);
    _leaderboardDebounceTimer = setTimeout(() => {
      if (!_leaderboardFetchInProgress) {
        enableContestLeaderboard();
      }
    }, 300);
  });

  observer.observe(contestRoot, { childList: true, subtree: true });
  window._leaderboardObserver = observer;
  window._leaderboardObserverRoot = contestRoot;
}

/** Safe to call on every navigation: stops itself off contest pages. */
function initContestLeaderboard() {
  if (!isContestPage() || currentSettings["contest-leaderboard"] === false) {
    stopContestLeaderboard();
    return;
  }

  enableContestLeaderboard();
  observeForLeaderboard();
}
