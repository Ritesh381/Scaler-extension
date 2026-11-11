// ============================================================
// transcriptRanking.js
// Ranking and model matching for transcript versions. Shared by the versions
// page and the transcript processor, so "the best version" means the same
// thing in both places.
// ============================================================

/**
 * Order transcript versions best-first: net votes (upvotes − downvotes), then
 * download count, then recency — the same ranking the backend uses when it
 * serves "the" transcript for a lecture.
 * @param {object[]} versions version metadata from GET /api/transcript/versions
 * @returns {object[]} a new array, best first
 */
function rankTranscriptVersions(versions) {
  return [...versions].sort((a, b) => {
    const scoreA = (a.upvotes || 0) - (a.downvotes || 0);
    const scoreB = (b.upvotes || 0) - (b.downvotes || 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const dlA = a.downloadCount || 0;
    const dlB = b.downloadCount || 0;
    if (dlA !== dlB) return dlB - dlA;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

/**
 * Normalise a model id for comparison: trimmed and lower-case, so
 * "Whisper-Large-V3-Turbo " and "whisper-large-v3-turbo" match.
 */
function normalizeModelId(model) {
  return String(model || "").trim().toLowerCase();
}

/**
 * Versions produced by `model`, best first. A version with no recorded model
 * never matches: an old version's blank model says nothing about what ran.
 * @param {object[]} versions version metadata
 * @param {string} model the model about to be used
 * @returns {object[]}
 */
function findSameModelVersions(versions, model) {
  const wanted = normalizeModelId(model);
  if (!wanted) return [];
  return rankTranscriptVersions(
    versions.filter((v) => normalizeModelId(v.model) === wanted),
  );
}
