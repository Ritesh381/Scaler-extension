// ============================================================
// liveStreamRecorder.js
// Integrates live stream recording and DVR into Scaler++
// ============================================================

// ── FORCE DISABLE (kill switch) ─────────────────────────────────────────────
// While true, the Live Stream Recorder is OFF for EVERY user regardless of their
// saved setting: init() returns immediately, so it never injects UI, never
// starts observers, and never wires the popup toggle — so a user who had it
// enabled (stored value `true`) is disabled too. Flip to false to ship the
// feature again. Keep in sync with FORCE_DISABLED_FEATURES in popup.js (which
// locks the matching toggle off).
const LIVE_STREAM_RECORDER_FORCE_DISABLED = true;

class LiveStreamRecorder {
  constructor() {
    this.enabled = true;
    this.client = null;
    this.tracks = new Map();

    // Recording
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordedSize = 0; // Track size incrementally to avoid memory leak
    this.recordingStartTime = 0;

    // State
    this.screenshareTrack = null;
    this.cameraTrack = null;
    this.mainTrack = null;
    this.pipTrack = null;
    this.audioTracks = new Set();
    this.isLive = true;
    this.dvrBlobUrl = null;
    this.config = null;
    this.isActive = false;

    // DVR state
    this.isDVRLoading = false; // Prevents race conditions during DVR transitions
    this.pendingSeekTime = null; // Store seek time while DVR is loading
    this._observer = null; // Tracks DOM mutations for SPA navigation

    this.init();
  }

  async init() {
    // Hard kill switch — force-disabled for all users. Do nothing at all: no
    // settings read, no toggle listener, no observer, no injection. (See
    // LIVE_STREAM_RECORDER_FORCE_DISABLED above.)
    if (LIVE_STREAM_RECORDER_FORCE_DISABLED) {
      this.enabled = false;
      return;
    }

    // Check if the feature is enabled in settings
    try {
      const result = await chrome.storage.sync.get("cleanerSettings");
      if (
        result.cleanerSettings &&
        result.cleanerSettings["live-stream-recorder"] === false
      ) {
        this.enabled = false;
      }
    } catch (e) {
      // Default to enabled
    }

    // Listen for live toggle changes from the popup
    chrome.runtime.onMessage.addListener((msg) => {
      if (
        msg.action === "toggleSetting" &&
        msg.key === "live-stream-recorder"
      ) {
        this.enabled = msg.value;
        if (!msg.value) {
          if (this.isActive) {
            this.deactivate();
          }
          const btn = document.getElementById("scaler-live-recorder-btn-container");
          if (btn) btn.remove();
          if (this._observer) {
            this._observer.disconnect();
            this._observer = null;
          }
        } else if (msg.value) {
          this.checkAndInject();
          this._startObserver();
        }
      }
    });

    if (this.enabled) {
      this.checkAndInject();
    }

    this._startObserver();
  }

  _startObserver() {
    if (this._observer) return;

    // Observe DOM mutations for SPA navigation, debounced to prevent memory/CPU spikes
    let _injectDebounceTimer = null;
    this._observer = new MutationObserver(() => {
      clearTimeout(_injectDebounceTimer);
      _injectDebounceTimer = setTimeout(() => {
        if (this.enabled && !this.isActive) this.checkAndInject();
      }, 300);
    });

    // Scope observer to app root instead of entire body if possible
    const appRoot =
      document.getElementById("root") ||
      document.querySelector(".application-layout") ||
      document.body;
    this._observer.observe(appRoot, { childList: true, subtree: true });
  }

  checkAndInject() {
    // Detect if we're on a live class page
    // Presence of .agora_video_player or specific URL pattern
    const agoraPlayer = document.querySelector(".agora_video_player");
    const headerActions = document.querySelectorAll(".m-header__actions")[1];

    if (!agoraPlayer || !headerActions) {
      return;
    }

    // Inject only if we haven't already
    if (document.getElementById("scaler-live-recorder-btn")) {
      return;
    }

    this.injectButton(headerActions);
  }

