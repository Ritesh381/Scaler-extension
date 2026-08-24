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
    const processorUrl = chrome.runtime.getURL(
      `content/features/videoDownloader/${htmlPage}?url=${encodeURIComponent(url)}&type=${type}&title=${encodeURIComponent(title)}&lectureSlug=${encodeURIComponent(lectureSlug)}&classId=${encodeURIComponent(classId)}&sourceTabId=${sender.tab?.id || ''}`,
    );

    chrome.tabs.create({ url: processorUrl }, (tab) => {
      console.log(`[Scaler++] Opened ${htmlPage} tab ID: ${tab.id}`);
    });

    sendResponse({ status: "started" });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabVideoStreams[tabId];
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" && changeInfo.url) {
    delete tabVideoStreams[tabId];
  }
});
