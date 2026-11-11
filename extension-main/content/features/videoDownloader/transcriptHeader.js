// ============================================================
// transcriptHeader.js
// The metadata header prepended to every downloaded transcript (course,
// lecture, start time, duration, model). Shared by the transcript processor,
// the versions page and the bulk download page so every path writes the same
// header.
// ============================================================

/**
 * Build the header for a lecture's transcript from Scaler's classroom
 * session + meta APIs. Missing values render "N/A" so the header keeps its
 * shape; returns "" without a classId.
 * @param {string} classId
 * @param {{provider?: string, model?: string}} attribution which model made it
 */
async function fetchMetadataHeader(classId, attribution = {}) {
  if (!classId) return "";
  
  let courseName = "N/A";
  let title = "N/A";
  let startTime = "N/A";
  let duration = "N/A";

  try {
    const [sessionRes, metaRes] = await Promise.allSettled([
      fetch(`https://www.scaler.com/api/v2/classroom/${classId}/session`, { credentials: "include" }),
      fetch(`https://www.scaler.com/api/v2/classroom/${classId}/meta`, { credentials: "include" })
    ]);

    if (sessionRes.status === "fulfilled" && sessionRes.value.ok) {
      try {
        const sessionJson = await sessionRes.value.json();
        const batchLesson = sessionJson?.data?.attributes?.batch_lesson;
        if (batchLesson) {
          title = batchLesson.title || "N/A";
          startTime = batchLesson.start_time || "N/A";
          duration = batchLesson.duration || "N/A";
        }
      } catch (e) {
        console.error("[Scaler++] Error parsing session metadata:", e);
      }
    }

    if (metaRes.status === "fulfilled" && metaRes.value.ok) {
      try {
        const metaJson = await metaRes.value.json();
        courseName = metaJson?.data?.attributes?.academy_module?.name || "N/A";
      } catch (e) {
        console.error("[Scaler++] Error parsing meta metadata:", e);
      }
    }
  } catch (err) {
    console.error("[Scaler++] Error fetching classroom metadata:", err);
  }

  // Format Start Time
  let formattedStartTime = startTime;
  if (startTime && startTime !== "N/A") {
    try {
      const date = new Date(startTime);
      if (!isNaN(date.getTime())) {
        formattedStartTime = date.toLocaleString();
      }
    } catch (e) {}
  }

  // Format Duration
  let formattedDuration = duration;
  if (typeof duration === "number") {
    formattedDuration = `${duration} minutes`;
  } else if (duration && duration !== "N/A") {
    formattedDuration = `${duration} minutes`;
  }

  // Attribution: which model produced the transcript. Older cached transcripts
  // predate these fields, so fall back to N/A rather than omitting the line —
  // keeps the header shape stable across downloads.
  const modelUsed = [attribution.provider, attribution.model]
    .filter(Boolean)
    .join(", ") || "N/A";

  return `Course Name: ${courseName}\n` +
         `Lecture Title: ${title}\n` +
         `Start Time: ${formattedStartTime}\n` +
         `Duration: ${formattedDuration}\n` +
         `Model use: ${modelUsed}\n` +
         `Downloaded via: Scaler++ Chrome Extension\n` +
         `Developer: Ritesh prajapati\n\n` +
         `==================================================\n\n`;
}
