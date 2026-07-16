// ============================================
// features/leetcodeLink.js
// LeetCode problem matching and link injection
// ============================================
//
// Matching/verification (title + problem statement + confidence scoring)
// runs in the background service worker (background/leetcodeLink.js), which
// avoids CORS on the LeetCode/Google fetches. This file is responsible for:
//   - deciding whether the page is even a coding problem (skip MCQ/theory),
//   - extracting the title + statement,
//   - and injecting the link only when the background reports high confidence.

/**
 * Check if current page is an assignment problem page
 */
function isAssignmentProblemPage() {
  return (
    (location.pathname.includes("/assignment/problems/") ||
      location.pathname.includes("/homework/problems")) &&
    location.pathname.match(/\/problems\/\d+/)
  );
}

/**
 * Heuristic: is this Scaler problem a coding/DSA problem (vs an MCQ, theory,
 * or subjective question)? LeetCode links only make sense for coding problems,
 * so non-DSA subjects (OS, Memory Allocation, DBMS theory, …) should never get
 * an icon.
 *
 * Strategy (strict — require a positive coding signal):
 *   - A code editor on the page → yes.
 *   - A "Run"/"Compile" action control → yes (MCQ pages only have "Submit").
 *   - Anything else (MCQ, theory, subjective, or an unrecognized layout) → no.
 *
 * Erring towards "no" keeps the icon off non-DSA questions even on page layouts
 * we don't recognize; the confidence gate is the second line of defence.
 */
function isLikelyCodingProblem() {
  const EDITOR_SELECTORS = [
    ".monaco-editor",
    ".ace_editor",
    ".CodeMirror",
    ".cm-editor",
    "[class*='codeEditor']",
    "[class*='code-editor']",
    "[class*='CodeEditor']",
    "[class*='code_editor']",
  ];
  const hasEditor = EDITOR_SELECTORS.some((sel) => document.querySelector(sel));
  if (hasEditor) return true;

  // "Run" / "Compile" buttons are coding-only (MCQ pages only have "Submit").
  const actionEls = document.querySelectorAll("button, a, [role='button']");
  for (const el of actionEls) {
    const t = (el.textContent || "").trim().toLowerCase();
    if (t === "run" || t === "run code" || t === "compile" || t === "run & submit") {
      return true;
    }
  }

  // No positive coding signal → treat as non-coding and skip.
  return false;
}


/**
 * Get cached LeetCode problem result
 */
async function getCachedLeetCodeResult(title) {
  try {
    const cacheKey = `leetcode_cache_${normalizeTitleForCache(title)}`;
    const result = await chrome.storage.local.get(cacheKey);

    if (result[cacheKey]) {
      const cached = result[cacheKey];

      // Positive results are cached for 30 days; "no confident match" results
      // for 7 days (shorter, so a later LeetCode addition can be picked up and
      // we don't permanently mark a real problem as unmatched).
      const POSITIVE_EXPIRY = 30 * 24 * 60 * 60 * 1000;
      const NEGATIVE_EXPIRY = 7 * 24 * 60 * 60 * 1000;
      const expiry = cached.found ? POSITIVE_EXPIRY : NEGATIVE_EXPIRY;
      const now = Date.now();

      if (cached.timestamp && now - cached.timestamp < expiry) {
        return cached.found
          ? {
              found: true,
              url: cached.url,
              title: cached.title,
              confidence: cached.confidence,
              fromCache: true,
            }
          : { found: false, fromCache: true };
      } else {
        // Cache expired, remove it
        await chrome.storage.local.remove(cacheKey);
      }
    }

    return null;
  } catch (e) {
    console.error("[Scaler++] Error reading cache:", e);
    return null;
  }
}

/**
 * Save a LeetCode lookup result (positive or negative) to cache.
 */
async function cacheLeetCodeResult(title, result) {
  try {
    const cacheKey = `leetcode_cache_${normalizeTitleForCache(title)}`;
    const cacheData = result.found
      ? {
          found: true,
          url: result.url,
          title: result.title,
          confidence: result.confidence,
          timestamp: Date.now(),
        }
      : { found: false, timestamp: Date.now() };

    await chrome.storage.local.set({ [cacheKey]: cacheData });
  } catch (e) {
    console.error("[Scaler++] Error saving to cache:", e);
  }
}

/**
 * Search for LeetCode problem via background script (avoids CORS).
 * Checks cache first for instant results. Passes the problem statement so the
 * background can verify the match on content, not just the title.
 */
