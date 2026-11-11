// ── Stream URL store ────────────────────────────────────────────────────────
// Keyed by tabId → the best .m3u8 URL seen for that tab.
//
// HOW IT WORKS (no broad host_permissions needed):
//   The content script (runs only on scaler.com per manifest "matches") uses
//   PerformanceObserver to watch every resource request the page makes.
//   When it sees a .m3u8 URL — from ANY CDN (CloudFront, media.scaler.com,
//   or any future provider) — it forwards it here via chrome.runtime.sendMessage.
//   Because the sender is always a scaler.com content script, no extra
//   host_permissions are required. Scoping is free.
// ────────────────────────────────────────────────────────────────────────────
const tabVideoStreams = {};

function isMasterPlaylist(url) {
  return url.includes("master") || url.includes("index");
}

// ── Capture tabs (multi-part lectures) ─────────────────────────────────────
// A recording split into parts streams each part separately, and the player
// only requests a part's stream once that part plays. To learn every part's
// URL without touching the user's own player, the lecture is opened in an
// inactive, muted tab where content/features/videoDownloader/playlistCapture.js
// plays each part once and reports back with CAPTURE_RESULT. Results are
// cached per lecture for a few minutes: the URLs are signed and expire.
// ────────────────────────────────────────────────────────────────────────────
// Must stay above the capture job's own worst case (playlistCapture.js).
const CAPTURE_TIMEOUT_MS = 120000;
const CAPTURE_CACHE_MS = 10 * 60 * 1000;
const MAX_CAPTURE_TABS = 2;

const captureTabs = new Map(); // tabId -> settle(result)
const captureCache = new Map(); // lecture key -> { at, result }
const captureInflight = new Map(); // lecture key -> Promise<result>
const captureQueue = []; // jobs waiting for a free capture slot
let activeCaptures = 0;

/**
 * Every part's stream for a lecture, via a capture tab.
 * Resolves { ok, parts: [{label, minutes, url}] } or { ok: false, error }.
 */
function captureLectureStreams(lectureUrl, key) {
  const hit = captureCache.get(key);
  if (hit && Date.now() - hit.at < CAPTURE_CACHE_MS) return Promise.resolve(hit.result);
  if (captureInflight.has(key)) return captureInflight.get(key);

  const promise = new Promise((resolve) => {
    captureQueue.push({ lectureUrl, resolve });
    pumpCaptureQueue();
  }).then((result) => {
    captureInflight.delete(key);
    if (result.ok) captureCache.set(key, { at: Date.now(), result });
    return result;
  });
  captureInflight.set(key, promise);
  return promise;
}

function pumpCaptureQueue() {
  while (activeCaptures < MAX_CAPTURE_TABS && captureQueue.length) {
    const job = captureQueue.shift();
    activeCaptures++;
    runCaptureTab(job.lectureUrl).then((result) => {
      activeCaptures--;
      job.resolve(result);
      pumpCaptureQueue();
    });
  }
}

function runCaptureTab(lectureUrl) {
  return new Promise((resolve) => {
    chrome.tabs.create({ url: lectureUrl, active: false }, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ ok: false, error: "Could not open the lecture in a background tab." });
        return;
      }
      const tabId = tab.id;
      chrome.tabs.update(tabId, { muted: true }, () => void chrome.runtime.lastError);

      let timer = null;
      const settle = (result) => {
        if (!captureTabs.has(tabId)) return;
        captureTabs.delete(tabId);
        clearTimeout(timer);
        chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
        resolve(result);
      };
      captureTabs.set(tabId, settle);
      timer = setTimeout(
        () => settle({ ok: false, error: "Timed out finding the lecture's parts." }),
        CAPTURE_TIMEOUT_MS,
      );
    });
  });
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {

  // ── Stream URL captured by PerformanceObserver in the content script ──────
  // The content script runs only on scaler.com (manifest matches), so
  // sender.tab is always a Scaler tab — no extra host_permissions needed.
  if (request.type === "M3U8_CAPTURED") {
    const tabId = sender.tab?.id;
    if (!tabId || tabId === -1) return;
    const url = request.url;
    if (!url || !url.includes(".m3u8")) return;

    const existing = tabVideoStreams[tabId];
    if (!existing) {
      tabVideoStreams[tabId] = url;
      console.log(`[Scaler++] Stream captured via PerformanceObserver (${new URL(url).hostname}): ${url.substring(0, 80)}...`);
    } else if (isMasterPlaylist(url) && !isMasterPlaylist(existing)) {
      tabVideoStreams[tabId] = url;
      console.log("[Scaler++] Stream upgraded to master playlist.");
    }
    return; // fire-and-forget, no response needed
  }

  // ── Multi-part lectures: capture tabs ───────────────────────────────────
  if (request.type === "CAPTURE_LECTURE_STREAMS") {
    captureLectureStreams(request.lectureUrl, request.lectureKey || request.lectureUrl).then(
      sendResponse,
    );
    return true; // async response
  }
  if (request.type === "IS_CAPTURE_TAB") {
    sendResponse({ capture: captureTabs.has(sender.tab?.id) });
    return;
  }
  if (request.type === "CAPTURE_RESULT") {
    const settle = captureTabs.get(sender.tab?.id);
    if (settle) {
      settle(
        request.ok
          ? { ok: true, parts: request.parts || [] }
          : { ok: false, error: request.error || "Capture failed." },
      );
    }
    return;
  }

  if (request.type === "GET_VIDEO_URL") {
    sendResponse({ url: tabVideoStreams[sender.tab?.id] || null });
  } else if (request.type === "INITIATE_DOWNLOAD") {
    const url = request.payload.url;
    const type = request.payload.type;
    const title = request.payload.title || "";
    const lectureSlug = request.payload.lectureSlug || "";
    const classId = request.payload.classId || "";
    // Transcripts always land on the versions page: a lecture can have many
    // transcriptions, and picking or contributing one belongs there. The
    // versions page links on to transcriptProcessor.html itself.
    const htmlPage =
      type === "transcript" ? "transcriptVersions.html" : "videoProcessor.html";
    // Multi-part lectures also carry every part's stream: [{label, url}].
    const parts = Array.isArray(request.payload.parts) && request.payload.parts.length
      ? `&parts=${encodeURIComponent(JSON.stringify(request.payload.parts))}`
      : "";
    const processorUrl = chrome.runtime.getURL(
      `content/features/videoDownloader/${htmlPage}?url=${encodeURIComponent(url)}&type=${type}&title=${encodeURIComponent(title)}&lectureSlug=${encodeURIComponent(lectureSlug)}&classId=${encodeURIComponent(classId)}&sourceTabId=${sender.tab?.id || ''}${parts}`,
    );

    chrome.tabs.create({ url: processorUrl }, (tab) => {
      console.log(`[Scaler++] Opened ${htmlPage} tab ID: ${tab.id}`);
    });

    sendResponse({ status: "started" });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideoStreams[tabId];
  const settle = captureTabs.get(tabId);
  if (settle) settle({ ok: false, error: "The background tab was closed before it finished." });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    delete tabVideoStreams[tabId];
  }
});
