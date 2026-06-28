// ============================================
// features/videoEndTime.js
// Shows video end time on Scaler's player with custom playback speed control.
//
// Merged from the YouTime (YouTube) and TimeScale (Scaler) Chrome extensions.
//
// Features:
//   - "Ends at: HH:MM" display next to the video progress bar
//   - Custom playback speed input (0.1x – 16x, beyond Scaler's 2x UI limit)
//   - Keyboard shortcuts: Shift+. speed up, Shift+, slow down (0.25x steps)
//   - Speed persisted via localStorage
//   - Applies speed directly to the <video> element (bypasses UI limit)
// ============================================

const VIDEO_END_TIME_ATTR = "data-scaler-end-time";
const VIDEO_END_TIME_CLASS = "scaler-end-time";
const SPEED_INPUT_CLASS = "scaler-speed-input";
const SPEED_TOOLTIP_ID = "scaler-speed-tooltip";

// LocalStorage key for persisting custom speed
const CUSTOM_SPEED_KEY = "scaler-custom-speed";

// Speed step for hotkey adjustments
const SPEED_STEP = 0.25;

// Speed presets for quick cycling
const SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16];

/**
 * Find the next speed preset above the current value.
 */
function nextSpeedPreset(current) {
  for (const s of SPEED_PRESETS) {
    if (s > current + 0.01) return s;
  }
  return Math.min(current + SPEED_STEP, 16);
}

/**
 * Find the previous speed preset below the current value.
 */
function prevSpeedPreset(current) {
  for (let i = SPEED_PRESETS.length - 1; i >= 0; i--) {
    if (SPEED_PRESETS[i] < current - 0.01) return SPEED_PRESETS[i];
  }
  return Math.max(current - SPEED_STEP, 0.1);
}

/**
 * Find the Scaler video player element.
 * Handles multiple selectors for different Scaler page layouts.
 */
function findScalerVideo() {
  return (
    document.querySelector(".vp-video") ||
    document.querySelector("video.vp-video") ||
    document.querySelector("[data-cy='archived-meeting-video-player']") ||
    document.querySelector("video")
  );
}

/**
 * Find the time display container next to the video controls.
 */
function findTimeDisplay() {
  return document.querySelector(".vp-controls__duration");
}

/**
 * Format a Date object to a locale time string (HH:MM AM/PM).
 */
function formatEndTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Show a brief tooltip near the player indicating the new speed.
 */
