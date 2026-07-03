// ============================================================
// videoDownloader.js
// Injects a download button into Scaler recordings.
// ============================================================

class VideoDownloader {
  constructor() {
    this.enabled = true;
    this._lectureSlug = null; // unique slug fetched from Scaler's classroom meta API
    this._lastSlugUrl = null; // tracks which URL the slug was fetched for
    this._slugPromise = null; // shared promise to avoid duplicate fetches
    this._networkObserver = null; // watches for .m3u8 requests
    this.init();
  }

  async init() {
    // Check if the feature is enabled in settings
    try {
      const result = await chrome.storage.sync.get("cleanerSettings");
      if (
        result.cleanerSettings &&
        result.cleanerSettings["video-downloader"] === false
      ) {
        this.enabled = false;
      }
    } catch (e) {
      // Default to enabled
    }

    // Listen for live toggle changes from the popup and proxy requests
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.action === "toggleSetting" && msg.key === "video-downloader") {
        this.enabled = msg.value;
        const existing = document.getElementById("scaler-video-downloader");
        if (!msg.value && existing) {
          existing.remove();
          // ── Fix #1: disconnect observer when feature is disabled ──
          this._observer?.disconnect();
          this._observer = null;
          this._networkObserver?.disconnect();
          this._networkObserver = null;
        } else if (msg.value) {
          this.checkAndInject();
          this._startObserver();
          // Re-arm the .m3u8 capture too — the disable branch tore it down, so
          // without this the network observer stays dead after an off→on toggle
          // and every download fails ("could not locate stream"). Self-guards
          // against double-start.
          this._startNetworkObserver();
        }
      } else if (msg.action === "FETCH_PROXY") {
        // Proxy fetch request to bypass CORS for CloudFront chunks
        fetch(msg.url)
          .then(async res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (msg.type === "text") {
              return { data: await res.text() };
            } else {
              // Convert ArrayBuffer to Array for safe message passing
              const buffer = await res.arrayBuffer();
              return { data: Array.from(new Uint8Array(buffer)) };
            }
          })
          .then(result => sendResponse({ success: true, data: result.data }))
          .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Keep message channel open for async response
      }
    });

    if (this.enabled) {
      this.checkAndInject();
    }

    this._startObserver();
    this._startNetworkObserver();
  }

  /**
   * Starts a PerformanceObserver to watch for .m3u8 network requests made by the page.
   * This replaces the need for background webRequest listeners with broad host permissions.
   */
  _startNetworkObserver() {
    if (this._networkObserver) return;

    try {
      this._networkObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.initiatorType !== 'xmlhttprequest' && entry.initiatorType !== 'fetch' && entry.initiatorType !== 'other') {
             continue;
          }
          const url = entry.name;
          if (url && url.includes(".m3u8")) {
            chrome.runtime.sendMessage({
              type: "M3U8_CAPTURED",
              url: url
            }).catch(() => { /* fail silently if background is inactive */ });
          }
        }
      });
      
      this._networkObserver.observe({ type: "resource", buffered: true });
    } catch (e) {
      console.warn("[Scaler++] Failed to start PerformanceObserver:", e);
    }
  }

  /**
   * Extract the class ID from the current URL and fetch the unique lecture slug
   * from Scaler's classroom meta API.
   *
   * URL pattern: /academy/mentee-dashboard/class/{classId}/session...
   * API:         https://www.scaler.com/api/v2/classroom/{classId}/meta
   * Slug:        response.data.attributes.slug
   *
   * Returns the slug string, or null if it couldn't be resolved.
   * Caches the result per URL so repeated calls are cheap.
   */
  async _fetchLectureSlug() {
    const currentUrl = window.location.pathname;

    // Already fetched for this URL — return cached
    if (this._lectureSlug && this._lastSlugUrl === currentUrl) {
      return this._lectureSlug;
    }

    // If a fetch is already in progress for this URL, wait for it
    if (this._slugPromise && this._lastSlugUrl === currentUrl) {
      return this._slugPromise;
    }

    // Reset for new URL
    this._lectureSlug = null;
    this._lastSlugUrl = currentUrl;

    this._slugPromise = (async () => {
      try {
        const match = currentUrl.match(/\/class\/(\d+)/);
        if (!match) {
          console.warn(
            "[Scaler++] Could not extract class ID from URL:",
            currentUrl,
          );
          return null;
        }

        const classId = match[1];
        console.log(
          `[Scaler++] Fetching lecture slug for class ID: ${classId}`,
        );

        const res = await fetch(
          `https://www.scaler.com/api/v2/classroom/${classId}/meta`,
        );
        if (!res.ok) {
          console.warn(
            `[Scaler++] Classroom meta API returned HTTP ${res.status}`,
          );
          return null;
        }

        const json = await res.json();
        const slug = json?.data?.attributes?.slug;
        if (slug) {
          this._lectureSlug = slug;
          console.log(`[Scaler++] Lecture slug resolved: ${slug}`);
          return slug;
        } else {
          console.warn(
            "[Scaler++] Slug not found in classroom meta response.",
          );
          return null;
        }
      } catch (e) {
        console.warn("[Scaler++] Failed to fetch lecture slug:", e.message);
        return null;
      } finally {
        this._slugPromise = null;
      }
    })();

    return this._slugPromise;
  }

  _startObserver() {
    // ── Fix #1: debounced MutationObserver, stored for disconnect ──
    if (this._observer) return; // already watching
    let _debounceTimer = null;
    this._observer = new MutationObserver(() => {
      clearTimeout(_debounceTimer);
      _debounceTimer = setTimeout(() => {
        if (
          this.enabled &&
          !document.getElementById("scaler-video-downloader")
        ) {
          this.checkAndInject();
        }
      }, 300);
    });
    this._observer.observe(document.body, { childList: true, subtree: true });
  }

  checkAndInject() {
    // 1. Safely look for vp-controls and the target header container
    // The presence of .vp-controls is the primary indicator that this is a recording,
    // as live sessions do not have it.
    const vpControls = document.querySelector(".vp-controls");
    const headerActions = document.querySelectorAll(".m-header__actions")[1];

    if (!vpControls || !headerActions) {
      return;
    }

    // 3. Inject only if we haven't already
    if (document.getElementById("scaler-video-downloader")) {
      return;
    }

    // Pre-fetch slug when we detect a recording page (best-effort, non-blocking)
    this._fetchLectureSlug();

    this.injectButton(headerActions);
  }

  injectButton(headerActions) {
    const container = document.createElement("div");
    container.id = "scaler-video-downloader";
    container.className = "m-header__action dropdown"; // mimic existing classes
    container.style.position = "relative";
    container.style.display = "inline-block";
    container.style.marginRight = "8px";

    const button = document.createElement("a");
    button.className = "tappable btn btn-icon m-btn btn-large m-btn--default";
    button.title = "Download Recording";

    // Using a generic download icon or generic SVG since icon-download might not be defined
    button.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-top:2px"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

    // Add dropdown menu container
    const menu = document.createElement("div");
    menu.className = "downloader-menu";
    menu.style.display = "none";
    menu.style.position = "absolute";
    menu.style.top = "100%";
    menu.style.right = "0";
    menu.style.background = "#2C2D35"; // Match Scaler dark theme commonly used
    menu.style.border = "1px solid #4a4a52";
    menu.style.borderRadius = "6px";
    menu.style.padding = "8px 0";
    menu.style.marginTop = "4px";
    menu.style.zIndex = "9999";
    menu.style.minWidth = "150px";
    menu.style.boxShadow = "0 8px 16px rgba(0,0,0,0.3)";

    // Audio Option
    const audioOption = document.createElement("div");
    audioOption.innerText = "Audio";
    this.styleOption(audioOption);
    audioOption.onclick = () => {
      this.startDownload("audio");
      menu.style.display = "none";
    };

    // Video Option
    const videoOption = document.createElement("div");
    videoOption.innerText = "Video";
    this.styleOption(videoOption);
    videoOption.onclick = () => {
      this.startDownload("video");
      menu.style.display = "none";
    };

    // Transcript Option

    const transcriptOption = document.createElement("div");
    transcriptOption.innerText = "Transcript";
    this.styleOption(transcriptOption);
    transcriptOption.onclick = () => {
      this.startDownload("transcript");
      menu.style.display = "none";
    };

    menu.appendChild(audioOption);
    menu.appendChild(videoOption);
    menu.appendChild(transcriptOption);

    container.appendChild(button);
    container.appendChild(menu);

    // Toggle Menu
    button.onclick = (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "block" : "none";
    };

    // ── Fix #2: remove stale outside-click handler before adding a new one ──
    if (this._outsideClickHandler) {
      document.removeEventListener("click", this._outsideClickHandler);
    }
    this._outsideClickHandler = () => {
      menu.style.display = "none";
    };
    document.addEventListener("click", this._outsideClickHandler);

    // Insert before the original first action (usually leaderboard trophy icon)
    headerActions.insertBefore(container, headerActions.firstChild);
  }

  styleOption(opt) {
    opt.style.padding = "10px 16px";
    opt.style.cursor = "pointer";
    opt.style.color = "#fff";
    opt.style.fontSize = "14px";
    opt.style.fontFamily = "Inter, sans-serif";
    opt.style.transition = "background 0.2s";
    opt.onmouseover = () => (opt.style.background = "#4a4a52");
    opt.onmouseout = () => (opt.style.background = "transparent");
  }

  async startDownload(type) {
    const btn = document
      .getElementById("scaler-video-downloader")
      .querySelector("a");
    const originalIcon = btn.innerHTML;
    
    if (type === "transcript") {
      btn.innerHTML = '<svg class="scaler-spinner" viewBox="0 0 50 50" style="width:20px;height:20px;animation:rotate 2s linear infinite;"><circle cx="25" cy="25" r="20" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" style="stroke-dasharray:1, 200;stroke-dashoffset:0;animation:dash 1.5s ease-in-out infinite;"></circle></svg>';
      if (!document.getElementById("scaler-spinner-style")) {
        const style = document.createElement("style");
        style.id = "scaler-spinner-style";
        style.textContent = `
          @keyframes rotate { 100% { transform: rotate(360deg); } }
          @keyframes dash {
            0% { stroke-dasharray: 1, 200; stroke-dashoffset: 0; }
            50% { stroke-dasharray: 89, 200; stroke-dashoffset: -35px; }
            100% { stroke-dasharray: 89, 200; stroke-dashoffset: -124px; }
          }
        `;
        document.head.appendChild(style);
      }
    } else {
      btn.innerHTML =
        '<span style="font-size:12px; font-weight:bold;">...</span>';
    }

    // Ensure the lecture slug is resolved BEFORE proceeding.
    // This handles SPA navigation where the slug wasn't fetched yet.
    const slug = await this._fetchLectureSlug();
    if (slug) {
      console.log(`[Scaler++] Using lecture slug for download: ${slug}`);
    } else {
      console.warn(
        "[Scaler++] Could not resolve lecture slug — falling back to title.",
      );
    }
    
    if (type === "transcript") {
      const cacheKey = slug || document.title;
      if (cacheKey) {
        const cacheResult = await new Promise(resolve => {
            chrome.runtime.sendMessage({ action: "checkTranscriptCache", slug: cacheKey }, (resp) => {
                if (chrome.runtime.lastError) resolve(null);
                else resolve(resp);
            });
        });
        
        if (cacheResult && cacheResult.success && cacheResult.data && cacheResult.data.cached && cacheResult.data.text) {
            console.log("[Scaler++] Transcript loaded from cache.");

            const wantDownload = confirm("A cached transcript was found. Click OK to download it, or click Cancel to generate your own transcript.");
            if (wantDownload) {
                // Track completed download
                try {
                  chrome.storage.sync.get(["scaler_user"], (result) => {
                    const email = result?.scaler_user?.email;
                    if (email && chrome.runtime?.id) {
                      chrome.runtime.sendMessage({
                        action: "trackDownload",
                        email,
                        downloadType: "transcript",
                        lecture: document.title || "",
                        lectureSlug: cacheKey,
                      });
                    }
                  });
                } catch (_) {}

                let finalTranscript = cacheResult.data.text;
                try {
                  const match = window.location.pathname.match(/\/class\/(\d+)/);
                  const classId = match ? match[1] : null;
                  if (classId) {
                    const header = await fetchMetadataHeader(classId);
                    finalTranscript = header + finalTranscript;
                  }
                } catch (e) {
                  console.error("[Scaler++] Error adding metadata to cache download:", e);
                }

                const blob = new Blob([finalTranscript], { type: "text/plain" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const videoTitle = document.title || "";
                const slugTitle = videoTitle
                  .replace(/[\\/:*?"<>|]/g, "")
                  .replace(/\\s+/g, "_")
                  .substring(0, 80)
                  .replace(/_+$/, "");
                a.download = slugTitle ? `${slugTitle}.txt` : "Scaler_Lecture.txt";
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
                btn.innerHTML = originalIcon;
                return;
            }
        }
      }
    }

    chrome.runtime.sendMessage({ type: "GET_VIDEO_URL" }, (response) => {
      // Must check lastError first — if the background SW is inactive,
      // Chrome sets this and throws if we don't read it.
      if (chrome.runtime.lastError) {
        console.warn(
          "[Scaler++] sendMessage error:",
          chrome.runtime.lastError.message,
        );
        btn.innerHTML = originalIcon;
        alert(
          "⚠️ Extension background is not responding.\n\nTry reloading the page.",
        );
        return;
      }

      btn.innerHTML = originalIcon;

      if (!response || !response.url) {
        alert(
          "⚠️ Could not locate the video stream.\n\nPlease ensure the video is playing first, then try again.",
        );
        return;
      }

      const match = window.location.pathname.match(/\/class\/(\d+)/);
      const classId = match ? match[1] : "";

      chrome.runtime.sendMessage(
        {
          type: "INITIATE_DOWNLOAD",
          payload: {
            url: response.url,
            type: type,
            title: document.title || "",
            lectureSlug: this._lectureSlug || "",
            classId: classId,
          },
        },
        () => {
          // Consume any potential lastError from this message too
          if (chrome.runtime.lastError) {
            console.warn(
              "[Scaler++] INITIATE_DOWNLOAD error:",
              chrome.runtime.lastError.message,
            );
          }
        },
      );
    });
  }
}

async function fetchMetadataHeader(classId) {
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

  return `Course Name: ${courseName}\n` +
         `Lecture Title: ${title}\n` +
         `Start Time: ${formattedStartTime}\n` +
         `Duration: ${formattedDuration}\n` +
         `Downloaded via: Scaler++ Chrome Extension\n` +
         `Developer: Ritesh prajapati\n\n` +
         `==================================================\n\n`;
}

// Launch the script
window.ScalerVideoDownloader = new VideoDownloader();
