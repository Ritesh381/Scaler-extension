// ============================================
// utils/stringUtils.js
// String manipulation and text-matching helpers
// ============================================

/**
 * Escape regex special characters
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tokenize title for comparison
 */
function tokenize(str, filterShort = true) {
  const stopWords = new Set([
    "implement",
    "find",
    "calculate",
    "check",
    "determine",
    "generate",
    "construct",
    "of",
    "the",
    "a",
    "an",
    "in",
    "on",
    "for",
    "to",
    "with",
    "from",
    "by",
    "maximum",
    "minimum",
    "longest",
    "shortest",
    "largest",
    "smallest",
    "problem",
    "solution",
    "function",
    "class",
    "method",
  ]);

  return str
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => {
      if (!w) return false;
      if (stopWords.has(w)) return false;
      if (filterShort && w.length < 2) return false;
      return true;
    });
}

/**
 * Check if two titles are semantically similar
 */
function isTitleSimilar(t1, t2) {
  const tokens1 = tokenize(t1);
  const tokens2 = tokenize(t2);

  const set1 = tokens1.length > 0 ? tokens1 : tokenize(t1, false);
  const set2 = tokens2.length > 0 ? tokens2 : tokenize(t2, false);

  if (set1.length === 0 || set2.length === 0) return false;

  let matches = 0;
  const usedIndices = new Set();

  for (const w1 of set1) {
    for (let i = 0; i < set2.length; i++) {
      if (usedIndices.has(i)) continue;

      const w2 = set2[i];

      // 1. Exact Match
      if (w1 === w2) {
        matches++;
        usedIndices.add(i);
        break;
      }

      // 2. Prefix Match (Generalization for Power/Pow, Subsequence/Subseq)
      if (w1.length >= 3 && w2.length >= 3) {
        if (w1.startsWith(w2) || w2.startsWith(w1)) {
          matches++;
          usedIndices.add(i);
          break;
        }
      }
    }
  }

  // Overlap Thresholds
  const minLength = Math.min(set1.length, set2.length);

  if (minLength <= 2) return matches >= 1;
  if (minLength <= 4) return matches >= 2;

  return matches >= Math.ceil(minLength * 0.5);
}

/**
 * Normalize problem title for cache key
 */