  injectButton(headerActions) {
    const container = document.createElement("div");
    container.id = "scaler-live-recorder-btn-container";
    container.className = "m-header__action";
    container.style.display = "inline-block";
    container.style.marginRight = "8px";

    const button = document.createElement("a");
    button.id = "scaler-live-recorder-btn";
    button.className = "tappable btn btn-icon m-btn btn-large m-btn--default";
    button.title = "Record Live Stream";
    button.style.color = "#ef4444"; // Red to indicate recording capability

    button.innerHTML = `
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"></circle>
                <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
            </svg>
        `;

    button.onclick = (e) => {
      e.preventDefault();
      this.activate();
    };

    container.appendChild(button);
    headerActions.insertBefore(container, headerActions.firstChild);
  }

  async activate() {
    if (this.isActive) return;

    console.log("[Scaler++] Activating Live Stream Recorder...");
    this.isActive = true;

    // 1. Fetch credentials
    try {
      const config = await this.autoConfigure();
      if (!config) throw new Error("Could not fetch stream credentials");
      this.config = config;
    } catch (err) {
      console.error("[Scaler++] Configuration failed:", err);
      alert(
        "⚠️ Failed to fetch stream credentials. Make sure you are in a live class.",
      );
      this.isActive = false;
      return;
    }

    // 2. Prepare UI
    this.prepareUI();

    // 3. Initialize Agora (needs to be in page context)
    this.injectAgoraAndInit();
  }

  async autoConfigure() {
    try {
      // 1. Fetch Events to get Slug
      const eventsRes = await fetch(
        "https://www.scaler.com/academy/mentee/events",
      );
      if (!eventsRes.ok) throw new Error("Failed to fetch events");

      const eventsData = await eventsRes.json();
      const slug =
        eventsData.futureEvents?.[0]?.meeting_slug ||
        eventsData.topCardEvent?.meeting_slug;

      if (!slug) throw new Error("No active meeting found");

      // 2. Fetch Live Session for Credentials
      const sessionRes = await fetch(
        `https://www.scaler.com/meetings/${slug}/live-session`,
      );
      if (!sessionRes.ok) throw new Error("Failed to fetch live session");
      const sessionData = await sessionRes.json();

      // 3. Extract Data
      const rawChannel = sessionData.data?.feedback_forms?.[0]?.item_id;
      const channel = rawChannel ? String(rawChannel) : null;
      const token = sessionData.tokens?.video_broadcasting;
      const participants = sessionData.participants || [];

      let uid = null;
      if (participants.length > 0) {
        const lastId = participants[participants.length - 1].user_id;
        uid = parseInt(`1${lastId}`);
      }

      if (!channel || !token || !uid) throw new Error("Incomplete credentials");

      return { appId: "03d2d4319a52428ea2e5068d87f3bca9", channel, token, uid };
    } catch (err) {
      console.error("[Scaler++] Error in autoConfigure:", err);
      return null;
    }
  }