function showSpeedTooltip(speed) {
  // Remove any existing tooltip
  const existing = document.getElementById(SPEED_TOOLTIP_ID);
  if (existing) existing.remove();

  const tooltip = document.createElement("div");
  tooltip.id = SPEED_TOOLTIP_ID;
  tooltip.textContent = speed.toFixed(2) + "x";
  tooltip.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: 28px;
    font-weight: 700;
    padding: 12px 28px;
    border-radius: 12px;
    z-index: 999999;
    pointer-events: none;
    animation: scaler-speed-fade 1.2s ease-out forwards;
  `;

  // Inject keyframe animation once
  if (!document.getElementById("scaler-speed-keyframes")) {
    const style = document.createElement("style");
    style.id = "scaler-speed-keyframes";
    style.textContent = `
      @keyframes scaler-speed-fade {
        0% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        60% { opacity: 1; transform: translate(-50%, -50%) scale(1.05); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
      }
    `;
    document.head.appendChild(style);
  }

  document.body.appendChild(tooltip);

  // Auto-remove after animation
  setTimeout(() => tooltip.remove(), 1300);
}

/**
 * Apply playback speed to the video element.
 * Bypasses Scaler's UI-enforced 2x limit by setting video.playbackRate directly.
 */
function applyPlaybackSpeed(video, speed) {
  if (!video) return;
  const rate = Math.max(0.1, Math.min(16, parseFloat(speed) || 1));
  video.playbackRate = rate;

  // Also try to update any native speed indicators Scaler might have
  const speedButtons = document.querySelectorAll(
    ".vp-speed-btn, .vp-controls__speed, [data-cy='video-player-speed']"
  );
  speedButtons.forEach((btn) => {
    const label = btn.querySelector("span, .vp-speed-label");
    if (label) label.textContent = rate.toFixed(1) + "x";
  });

  return rate;
}

/**
 * Sync the speed input field with the current speed value.
 */
function syncSpeedInput(speed) {
  const input = document.querySelector(`.${SPEED_INPUT_CLASS}`);
  if (input) {
    input.value = speed.toFixed(1);
  }
}

/**
 * Inject the end-time overlay + speed input next to the time display.
 */
function injectEndTimeOverlay() {
  const video = findScalerVideo();
  const timeDisplay = findTimeDisplay();

  if (!video || !timeDisplay) return;

  // Don't duplicate if already injected
  if (document.querySelector(`[${VIDEO_END_TIME_ATTR}]`)) return;

  // --- Restore saved speed and apply to video ---
  const savedSpeed = parseFloat(localStorage.getItem(CUSTOM_SPEED_KEY));
  const initialSpeed =
    savedSpeed && savedSpeed > 0 ? savedSpeed : video.playbackRate || 1;
  applyPlaybackSpeed(video, initialSpeed);

  // --- Build the container ---
  const container = document.createElement("div");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.gap = "8px";
  container.setAttribute(VIDEO_END_TIME_ATTR, "true");

  // End time display (styled like vp-controls__duration)
  const endTimeDiv = document.createElement("div");
  endTimeDiv.className = `vp-controls__duration ${VIDEO_END_TIME_CLASS}`;
  endTimeDiv.setAttribute("data-cy", "video-player-end-time");
  endTimeDiv.style.fontSize = "12px";
  container.appendChild(endTimeDiv);

  // --- Custom speed input ---
  if (currentSettings && currentSettings["video-end-time-speed"]) {
    const speedContainer = document.createElement("div");
    speedContainer.style.display = "flex";
    speedContainer.style.alignItems = "center";
    speedContainer.style.gap = "4px";
    speedContainer.style.fontSize = "12px";
    speedContainer.style.color = "white";

    const speedLabel = document.createElement("span");
    speedLabel.textContent = "Speed:";
    speedLabel.style.fontSize = "11px";
    speedContainer.appendChild(speedLabel);

    const speedInput = document.createElement("input");
    speedInput.type = "number";
    speedInput.step = "0.1";
    speedInput.min = "0.1";
    speedInput.max = "16";
    speedInput.className = SPEED_INPUT_CLASS;
    speedInput.style.width = "55px";
    speedInput.style.padding = "2px 5px";
    speedInput.style.fontSize = "12px";
    speedInput.style.backgroundColor = "rgba(255, 255, 255, 0.1)";
    speedInput.style.border = "1px solid rgba(255, 255, 255, 0.3)";
    speedInput.style.borderRadius = "3px";
    speedInput.style.color = "white";
    speedInput.style.textAlign = "center";

    speedInput.value = initialSpeed;

    // --- Speed input change: apply to video immediately ---
    speedInput.addEventListener("change", () => {
      const newSpeed = parseFloat(speedInput.value) || 1;
      const clamped = Math.max(0.1, Math.min(16, newSpeed));
      localStorage.setItem(CUSTOM_SPEED_KEY, clamped);
      speedInput.value = clamped;
      applyPlaybackSpeed(video, clamped);
      showSpeedTooltip(clamped);
      updateEndTime();
    });

    // Also update on Enter key
    speedInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        speedInput.blur(); // triggers change event
      }
    });

    speedContainer.appendChild(speedInput);
    speedContainer.appendChild(document.createTextNode("x"));
    container.appendChild(speedContainer);
  }

  // Insert after the time display
  timeDisplay.parentNode.insertBefore(container, timeDisplay.nextSibling);

  // --- Update loop ---
  function updateEndTime() {
    if (!video || !video.duration || video.duration === Infinity) return;

    const currentTime = video.currentTime;
    const duration = video.duration;
    const playbackRate = video.playbackRate || 1;

    if (duration && currentTime !== undefined && playbackRate > 0) {
      const adjustedRemaining = (duration - currentTime) / playbackRate;
      const endTime = new Date(Date.now() + adjustedRemaining * 1000);
      endTimeDiv.textContent = `Ends at: ${formatEndTime(endTime)}`;
    }
  }

  // Initial update
  updateEndTime();

  // Keep updating every second
  const intervalId = setInterval(updateEndTime, 1000);

  // Store interval and video ref on the container for cleanup
  container._endTimeInterval = intervalId;
  container._videoRef = video;

  // --- Sync speed input when video playbackRate changes externally ---
  // Some players modify playbackRate themselves (e.g. native speed buttons)
  container._rateChangeHandler = () => {
    syncSpeedInput(video.playbackRate);
    updateEndTime();
  };
  video.addEventListener("ratechange", container._rateChangeHandler);
}

/**
 * Remove the end-time overlay from the DOM and clean up.
 */
function removeEndTimeOverlay() {
  const overlay = document.querySelector(`[${VIDEO_END_TIME_ATTR}]`);
  if (overlay) {
    if (overlay._endTimeInterval) {
      clearInterval(overlay._endTimeInterval);
    }
    if (overlay._rateChangeHandler && overlay._videoRef) {
      overlay._videoRef.removeEventListener(
        "ratechange",
        overlay._rateChangeHandler
      );
    }
    overlay.remove();
  }

  // Disconnect observer
  if (window._endTimeObserver) {
    window._endTimeObserver.disconnect();
    window._endTimeObserver = null;
  }

  // Remove hotkey listener
  if (window._endTimeHotkeyHandler) {
    document.removeEventListener("keydown", window._endTimeHotkeyHandler);
    window._endTimeHotkeyHandler = null;
  }
}

/**
 * Set up keyboard shortcuts for speed control.
 * Shift+. (>) = speed up    Shift+, (<) = slow down
 */
function setupSpeedHotkeys() {
  if (window._endTimeHotkeyHandler) return; // already set up

  const handler = (e) => {
    // Only when speed feature is enabled
    if (!currentSettings || !currentSettings["video-end-time-speed"]) return;

    // Only when a video is present on the page
    const video = findScalerVideo();
    if (!video) return;

    // Shift + . (period) = speed up
    if (e.shiftKey && e.key === ".") {
      e.preventDefault();
      const current = video.playbackRate || 1;
      const newSpeed = nextSpeedPreset(current);
      applyPlaybackSpeed(video, newSpeed);
      syncSpeedInput(newSpeed);
      localStorage.setItem(CUSTOM_SPEED_KEY, newSpeed);
      showSpeedTooltip(newSpeed);
    }

    // Shift + , (comma) = slow down
    if (e.shiftKey && e.key === ",") {
      e.preventDefault();
      const current = video.playbackRate || 1;
      const newSpeed = prevSpeedPreset(current);
      applyPlaybackSpeed(video, newSpeed);
      syncSpeedInput(newSpeed);
      localStorage.setItem(CUSTOM_SPEED_KEY, newSpeed);
      showSpeedTooltip(newSpeed);
    }
  };

  document.addEventListener("keydown", handler);
  window._endTimeHotkeyHandler = handler;
}

/**
 * Initialize the video end time feature.
 */
function initVideoEndTime() {
  // Don't double-init
  if (window._endTimeObserver) return;

  // Try injecting immediately (player might already be in DOM)
  injectEndTimeOverlay();

  // Watch for DOM changes (SPA navigation, player appearing)
  const observer = new MutationObserver(() => {
    injectEndTimeOverlay();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window._endTimeObserver = observer;

  // Set up speed hotkeys
  setupSpeedHotkeys();
}