function normalizeTitleForCache(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

// ============================================================
// Confidence-based problem matching
// ------------------------------------------------------------
// The old behaviour linked a LeetCode problem whenever two TITLES
// looked roughly similar (>=50% token overlap), and the Google
// fallback trusted the very first result URL. That produced wrong
// links for: (a) non-DSA questions that happen to share a heading,
// and (b) Scaler custom variations that reuse a LeetCode title but
// have a different problem statement.
//
// These helpers score a candidate on BOTH title and problem-statement
// overlap and return a 0..1 confidence so callers can refuse to link
// when confidence is low.
// ============================================================

/** Tight normalization for exact-title comparison ("Two Sum!" -> "twosum"). */
function normalizeTight(str) {
  return (str || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Strip HTML tags / entities down to plain text for content comparison. */
function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ") // drop tags
    .replace(/&[a-z]+;|&#\d+;/gi, " ") // drop entities
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Token-overlap similarity between two titles, returned as a 0..1 Jaccard
 * score (matched tokens / union of tokens). Uses the same exact+prefix token
 * matching as isTitleSimilar, but yields a graded score instead of a boolean
 * so callers can fold it into a confidence value.
 *
 * Example: "Two Sum" vs "Two Sum II" scores ~0.67 (NOT a confident match),
 * whereas reordered-but-identical titles score 1.0.
 */
function titleMatchScore(t1, t2) {
  if (normalizeTight(t1) && normalizeTight(t1) === normalizeTight(t2)) return 1;

  let set1 = tokenize(t1);
  let set2 = tokenize(t2);
  if (set1.length === 0) set1 = tokenize(t1, false);
  if (set2.length === 0) set2 = tokenize(t2, false);
  if (set1.length === 0 || set2.length === 0) return 0;

  let matches = 0;
  const used = new Set();
  for (const w1 of set1) {
    for (let i = 0; i < set2.length; i++) {
      if (used.has(i)) continue;
      const w2 = set2[i];
      if (
        w1 === w2 ||
        (w1.length >= 3 &&
          w2.length >= 3 &&
          (w1.startsWith(w2) || w2.startsWith(w1)))
      ) {
        matches++;
        used.add(i);
        break;
      }
    }
  }

  const union = set1.length + set2.length - matches;
  return union > 0 ? matches / union : 0;
}

/**
 * Containment overlap between two problem statements, 0..1.
 *
 * Uses intersection / size-of-smaller-set ("containment") rather than Jaccard
 * so that a correctly-matched problem still scores high even when Scaler's page
 * text is much longer/noisier than LeetCode's (or vice-versa). A genuinely
 * different problem (Scaler custom variation) shares few distinctive tokens and
 * scores low.
 */
function statementSimilarity(textA, textB) {
  const toSet = (t) =>
    new Set(tokenize(stripHtml(t), false).filter((w) => w.length > 2));
  const a = toSet(textA);
  const b = toSet(textB);
  if (a.size === 0 || b.size === 0) return 0;

  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}

/**
 * Combine title + statement similarity into a single 0..1 confidence.
 *
 * @param {object} p
 * @param {string} p.scalerTitle       - problem title from the Scaler page
 * @param {string} p.lcTitle           - candidate LeetCode title
 * @param {string} [p.scalerStatement] - problem statement text from Scaler
 * @param {string} [p.lcContent]       - LeetCode problem `content` (HTML ok)
 * @returns {{confidence:number, titleScore:number, stmtScore:(number|null), exactTitle:boolean}}
 */
function computeMatchConfidence({
  scalerTitle,
  lcTitle,
  scalerStatement,
  lcContent,
}) {
  const titleScore = titleMatchScore(scalerTitle, lcTitle);
  const exactTitle =
    !!normalizeTight(scalerTitle) &&
    normalizeTight(scalerTitle) === normalizeTight(lcTitle);

  const haveStatements = !!scalerStatement && !!lcContent;
  const stmtScore = haveStatements
    ? statementSimilarity(scalerStatement, lcContent)
    : null;

  let confidence;
  if (stmtScore === null) {
    // No statement to verify against — lean on the title but stay conservative,
    // since title-only is exactly what caused the wrong links before.
    confidence = exactTitle ? 0.8 : titleScore * 0.7;
  } else {
    confidence = 0.5 * titleScore + 0.5 * stmtScore;
    // Exact title backed by a recognizably similar statement → high confidence.
    if (exactTitle && stmtScore >= 0.25) {
      confidence = Math.max(confidence, 0.85);
    }
    // Exact title but the statements barely overlap → almost certainly a Scaler
    // custom variation reusing the heading. Suppress hard.
    if (exactTitle && stmtScore < 0.12) {
      confidence = Math.min(confidence, 0.3);
    }
  }

  return { confidence, titleScore, stmtScore, exactTitle };
}

/**
 * The numeric class id in a Scaler class URL ("/class/12345/…"), or null.
 * @param {string} href absolute or relative URL
 */
function extractClassId(href) {
  const match = String(href || "").match(/\/class\/(\d+)/);
  return match ? match[1] : null;
}

// Make helpers reachable when this file is loaded via importScripts() in the
// service worker (where there is no DOM but globalThis exists). In content
// scripts the top-level function declarations are already global.
if (typeof globalThis !== "undefined") {
  globalThis.normalizeTight = normalizeTight;
  globalThis.stripHtml = stripHtml;
  globalThis.titleMatchScore = titleMatchScore;
  globalThis.statementSimilarity = statementSimilarity;
  globalThis.computeMatchConfidence = computeMatchConfidence;
  globalThis.tokenize = tokenize;
  globalThis.isTitleSimilar = isTitleSimilar;
  globalThis.normalizeTitleForCache = normalizeTitleForCache;
}