  prepareUI() {
    const streamsLayout = document.querySelector(".streams-layout");
    if (!streamsLayout) {
      console.error("[Scaler++] Could not find .streams-layout");
      return;
    }

    // Hide original layout
    streamsLayout.style.display = "none";

    // Hide the "Connection has been interrupted" error that appears when Scaler's Agora disconnects
    this.hideConnectionError();

    // Create our custom video container
    const container = document.createElement("div");
    container.id = "scaler-stream-recorder-container";

    container.innerHTML = `
            <div id="live-video-container"></div>
            <video id="dvr-video-player" playsinline></video>

            <div class="video-controls-overlay">
                <div class="timeline-container">
                    <div class="timeline-fill" id="recorder-timeline-fill"></div>
                    <input type="range" min="0" max="100" value="100" class="timeline-input" id="recorder-timeline-slider">
                </div>
                
                <div class="controls-row">
                    <div class="left-controls">
                        <button class="play-btn" id="recorder-play-pause-btn">⏸</button>
                        <span class="time-display" id="recorder-time-display">00:00 / 00:00</span>
                    </div>
                    
                    <div class="right-controls" style="display: flex; gap: 15px; align-items: center;">
                        <button id="recorder-download-btn" class="live-badge-btn" style="background: rgba(59, 130, 246, 0.2); color: #3b82f6; border: 1px solid rgba(59, 130, 246, 0.4);" disabled>
                            ⬇ DOWNLOAD
                        </button>
                        <button class="live-badge-btn is-live" id="recorder-live-badge">LIVE</button>
                    </div>
                </div>
            </div>
        `;

    streamsLayout.parentNode.insertBefore(container, streamsLayout.nextSibling);

    // Inject status controls into Scaler's footer control panel
    this.injectFooterControls();

    // Prepare the sidebar camera container for instructor feed
    this.prepareSidebarCameraContainer();

    // Cache UI elements
    this.ui = {
      container: container,
      liveContainer: container.querySelector("#live-video-container"),
      dvrPlayer: container.querySelector("#dvr-video-player"),
      sidebarCameraContainer: document.querySelector(
        "#recorder-sidebar-camera",
      ),
      status: document.querySelector("#recorder-connection-status"),
      recordingStatus: document.querySelector("#recorder-recording-status"),
      bufferSize: document.querySelector("#recorder-buffer-size"),
      btnDownload: container.querySelector("#recorder-download-btn"),
      timelineFill: container.querySelector("#recorder-timeline-fill"),
      timelineInput: container.querySelector("#recorder-timeline-slider"),
      playPauseBtn: container.querySelector("#recorder-play-pause-btn"),
      timeDisplay: container.querySelector("#recorder-time-display"),
      liveBadge: container.querySelector("#recorder-live-badge"),
    };

    this.bindEvents();

    // Update loop
    this.uiUpdateInterval = setInterval(() => this.updateUI(), 500);
  }

  injectFooterControls() {
    // Find Scaler's control panel in the footer
    const controlPanelActions = document.querySelector(
      ".control-panel__actions",
    );
    if (!controlPanelActions) {
      console.warn(
        "[Scaler++] Could not find .control-panel__actions for footer injection",
      );
      return;
    }

    // Create status container that matches Scaler's button styling
    const statusContainer = document.createElement("div");
    statusContainer.id = "scaler-recorder-footer-status";
    statusContainer.className = "scaler-recorder-footer-controls";
    statusContainer.innerHTML = `
            <div class="recorder-status-item" title="Connection Status">
                <span class="recorder-status-dot" id="recorder-status-dot"></span>
                <span id="recorder-connection-status" class="recorder-status-text">Connecting...</span>
            </div>
            <div class="recorder-status-item" title="Recording Status">
                <span class="recorder-rec-icon">●</span>
                <span id="recorder-recording-status" class="recorder-status-text">Waiting...</span>
            </div>
            <div class="recorder-status-item" title="Buffer Size">
                <span class="recorder-buffer-icon">💾</span>
                <span id="recorder-buffer-size" class="recorder-status-text">0.0 MB</span>
            </div>
        `;

    // Insert at the beginning of the control panel
    controlPanelActions.insertBefore(
      statusContainer,
      controlPanelActions.firstChild,
    );
  }

