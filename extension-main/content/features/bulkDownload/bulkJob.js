// ============================================================
// features/bulkDownload/bulkJob.js
// Pure helpers for the bulk download page: read the job the subject page
// sent, name the files, and run work with a concurrency limit.
// ============================================================

/**
 * The job from the page's URL hash (see START_BULK_DOWNLOAD in
 * background/videoTracker.js), normalised, or null when it is unusable.
 * Lectures without a numeric class id are dropped.
 */
function parseBulkJob(hash) {
  try {
    const job = JSON.parse(decodeURIComponent(String(hash || "").replace(/^#/, "")));
    const lectures = (Array.isArray(job?.lectures) ? job.lectures : []).filter(
      (l) => l && /^\d+$/.test(String(l.classId)),
    );
    if (!lectures.length) return null;
    return {
      subject: String(job.subject || ""),
      types: {
        transcript: !!job.types?.transcript,
        video: !!job.types?.video,
        audio: !!job.types?.audio,
      },
      generateMissing: !!job.generateMissing,
      sourceTabId: Number.isInteger(job.sourceTabId) ? job.sourceTabId : null,
      lectures: lectures.map((l, i) => ({
        index: Number(l.index) || i + 1,
        classId: String(l.classId),
        title: String(l.title || ""),
        stamp: String(l.stamp || ""),
        url: String(l.url || ""),
      })),
    };
  } catch (_) {
    return null;
  }
}

/**
 * `text` made safe as a file name: no path or reserved characters, no
 * control characters, whitespace collapsed, no trailing dots, capped length.
 */
function bulkSafeName(text, max = 120) {
  return String(text || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, "");
}

/**
 * "03 - 18 Aug - Shell Scripting – Part 2.mp4": the lecture's position in the
 * subject (so the folder sorts chronologically), its date, title and part.
 * @param {{index: number, stamp: string, title: string, classId: string}} lecture
 * @param {string} ext file extension without the dot
 * @param {string} [partLabel] for one part of a multi-part lecture
 */
function bulkFileName(lecture, ext, partLabel = "") {
  const num = String(lecture.index).padStart(2, "0");
  const m = String(lecture.stamp).match(/^(\d{1,2})\s+([A-Za-z]{3})/);
  const date = m ? `${m[1]} ${m[2].charAt(0).toUpperCase()}${m[2].slice(1).toLowerCase()}` : "";
  const title = bulkSafeName(lecture.title) || `Lecture ${lecture.classId}`;
  const part = partLabel ? ` – ${bulkSafeName(partLabel, 30)}` : "";
  return [num, date, title + part].filter(Boolean).join(" - ") + "." + ext;
}

/**
 * Run `worker(item, i)` over `items`, at most `limit` at a time, in order.
 * Once `signal` aborts no new item starts. A worker that throws doesn't stop
 * the others — workers report their own failures.
 */
async function runWithConcurrency(items, limit, worker, signal) {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !(signal && signal.aborted)) {
      const i = next++;
      try {
        await worker(items[i], i);
      } catch (_) {
        /* reported by the worker */
      }
    }
  };
  const lanes = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: lanes }, lane));
}