async function searchLeetCodeProblem(title, statement) {
  try {
    // Check cache first (covers both confident matches and prior misses).
    const cachedResult = await getCachedLeetCodeResult(title);
    if (cachedResult) {
      return cachedResult;
    }

    // Not in cache, search via background script.
    const response = await chrome.runtime.sendMessage({
      action: "searchLeetCodeProblem",
      title: title,
      statement: statement || "",
    });

    // Cache both outcomes so we don't re-search the same problem every visit.
    if (response && !response.error) {
      await cacheLeetCodeResult(title, response);
    }

    return response;
  } catch (e) {
    console.error(
      "[Scaler++] Failed to communicate with background script:",
      e,
    );
    return { found: false, error: e.message };
  }
}

/**
 * Inject LeetCode link next to problem title
 */
function injectLeetCodeLink(leetcodeUrl) {
  // Find the target div (cr-p-heading__text)
  const headingTextDiv = document.querySelector(".cr-p-heading__text");

  if (!headingTextDiv) {
    return;
  }

  // Check if already injected
  if (headingTextDiv.querySelector(".scaler-leetcode-link")) {
    return;
  }

  // Create the LeetCode link container
  const linkContainer = document.createElement("a");
  linkContainer.href = leetcodeUrl;
  linkContainer.target = "_blank";
  linkContainer.className = "scaler-leetcode-link";
  linkContainer.style.marginLeft = "12px";
  linkContainer.style.display = "inline-flex";
  linkContainer.style.alignItems = "center";
  linkContainer.style.gap = "6px";
  linkContainer.style.padding = "4px 10px";
  linkContainer.style.backgroundColor = "#ffefd6ff";
  linkContainer.style.borderRadius = "6px";
  linkContainer.style.textDecoration = "none";
  linkContainer.style.transition = "all 0.2s ease";
  linkContainer.title = "View on LeetCode";

  // LeetCode icon
  const leetcodeIcon = document.createElement("img");
  leetcodeIcon.src = chrome.runtime.getURL("icons/leetcode_icon.png");
  leetcodeIcon.alt = "LeetCode";
  leetcodeIcon.style.width = "16px";
  leetcodeIcon.style.height = "16px";
  leetcodeIcon.style.objectFit = "contain";

  // External link icon
  const externalIcon = document.createElement("span");
  externalIcon.innerHTML = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="16" height="16">
  <path d="M 18 5 L 18 7 L 23.5625 7 L 11.28125 19.28125 L 12.71875 20.71875 L 25 8.4375 L 25 14 L 27 14 L 27 5 Z M 5 9 L 5 27 L 23 27 L 23 14 L 21 16 L 21 25 L 7 25 L 7 11 L 16 11 L 18 9 Z"/>
</svg>
`;
  externalIcon.alt = "External Link";
  externalIcon.style.width = "16px";
  externalIcon.style.height = "16px";
  externalIcon.style.objectFit = "contain";

  linkContainer.appendChild(leetcodeIcon);
  linkContainer.appendChild(externalIcon);

  // Add hover effect
  linkContainer.addEventListener("mouseenter", () => {
    linkContainer.style.backgroundColor = "#fcb84bff";
    linkContainer.style.transform = "translateY(-2px) scale(1.02)";
    linkContainer.style.boxShadow = "0 4px 12px rgba(252, 184, 75, 0.3)";
  });

  linkContainer.addEventListener("mouseleave", () => {
    linkContainer.style.backgroundColor = "#ffefd6ff";
    linkContainer.style.transform = "translateY(0) scale(1)";
    linkContainer.style.boxShadow = "none";
  });

  // Append to the heading div
  headingTextDiv.appendChild(linkContainer);
}

/**
 * Initialize LeetCode link feature
 */
async function initLeetCodeLink() {
  if (!isAssignmentProblemPage()) {
    return;
  }

  // Check if the feature is enabled in settings
  if (!shouldHide("leetcode-link")) {
    // Remove existing link if feature is disabled
    const existingLink = document.querySelector(".scaler-leetcode-link");
    if (existingLink) {
      existingLink.remove();
    }
    return;
  }

  // Check if LeetCode link is already injected - avoid duplicate searches
  const headingTextDiv = document.querySelector(".cr-p-heading__text");
  if (headingTextDiv && headingTextDiv.querySelector(".scaler-leetcode-link")) {
    // Already injected, skip search
    return;
  }

  // Wait for the page to fully load
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Gate: only coding/DSA problems get a LeetCode link. Skips MCQ/theory
  // questions in non-DSA subjects (OS, Memory Allocation, DBMS, …).
  if (!isLikelyCodingProblem()) {
    return;
  }

  const problemTitle = extractProblemTitle();

  if (!problemTitle) {
    return;
  }

  const problemStatement = extractProblemStatement();

  // The background scores the candidate on title + statement and only returns
  // found:true above its confidence threshold, so a found result here is
  // already high-confidence.
  const result = await searchLeetCodeProblem(problemTitle, problemStatement);

  if (result.found && result.url) {
    injectLeetCodeLink(result.url);
  }
}