  hideConnectionError() {
    // Hide the "Connection has been interrupted" error overlay
    const connectionError = document.querySelector(
      ".m-connection.m-connection--error",
    );
    if (connectionError) {
      connectionError.style.display = "none";
    }

    // Also observe for future connection errors that might appear
    this.connectionErrorObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            // Check if the added node is the connection error
            if (node.classList?.contains("m-connection--error")) {
              node.style.display = "none";
            }
            // Check children as well
            const errors = node.querySelectorAll?.(
              ".m-connection.m-connection--error",
            );
            errors?.forEach((el) => (el.style.display = "none"));
          }
        }
      }
    });

    const videoChannel = document.querySelector(".video-channel");
    if (videoChannel) {
      this.connectionErrorObserver.observe(videoChannel, {
        childList: true,
        subtree: true,
      });
    }
  }

  prepareSidebarCameraContainer() {
    // Find Scaler's sidebar camera container
    // Target: .aspect-ratio__container .streams-layout inside .meeting-sidebar
    const sidebar = document.querySelector(
      ".meeting-sidebar .aspect-ratio__container .streams-layout",
    );
    if (!sidebar) {
      console.warn(
        "[Scaler++] Could not find sidebar streams-layout for camera feed",
      );
      return;
    }

    // Hide the original stream tile content but keep the container
    const originalTile = sidebar.querySelector(".stream-tile");
    if (originalTile) {
      // Store original content to restore later
      this.originalSidebarContent = originalTile.innerHTML;

      // Create our camera container inside the tile
      originalTile.innerHTML = `
                <div id="recorder-sidebar-camera" style="width: 100%; height: 100%; background: #1a1a1a;"></div>
            `;
    }
  }

  bindEvents() {
    // Use arrow functions to maintain correct 'this' context
    this.ui.timelineInput.addEventListener("input", (e) =>
      this.handleSeek(e.target.value),
    );
    this.ui.playPauseBtn.addEventListener("click", () =>
      this.togglePlayPause(),
    );
    this.ui.btnDownload.addEventListener("click", () =>
      this.downloadRecording(),
    );
    this.ui.liveBadge.addEventListener("click", () => this.jumpToLive());

    // DVR player events
    this.ui.dvrPlayer.addEventListener("play", () => {
      if (!this.isLive) this.getElement("playPauseBtn").textContent = "⏸";
    });

    this.ui.dvrPlayer.addEventListener("pause", () => {
      if (!this.isLive) this.getElement("playPauseBtn").textContent = "▶";
    });

    // Use timeupdate for smoother timeline updates during DVR playback
    this.ui.dvrPlayer.addEventListener("timeupdate", () => {
      if (!this.isLive && !this.isDVRLoading) {
        this.updateTimelineFromDVR();
      }
    });

    // Handle video ended - jump back to live
    this.ui.dvrPlayer.addEventListener("ended", () => {
      this.jumpToLive();
    });

    // Handle errors in DVR playback
    this.ui.dvrPlayer.addEventListener("error", (e) => {
      console.error("[Scaler++] DVR player error:", e);
      // Attempt recovery by jumping to live
      this.jumpToLive();
    });

    // Keyboard Shortcuts
    this.keydownHandler = (e) => {
      // Don't capture if user is typing in an input
      if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")
        return;

      if (e.code === "Space") {
        e.preventDefault();
        this.togglePlayPause();
      }
      if (e.code === "ArrowLeft") {
        e.preventDefault();
        this.stepSeek(-5);
      }
      if (e.code === "ArrowRight") {
        e.preventDefault();
        this.stepSeek(5);
      }
    };
    document.addEventListener("keydown", this.keydownHandler);
  }

  // Helper to get UI elements safely - re-queries DOM if cached reference is lost
  getElement(key) {
    const selectors = {
      container: "#scaler-stream-recorder-container",
      liveContainer: "#live-video-container",
      dvrPlayer: "#dvr-video-player",
      sidebarCameraContainer: "#recorder-sidebar-camera",
      status: "#recorder-connection-status",
      recordingStatus: "#recorder-recording-status",
      bufferSize: "#recorder-buffer-size",
      btnDownload: "#recorder-download-btn",
      timelineFill: "#recorder-timeline-fill",
      timelineInput: "#recorder-timeline-slider",
      playPauseBtn: "#recorder-play-pause-btn",
      timeDisplay: "#recorder-time-display",
      liveBadge: "#recorder-live-badge",
      statusDot: "#recorder-status-dot",
    };

    // Check if cached element is still in DOM
    if (this.ui[key] && document.contains(this.ui[key])) {
      return this.ui[key];
    }

    // Re-query and cache
    const selector = selectors[key];
    if (selector) {
      this.ui[key] = document.querySelector(selector);
      return this.ui[key];
    }

    return null;
  }

  injectAgoraAndInit() {
    // We'll load the bridge via script src to satisfy potential CSP rules
    const bridgeScriptId = "scaler-recorder-bridge-script";
    if (document.getElementById(bridgeScriptId)) {
      this.sendCommand("init", { config: this.config });
      return;
    }

    // 1. Inject Agora SDK
    const sdkScript = document.createElement("script");
    sdkScript.src = chrome.runtime.getURL("libs/agora-sdk.js");
    sdkScript.onload = () => {
      // 2. Inject our bridge logic
      const bridgeScript = document.createElement("script");
      bridgeScript.id = bridgeScriptId;
      bridgeScript.src = chrome.runtime.getURL(
        "content/features/liveStreamRecorder/recorderBridge.js",
      );
      bridgeScript.onload = () => {
        // 3. Initialize the bridge once it's loaded
        this.sendCommand("init", { config: this.config });
      };
      document.body.appendChild(bridgeScript);
    };
    document.body.appendChild(sdkScript);

    // Listen for events from the bridge - store reference for cleanup
    this.bridgeEventHandler = (e) => {
      const { type, data } = e.detail;
      this.handleBridgeEvent(type, data);
    };
    window.addEventListener("scaler-stream-event", this.bridgeEventHandler);
  }

  handleBridgeEvent(type, data) {
    switch (type) {
      case "connection-status":
        const status = this.getElement("status");
        if (status) {
          status.textContent = data.status;
          status.style.color = data.color;
        }
        const statusDot = this.getElement("statusDot");
        if (statusDot) {
          statusDot.style.backgroundColor = data.color;
        }
        break;
      case "recording-status":
        const recordingStatus = this.getElement("recordingStatus");
        if (recordingStatus) {
          recordingStatus.textContent = data.status;
          recordingStatus.style.color = data.color;
        }
        if (data.startTime) {
          this.recordingStartTime = data.startTime;
          console.log(
            "[Scaler++] Recording started at:",
            this.recordingStartTime,
          );
        }
        const btnDownload = this.getElement("btnDownload");
        if (btnDownload) btnDownload.disabled = false;
        break;
      case "chunk-available":
        this.recordedChunks.push(data.blob);
        this.recordedSize += data.size; // Track size incrementally
        break;
      case "layout-update":
        // Camera feed is now handled in recorderBridge.js -> sidebar container
        break;
      case "download-ready":
        this.performDownload();
        break;
    }
  }

  sendCommand(type, data = {}) {
    window.dispatchEvent(
      new CustomEvent("scaler-stream-command", { detail: { type, data } }),
    );
  }

  // --- DVR Logic ---

  getRecordingDuration() {
    if (!this.recordingStartTime || this.recordingStartTime === 0) {
      return 0;
    }
    return (Date.now() - this.recordingStartTime) / 1000;
  }

  stepSeek(seconds) {
    // Don't allow seeking while DVR is loading
    if (this.isDVRLoading) return;

    // Need chunks to seek
    if (this.recordedChunks.length === 0) {
      console.warn("[Scaler++] No recorded chunks to seek");
      return;
    }

    const duration = this.getRecordingDuration();
    if (duration <= 0) {
      console.warn("[Scaler++] Recording not started yet");
      return;
    }

    let currentTime;
    if (this.isLive) {
      currentTime = duration;
    } else {
      const video = this.getElement("dvrPlayer");
      currentTime = video?.currentTime || duration;
    }

    let newTime = currentTime + seconds;
    if (newTime < 0) newTime = 0;

    // If seeking to near the end, jump to live
    if (newTime >= duration - 1) {
      this.jumpToLive();
      return;
    }

    if (this.isLive) {
      this.enableDVRMode(newTime, true);
    } else {
      const video = this.getElement("dvrPlayer");
      if (video && video.duration && isFinite(video.duration)) {
        // Clamp to actual video duration
        newTime = Math.min(newTime, video.duration - 0.5);
        video.currentTime = newTime;
      }
    }
  }

  enableDVRMode(seekToTime = null, shouldPlay = true) {
    // Prevent multiple simultaneous DVR transitions
    if (this.isDVRLoading) {
      // Store the seek request for after loading completes
      this.pendingSeekTime = seekToTime;
      return;
    }

    if (this.recordedChunks.length === 0) {
      console.warn("[Scaler++] No recorded chunks for DVR");
      return;
    }

    this.isDVRLoading = true;

    // Create blob from recorded chunks
    const blob = new Blob(this.recordedChunks, { type: "video/webm" });

    // Revoke previous URL to prevent memory leak
    if (this.dvrBlobUrl) {
      URL.revokeObjectURL(this.dvrBlobUrl);
    }
    this.dvrBlobUrl = URL.createObjectURL(blob);

    const video = this.getElement("dvrPlayer");
    if (!video) {
      console.error("[Scaler++] DVR player element not found");
      this.isDVRLoading = false;
      return;
    }

    // Set up one-time event handler for when metadata is loaded
    const onLoadedMetadata = () => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);

      this.isLive = false;
      this.isDVRLoading = false;

      // Update UI state
      const liveBadge = this.getElement("liveBadge");
      if (liveBadge) liveBadge.classList.remove("is-live");

      this.sendCommand("set-live", { isLive: false });

      // Determine target time
      let targetTime = seekToTime;
      if (targetTime === null) {
        // Default to near the end (most recent)
        targetTime = Math.max(0, video.duration - 0.5);
      }

      // Clamp to valid range
      targetTime = Math.max(0, Math.min(targetTime, video.duration - 0.1));

      video.currentTime = targetTime;

      if (shouldPlay) {
        video
          .play()
          .catch((e) => console.warn("[Scaler++] Auto-play blocked:", e));
      } else {
        video.pause();
      }

      // Switch display
      const liveContainer = this.getElement("liveContainer");
      if (liveContainer) liveContainer.style.display = "none";
      video.style.display = "block";

      // Handle any pending seek that came in while loading
      if (this.pendingSeekTime !== null) {
        const pendingTime = this.pendingSeekTime;
        this.pendingSeekTime = null;
        // Use setTimeout to avoid recursion
        setTimeout(() => {
          if (!this.isLive && video.duration) {
            video.currentTime = Math.min(pendingTime, video.duration - 0.1);
          }
        }, 50);
      }
    };

    const onError = (e) => {
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("error", onError);

      console.error("[Scaler++] Failed to load DVR video:", e);
      this.isDVRLoading = false;
      this.pendingSeekTime = null;

      // Stay in live mode
      this.isLive = true;
    };

    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("error", onError);

    // Set the source to trigger loading
    video.src = this.dvrBlobUrl;
    video.load();
  }

  jumpToLive() {
    if (this.isLive && !this.isDVRLoading) return;

    // Cancel any pending DVR operations
    this.isDVRLoading = false;
    this.pendingSeekTime = null;
    this.isLive = true;

    const dvrPlayer = this.getElement("dvrPlayer");
    const liveContainer = this.getElement("liveContainer");
    const liveBadge = this.getElement("liveBadge");
    const playPauseBtn = this.getElement("playPauseBtn");

    if (dvrPlayer) {
      dvrPlayer.pause();
      dvrPlayer.style.display = "none";
    }
    if (liveContainer) liveContainer.style.display = "block";
    if (liveBadge) liveBadge.classList.add("is-live");
    if (playPauseBtn) playPauseBtn.textContent = "⏸";

    this.sendCommand("set-live", { isLive: true });

    // Update timeline to 100%
    this.updateTimelineToLive();
  }

  togglePlayPause() {
    if (this.isDVRLoading) return;

    if (this.isLive) {
      // Pause from live = enter DVR mode paused at current position
      this.enableDVRMode(null, false);
    } else {
      const video = this.getElement("dvrPlayer");
      if (video) {
        if (video.paused) {
          video.play().catch((e) => console.warn("[Scaler++] Play failed:", e));
        } else {
          video.pause();
        }
      }
    }
  }

  updateTimelineToLive() {
    const timelineInput = this.getElement("timelineInput");
    const timelineFill = this.getElement("timelineFill");
    const timeDisplay = this.getElement("timeDisplay");

    if (timelineInput) timelineInput.value = 100;
    if (timelineFill) timelineFill.style.width = "100%";

    const duration = this.getRecordingDuration();
    if (timeDisplay) {
      timeDisplay.textContent = this.formatTime(duration);
    }
  }

  updateTimelineFromDVR() {
    const video = this.getElement("dvrPlayer");
    if (!video || !video.duration || !isFinite(video.duration)) return;

    const pct = (video.currentTime / video.duration) * 100;

    const timelineInput = this.getElement("timelineInput");
    const timelineFill = this.getElement("timelineFill");
    const timeDisplay = this.getElement("timeDisplay");

    if (timelineInput) timelineInput.value = pct;
    if (timelineFill) timelineFill.style.width = `${pct}%`;
    if (timeDisplay) {
      timeDisplay.textContent = `${this.formatTime(video.currentTime)} / ${this.formatTime(video.duration)}`;
    }
  }

  updateUI() {
    if (!this.isActive) return;

    // Update buffer size using tracked size (no new Blob creation)
    const bufferSize = this.getElement("bufferSize");
    if (bufferSize) {
      const sizeMB = this.recordedSize / 1024 / 1024;
      bufferSize.textContent = `${sizeMB.toFixed(1)} MB`;
    }

    // Update timeline based on mode
    if (this.isLive && !this.isDVRLoading) {
      this.updateTimelineToLive();
    }
    // DVR timeline is updated via timeupdate event, not here
  }

  handleSeek(value) {
    if (this.isDVRLoading) return;

    const pct = parseFloat(value);

    // Seeking to end = jump to live
    if (pct >= 98) {
      this.jumpToLive();
      return;
    }

    // Need chunks to seek
    if (this.recordedChunks.length === 0) return;

    if (this.isLive) {
      // Calculate the target time based on current recording duration
      const duration = this.getRecordingDuration();
      const targetTime = (pct / 100) * duration;
      this.enableDVRMode(targetTime, true);
    } else {
      const video = this.getElement("dvrPlayer");
      if (video && video.duration && isFinite(video.duration)) {
        const time = (pct / 100) * video.duration;
        video.currentTime = time;
      }
    }

    // Immediately update the timeline fill for responsive feel
    const timelineFill = this.getElement("timelineFill");
    if (timelineFill) {
      timelineFill.style.width = `${pct}%`;
    }
  }

  downloadRecording() {
    this.sendCommand("request-download");
  }

  performDownload() {
    const blob = new Blob(this.recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.style.display = "none";
    a.href = url;
    a.download = `scaler_live_${this.config.channel}_${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  formatTime(seconds) {
    if (!seconds || !isFinite(seconds)) return "00:00";
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0)
      return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  deactivate() {
    this.isActive = false;
    if (this.uiUpdateInterval) clearInterval(this.uiUpdateInterval);

    // Remove UI and restore original layout
    if (this.ui && this.ui.container) {
      this.ui.container.remove();
    }

    // Remove footer status controls
    const footerStatus = document.getElementById(
      "scaler-recorder-footer-status",
    );
    if (footerStatus) footerStatus.remove();

    // Restore sidebar camera content
    const sidebarTile = document.querySelector(
      ".meeting-sidebar .aspect-ratio__container .streams-layout .stream-tile",
    );
    if (sidebarTile && this.originalSidebarContent) {
      sidebarTile.innerHTML = this.originalSidebarContent;
    }

    // Stop observing connection errors and restore visibility
    if (this.connectionErrorObserver) {
      this.connectionErrorObserver.disconnect();
    }
    const connectionError = document.querySelector(
      ".m-connection.m-connection--error",
    );
    if (connectionError) {
      connectionError.style.display = "";
    }

    const streamsLayout = document.querySelector(".streams-layout");
    if (streamsLayout) streamsLayout.style.display = "";

    // Remove scripts and event listeners
    const script = document.getElementById("scaler-recorder-bridge-script");
    if (script) script.remove();

    document.removeEventListener("keydown", this.keydownHandler);

    // Remove bridge event listener
    if (this.bridgeEventHandler) {
      window.removeEventListener(
        "scaler-stream-event",
        this.bridgeEventHandler,
      );
    }

    // Command bridge to cleanup
    this.sendCommand("cleanup");

    // ── Fix #5: release all memory ──────────────────────────────────
    // Drop chunk references so GC can reclaim the recording buffer
    this.recordedChunks = [];
    this.recordedSize = 0;

    // Revoke the DVR blob URL to free the in-memory blob
    if (this.dvrBlobUrl) {
      URL.revokeObjectURL(this.dvrBlobUrl);
      this.dvrBlobUrl = null;
    }

    // Null out the UI cache so removed DOM elements aren't kept alive
    this.ui = null;
    this.originalSidebarContent = null;
    this.connectionErrorObserver = null;
    this.bridgeEventHandler = null;
    this.keydownHandler = null;
  }
}

// Launch the script
window.ScalerLiveStreamRecorder = new LiveStreamRecorder();
