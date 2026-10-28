// ============================================================
// videoProcessor.js
// Concurrent HLS stream downloader with audio extraction
// ============================================================

const logsElem = document.getElementById("logs");
const statusText = document.getElementById("status-text");
const progressBar = document.getElementById("progress-bar");
const chunksText = document.getElementById("progress-chunks");
const percentText = document.getElementById("progress-percent");
const startBtn = document.getElementById("start-btn");

function log(msg) {
  const p = document.createElement("div");
  p.innerText = `> ${msg}`;
  logsElem.appendChild(p);
  logsElem.scrollTop = logsElem.scrollHeight;
}

// ── Get params from URL ──
const urlParams = new URLSearchParams(window.location.search);
const m3u8Url = urlParams.get("url");
const downloadType = urlParams.get("type") || "video";
const videoTitle = urlParams.get("title") || "";
const lectureSlug = urlParams.get("lectureSlug") || "";
const sourceTabId = parseInt(urlParams.get("sourceTabId"), 10);

// The lectureSlug is the unique identifier for cache lookups.
// It comes from Scaler's classroom meta API (data.attributes.slug)
// and is unique per lecture even across batches that share the same class title.
const cacheKey = lectureSlug || videoTitle;

// ── Show video title if available ──
const titleElem = document.getElementById("video-title");
if (titleElem && videoTitle) {
  titleElem.textContent = videoTitle;
  titleElem.style.display = "block";
}

if (!m3u8Url) {
  log("Error: No M3U8 URL provided.");
  statusText.innerText = "Error: Invalid Stream Data";
  startBtn.disabled = true;
} else {
  log(`Mode: ${downloadType.toUpperCase()}`);
  log(`Stream: ${m3u8Url.substring(0, 60)}...`);
  if (downloadType === "audio") {
    log("Audio extraction enabled — will strip video tracks from chunks.");
  }
}

// ── Fire-and-forget download tracking (called only after success) ──

function trackCompletedDownload(type) {
  try {
    chrome.storage.sync.get(["scaler_user"], (result) => {
      const email = result?.scaler_user?.email;
      if (email && chrome.runtime?.id) {
        chrome.runtime.sendMessage({
          action: "trackDownload",
          email,
          downloadType: type,
          lecture: videoTitle || "",
          lectureSlug: cacheKey,
        });
      }
    });
  } catch (_) {
    /* fail silently — tracking should never break downloads */
  }
}

// ── Download engine (hlsDownloadEngine.js) ──

const engine = createHlsEngine({
  sourceTabId: Number.isNaN(sourceTabId) ? undefined : sourceTabId,
  type: downloadType,
  onLog: log,
  onProgress: (written, total) => {
    const pct = ((written / total) * 100).toFixed(1);
    progressBar.style.width = pct + "%";
    chunksText.innerText = `${written} / ${total} chunks`;
    percentText.innerText = `${pct}%`;
  },
});

// ── Main Download Flow ──

// Derive a clean filename from the video title, falling back to 'Scaler_Lecture'
function getSuggestedName(ext) {
  if (videoTitle) {
    const slug = videoTitle
      .replace(/[\\/:*?"<>|]/g, "") // strip illegal filename chars
      .replace(/\s+/g, "_") // spaces → underscores
      .substring(0, 80) // cap length
      .replace(/_+$/, ""); // trim trailing underscores
    if (slug) return `${slug}.${ext}`;
  }
  return `Scaler_Lecture.${ext}`;
}

startBtn.addEventListener("click", async () => {
  const ext = downloadType === "audio" ? "mp3" : "mp4";
  const mimeType = downloadType === "audio" ? "audio/mpeg" : "video/mp4";

  // The File System Access API lets us stream chunks straight to disk, keeping
  // RAM flat (~5-10 MB) regardless of video length. It needs transient user
  // activation, so we MUST request the file handle here — synchronously inside
  // the click handler, before any network await burns the activation window.
  // Brave (explicitly) and Firefox (no API) fall back to memory buffering.
  const supportsFilePicker =
    typeof window.showSaveFilePicker === "function" && !navigator.brave;

  let writable = null;
  if (supportsFilePicker) {
    try {
      const fileHandle = await window.showSaveFilePicker({
        suggestedName: getSuggestedName(ext),
        types: [
          {
            description: downloadType === "audio" ? "Audio File" : "Video File",
            accept:
              downloadType === "audio"
                ? { "audio/mpeg": [".mp3"] }
                : { "video/mp4": [".mp4"] },
          },
        ],
      });
      writable = await fileHandle.createWritable();
    } catch (err) {
      if (err.name === "AbortError") {
        log("File selection cancelled.");
        return;
      }
      // Any other error (e.g. Brave blocking) → fall back to memory buffering.
      log("Save picker unavailable — switching to in-memory download...");
      writable = null;
    }
  }

  try {
    startBtn.disabled = true;
    statusText.innerText = "Analyzing stream...";
    const startTime = Date.now();

    // 1–2. Manifest → media playlist → segment URLs
    const segments = await engine.resolveSegments(m3u8Url);

    let audioExtractor = null;
    if (downloadType === "audio") {
      audioExtractor = new TSAudioExtractor();
      log("Audio extractor initialized — stripping video from each chunk.");
    }

    statusText.innerText = `Downloading ${downloadType} (${HLS_CONCURRENCY}x parallel)...`;

    if (writable) {
      // ── STREAMING PATH (Chrome / Edge) ──
      // Each chunk is written to disk as it arrives. RAM stays flat.
      log("Streaming chunks directly to disk — RAM usage stays minimal.");
      try {
        await engine.downloadConcurrently(segments, writable, audioExtractor);
        await writable.close();
      } catch (err) {
        // Don't leave a half-written file dangling on disk.
        try {
          await writable.abort();
        } catch (_) {
          /* ignore */
        }
        throw err;
      }
    } else {
      // ── FALLBACK PATH (Brave / Firefox) ──
      // Buffer in memory, then save via blob URL. Higher RAM use — only used
      // where the File System Access API is unavailable.
      log("Downloading to memory — save will start after download completes.");
      const memBuffer = await engine.downloadToMemory(segments, audioExtractor);
      const blob = new Blob([memBuffer], { type: mimeType });

      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = getSuggestedName(ext);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✅ Download finished in ${elapsed}s! Check your Downloads folder.`);
    statusText.innerText = `🎉 Download Complete! (${elapsed}s)`;
    progressBar.style.background = "#28a745";

    // ── Track completed download ──────────────────────────────
    trackCompletedDownload(downloadType);
  } catch (err) {
    log(`❌ Error: ${err.message}`);
    console.error(err);
    statusText.innerText = "Download Failed!";
    startBtn.disabled = false;
  }
});
