// ============================================================
// background/leetcodeLink.js — LeetCode Problem Search
// ─────────────────────────────────────────────────────────────
// Loaded by background.js via importScripts() AFTER
// content/utils/stringUtils.js, which provides the shared matching
// helpers (titleMatchScore, statementSimilarity, computeMatchConfidence,
// normalizeTight, tokenize, isTitleSimilar).
//
// Handles the "searchLeetCodeProblem" message from content scripts:
//   1. Query the LeetCode GraphQL search for candidate problems.
//   2. For the strongest title candidates, fetch the problem `content`
//      and score the match on BOTH title AND problem statement.
//   3. Fall back to a Google site-search, scoring every candidate slug
//      (not just the first) the same way.
//   4. Only return a result when confidence clears ACCEPT_THRESHOLD,
//      so non-DSA questions and custom Scaler variations are dropped.
// ============================================================

const LEETCODE_GRAPHQL_URL = "https://leetcode.com/graphql";

// Minimum combined (title + statement) confidence required before we surface a
// LeetCode link. Tuned to favour precision — better no icon than a wrong icon.
const ACCEPT_THRESHOLD = 0.6;

// How many GraphQL search candidates to consider / fetch content for.
const MAX_CANDIDATES = 5;
const MAX_CONTENT_FETCHES = 3;

// ─── Message Listener ────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "searchLeetCodeProblem") {
    handleSearch(request.title, request.statement)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("[Scaler++ LeetCode] Search error:", error);
        sendResponse({ found: false, error: error.message });
      });
    return true; // keep message channel open for async response
  }
});

// ─── Orchestration ───────────────────────────────────────────

/**
 * @param {string} title     - Raw problem title from the Scaler page
 * @param {string} [statement] - Problem statement text from the Scaler page
 */
async function handleSearch(title, statement) {
  const cleanTitle = (title || "").trim();
  if (!cleanTitle) return { found: false };

  // 1. LeetCode GraphQL search — primary, highest-signal source.
  try {
    const gql = await searchViaGraphQL(cleanTitle, statement);
    if (gql.found) return gql;
  } catch (e) {
    // fall through to Google
  }

  // 2. Google site-search fallback.
  try {
    return await searchViaGoogle(cleanTitle, statement);
  } catch (e) {
    return { found: false };
  }
}

/**
 * Pick the highest-confidence candidate (slug list) by fetching each one's
 * LeetCode content and scoring title + statement. Returns an accepted match or
 * { found: false }.
 *
 * @param {string} scalerTitle
 * @param {string} scalerStatement
 * @param {Array<{title?:string, titleSlug:string}>} candidates
 */
async function rankCandidates(scalerTitle, scalerStatement, candidates) {
  // De-dupe by slug and cap how many problem bodies we fetch.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (c && c.titleSlug && !seen.has(c.titleSlug)) {
      seen.add(c.titleSlug);
      unique.push(c);
    }
  }

  let best = null;
  let fetches = 0;

  for (const cand of unique) {
    if (fetches >= MAX_CONTENT_FETCHES) break;
    fetches++;

    const detail = await fetchQuestionDetail(cand.titleSlug);
    if (!detail) continue;

    const { confidence } = computeMatchConfidence({
      scalerTitle,
      lcTitle: detail.title,
      scalerStatement,
      lcContent: detail.content,
    });

    if (!best || confidence > best.confidence) {
      best = {
        confidence,
        url: `https://leetcode.com/problems/${detail.titleSlug}/`,
        title: detail.title,
      };
    }

    // Early exit: a confident exact match won't be beaten.
    if (confidence >= 0.85) break;
  }

  if (best && best.confidence >= ACCEPT_THRESHOLD) {
    return {
      found: true,
      url: best.url,
      title: best.title,
      confidence: best.confidence,
    };
  }
  return { found: false };
}

// ─── LeetCode GraphQL search ──────────────────────────────────

async function searchViaGraphQL(title, statement) {
  const query = `
    query problemsetQuestionList($categorySlug: String, $limit: Int, $skip: Int, $filters: QuestionListFilterInput) {
      problemsetQuestionList: questionList(
        categorySlug: $categorySlug
        limit: $limit
        skip: $skip
        filters: $filters
      ) {
        questions: data {
          title
          titleSlug
        }
      }
    }
  `;

  const variables = {
    categorySlug: "",
    limit: MAX_CANDIDATES,
    skip: 0,
    filters: { searchKeywords: title },
  };

  const response = await bgFetch(LEETCODE_GRAPHQL_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) return { found: false };

  const data = await response.json();
  const questions = data.data?.problemsetQuestionList?.questions || [];
  if (questions.length === 0) return { found: false };

  // Pre-rank by title so we fetch content for the most promising first.
  const ordered = questions
    .map((q) => ({ ...q, _ts: titleMatchScore(title, q.title) }))
    .sort((a, b) => b._ts - a._ts);

  return rankCandidates(title, statement, ordered);
}

// ─── Google search fallback ───────────────────────────────────

async function searchViaGoogle(title, statement) {
  const q = encodeURIComponent(`${title} site:leetcode.com/problems`);
  const searchUrl = `https://www.google.com/search?q=${q}`;

  const response = await bgFetch(searchUrl);
  if (!response.ok) throw new Error("Google Search Failed");

  const text = await response.text();

  // Collect ALL candidate slugs from the results page (was: first only).
  const regex = /https:\/\/leetcode\.com\/problems\/([a-z0-9-]+)\//g;
  const slugs = [];
  let m;
  while ((m = regex.exec(text)) !== null) {
    slugs.push({ titleSlug: m[1] });
    if (slugs.length >= MAX_CANDIDATES) break;
  }

  if (slugs.length === 0) return { found: false };
  return rankCandidates(title, statement, slugs);
}

// ─── Question detail fetch ────────────────────────────────────

/**
 * Fetch a LeetCode problem's title + statement content by slug.
 * `content` is public for non-premium problems; premium ones return null
 * content, in which case the match falls back to title-only confidence.
 */
async function fetchQuestionDetail(slug) {
  const query = `
    query questionData($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionId
        title
        titleSlug
        content
        difficulty
      }
    }
  `;

  try {
    const response = await bgFetch(LEETCODE_GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { titleSlug: slug } }),
    });

    if (!response.ok) return null;
    const data = await response.json();
    const question = data.data?.question;
    if (!question || !question.title) return null;

    return {
      title: question.title,
      titleSlug: question.titleSlug || slug,
      content: question.content || "",
      difficulty: question.difficulty || "",
    };
  } catch (e) {
    return null;
  }
}
