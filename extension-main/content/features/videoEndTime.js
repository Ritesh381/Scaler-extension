// ============================================
// features/videoEndTime.js
// Video end time display + extended speed dropdown + hotkeys
//
// Shows "Ends at: HH:MM" on Scaler's video player, styled to match
// the native control bar. Extends the existing playback speed
// dropdown with values beyond 2x (up to 16x). Keyboard shortcuts
// allow quick speed changes (Shift+. speed up, Shift+, slow down).
// ============================================

const VIDEO_END_TIME_ATTR = "data-scaler-end-time";
const SCALER_EXTRA_ITEM = "scaler-extra-speed";
const SCALER_SPEED_ATTR = "data-scaler-custom-speed";

const CUSTOM_SPEED_KEY = "scaler-custom-speed";
const EXTRA_SPEEDS = [2.5, 3, 4, 6, 8, 12, 16];
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16];

// Store the last custom speed so we can re-apply it if Scaler resets it
let _lastCustomSpeed = null;
let _speedGuardInterval = null;

// ─── Helpers ──────────────────────────────────────

function findScalerVideo() {
  return (
    document.querySelector(".vp-video") ||
    document.querySelector("video.vp-video") ||
    document.querySelector("[data-cy='archived-meeting-video-player']") ||
    document.querySelector("video")
  );
}

function findTimeDisplay() {
  return document.querySelector(".vp-controls__duration");
}

function findSpeedTitle() {
  return document.querySelector(".vp-playback-title");
}

function findSpeedButton() {
  return document.querySelector(
    "[data-cy='video-player-controls-playback-rate-button'], .vp-dropdown"
  );
}

function findDropdownContainer() {
  const btn = findSpeedButton();
  return btn ? btn.closest(".dropdown") : null;
}

function formatEndTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── Speed Application ──────────────────────────

function applyPlaybackSpeed(video, speed) {
  if (!video) return false;
  const rate = Math.max(0.1, Math.min(16, parseFloat(speed) || 1));
  video.playbackRate = rate;
  _lastCustomSpeed = rate;

  // Update dropdown title
  const title = findSpeedTitle();
  if (title) {
    const display = rate === Math.round(rate) ? rate + "" : rate.toFixed(2);
    title.textContent = display + "x";
  }

  localStorage.setItem(CUSTOM_SPEED_KEY, String(rate));
  return rate;
}

// ─── Speed Guardian ────────────────────────────
// Scaler's player may reset playbackRate on various events (seeking,
// source change, fullscreen toggle, etc.).  This runs a tick every
// 600ms and re-applies the custom speed if the player changed it.

function _startSpeedGuard() {
  if (_speedGuardInterval) return;
  _speedGuardInterval = setInterval(() => {
    if (!_lastCustomSpeed) return;
    const video = findScalerVideo();
    if (!video || !video.duration) return;
    // If the player's rate differs from ours and it's outside our range
    if (Math.abs(video.playbackRate - _lastCustomSpeed) > 0.01) {
      // Only re-apply if our speed is >2x (native speeds are handled by Scaler)
      // or if it's clearly a reset (back to 1x while we were at e.g. 1.5x)
      const isNative = video.playbackRate <= 2 && _lastCustomSpeed <= 2;
      if (!isNative) {
        video.playbackRate = _lastCustomSpeed;
      }
    }
  }, 600);
}

function _stopSpeedGuard() {
  if (_speedGuardInterval) {
    clearInterval(_speedGuardInterval);
    _speedGuardInterval = null;
  }
}

// ─── End Time Overlay ────────────────────────────

function injectEndTimeOverlay() {
  const video = findScalerVideo();
  const timeDisplay = findTimeDisplay();
  if (!video || !timeDisplay) return;
  if (document.querySelector(`[${VIDEO_END_TIME_ATTR}]`)) return;

  // Restore saved speed
  const saved = parseFloat(localStorage.getItem(CUSTOM_SPEED_KEY));
  if (saved && saved > 0 && Math.abs(saved - video.playbackRate) > 0.01) {
    applyPlaybackSpeed(video, saved);
  }

  const container = document.createElement("div");
  container.setAttribute(VIDEO_END_TIME_ATTR, "true");
  container.style.display = "flex";
  container.style.alignItems = "center";
  container.style.gap = "8px";
  container.style.flexShrink = "0";

  const endTimeDiv = document.createElement("div");
  endTimeDiv.className = "vp-controls__duration";
  endTimeDiv.style.whiteSpace = "nowrap";
  endTimeDiv.style.fontSize = "inherit";
  container.appendChild(endTimeDiv);

  // Insert after the native duration
  timeDisplay.parentNode.insertBefore(container, timeDisplay.nextSibling);

  function updateEndTime() {
    if (!video || !video.duration || video.duration === Infinity) return;
    const remaining =
      (video.duration - video.currentTime) / (video.playbackRate || 1);
    const endTime = new Date(Date.now() + remaining * 1000);
    endTimeDiv.textContent = `Ends at: ${formatEndTime(endTime)}`;
  }

  updateEndTime();
  const intervalId = setInterval(updateEndTime, 1000);
  container._endTimeInterval = intervalId;
  container._videoRef = video;

  const rateHandler = () => updateEndTime();
  video.addEventListener("ratechange", rateHandler);
  container._rateChangeHandler = rateHandler;
}

// ─── Speed Dropdown Extension ───────────────────

/**
 * Find the actual dropdown menu that contains speed options.
 * Scaler's dropdown may vary in structure, so we try multiple strategies.
 */
function findSpeedMenu() {
  const container = findDropdownContainer();
  if (!container) return null;

  // Strategy 1: standard dropdown menu class
  let menu = container.querySelector(
    ".dropdown__items, .dropdown__menu, [role='menu'], .vp-dropdown-items, .vp-playback-menu"
  );
  if (menu) return menu;

  // Strategy 2: look for a sibling/child div that becomes visible when dropdown is open
  const allChildren = container.querySelectorAll(":scope > div, :scope > ul, :scope > section");
  for (const child of allChildren) {
    if (child !== findSpeedButton() && child.offsetParent !== null) {
      const items = child.querySelectorAll("a, button, div[role='menuitem'], .dropdown__item");
      if (items.length >= 3) return child; // looks like a menu with items
    }
  }

  // Strategy 3: the menu might be outside the .dropdown container but attached to body
  // Look for visible menus
  const visibleMenus = document.querySelectorAll(
    ".dropdown__items:not([hidden]), .dropdown__menu:not([hidden]), [role='menu']:not([hidden])"
  );
  for (const m of visibleMenus) {
    if (m.textContent.includes("1x") && m.textContent.includes("2x")) {
      return m;
    }
  }

  return null;
}

function injectExtraSpeedOptions() {
  if (!currentSettings || !currentSettings["video-end-time-speed"]) return;

  const menu = findSpeedMenu();
  if (!menu) return;

  // Already injected?
  if (menu.querySelector(`.${SCALER_EXTRA_ITEM}`)) return;

  // Find last native item (look for anything containing a speed value)
  const allItems = menu.querySelectorAll(
    "[role='menuitem'], .dropdown__item, a, button, div"
  );
  let lastItem = null;
  for (const item of allItems) {
    if (item.closest(`.${SCALER_EXTRA_ITEM}`)) continue; // skip our own
    const text = item.textContent.trim();
    if (/^\d+(\.\d+)?x$/.test(text)) {
      lastItem = item;
    }
  }

  if (!lastItem) return;

  // Divider
  const divider = document.createElement("div");
  divider.className = `${SCALER_EXTRA_ITEM} dropdown__divider`;
  divider.style.cssText =
    "height:1px;background:rgba(255,255,255,0.15);margin:4px 12px;";
  lastItem.parentNode.insertBefore(divider, lastItem.nextSibling);

  // Extra speed items (insert after divider)
  EXTRA_SPEEDS.forEach((speed) => {
    const item = document.createElement("div");
    item.className = `dropdown__item ${SCALER_EXTRA_ITEM}`;
    item.setAttribute("role", "menuitem");
    item.setAttribute(SCALER_SPEED_ATTR, String(speed));
    item.textContent = speed + "x";
    item.style.cursor = "pointer";

    item.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const video = findScalerVideo();
      if (video) {
        applyPlaybackSpeed(video, speed);
        showSpeedTooltip(speed);
        _startSpeedGuard();
      }
      dismissDropdown();
    });

    divider.parentNode.insertBefore(item, divider.nextSibling);
  });
}

/**
 * Try to dismiss the open speed dropdown by dispatching Escape.
 */
function dismissDropdown() {
  // Dispatch Escape in both capture and bubble
  document.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Escape",
    code: "Escape",
    bubbles: true,
    cancelable: true,
  }));
}

// ─── Tooltip ─────────────────────────────────────

function showSpeedTooltip(speed) {
  const existing = document.getElementById("scaler-speed-tip");
  if (existing) existing.remove();

  const tip = document.createElement("div");
  tip.id = "scaler-speed-tip";
  tip.textContent = speed + "x";
  tip.style.cssText = `
    position:fixed; top:50%; left:50%;
    transform:translate(-50%,-50%);
    background:rgba(0,0,0,0.85); color:#fff;
    font-size:28px; font-weight:700;
    padding:12px 28px; border-radius:12px;
    z-index:999999; pointer-events:none;
    animation:speed-tip-fade 1.2s ease-out forwards;
  `;

  if (!document.getElementById("speed-tip-keyframes")) {
    const s = document.createElement("style");
    s.id = "speed-tip-keyframes";
    s.textContent = `
      @keyframes speed-tip-fade {
        0% { opacity:1; transform:translate(-50%,-50%) scale(1); }
        60% { opacity:1; transform:translate(-50%,-50%) scale(1.05); }
        100% { opacity:0; transform:translate(-50%,-50%) scale(0.9); }
      }
    `;
    document.head.appendChild(s);
  }

  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 1300);
}

// ─── Hotkeys ─────────────────────────────────────

function nextSpeed(current) {
  for (const s of SPEED_PRESETS) {
    if (s > current + 0.01) return s;
  }
  return SPEED_PRESETS[SPEED_PRESETS.length - 1];
}

function prevSpeed(current) {
  for (let i = SPEED_PRESETS.length - 1; i >= 0; i--) {
    if (SPEED_PRESETS[i] < current - 0.01) return SPEED_PRESETS[i];
  }
  return SPEED_PRESETS[0];
}

function setupSpeedHotkeys() {
  if (window._scalerSpeedHotkey) return;

  const handler = (e) => {
    if (!currentSettings || !currentSettings["video-end-time-speed"]) return;
    const video = findScalerVideo();
    if (!video || !video.duration) return;

    let handled = false;
    let newSpeed = null;

    // Shift + Period (>) = speed up
    if (e.shiftKey && (e.code === "Period" || e.key === ">" || e.key === ".")) {
      const cur = video.playbackRate || 1;
      newSpeed = nextSpeed(cur);
      handled = true;
    }

    // Shift + Comma (<) = slow down
    if (e.shiftKey && (e.code === "Comma" || e.key === "<" || e.key === ",")) {
      const cur = video.playbackRate || 1;
      newSpeed = prevSpeed(cur);
      handled = true;
    }

    if (handled && newSpeed !== null) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      applyPlaybackSpeed(video, newSpeed);
      showSpeedTooltip(newSpeed);
      _startSpeedGuard();
    }
  };

  // Register on BOTH window and document with capture, plus bubble as fallback
  window.addEventListener("keydown", handler, { capture: true });
  document.addEventListener("keydown", handler, { capture: true });
  // Also register non-capture on the video element directly if available
  setInterval(() => {
    const video = findScalerVideo();
    if (video && !video._scalerSpeedAttached) {
      video.addEventListener("keydown", (e) => {
        handler(e);
      });
      video._scalerSpeedAttached = true;
    }
  }, 2000);

  window._scalerSpeedHotkey = handler;
}

function teardownHotkeys() {
  if (window._scalerSpeedHotkey) {
    window.removeEventListener("keydown", window._scalerSpeedHotkey, { capture: true });
    document.removeEventListener("keydown", window._scalerSpeedHotkey, { capture: true });
    window._scalerSpeedHotkey = null;
  }
}

// ─── Dropdown Observer ──────────────────────────

let _dropdownParents = new WeakSet();

function watchForDropdown() {
  const obs = new MutationObserver(() => {
    if (!currentSettings || !currentSettings["video-end-time-speed"]) return;
    injectExtraSpeedOptions();
  });

  obs.observe(document.body, { childList: true, subtree: true });

  // Also watch specific dropdown containers when they appear
  const containerFinder = new MutationObserver(() => {
    const container = findDropdownContainer();
    if (container && !_dropdownParents.has(container)) {
      _dropdownParents.add(container);
      const innerObs = new MutationObserver(() => {
        setTimeout(injectExtraSpeedOptions, 100);
      });
      innerObs.observe(container, { childList: true, subtree: true, attributes: true });
    }
  });

  containerFinder.observe(document.body, { childList: true, subtree: true });
  window._scalerDropdownFinder = containerFinder;
  window._scalerDropdownInjector = obs;
}

// ─── Init / Teardown ────────────────────────────

function initVideoEndTime() {
  if (window._endTimeObserver) return;

  injectEndTimeOverlay();

  const observer = new MutationObserver(() => {
    injectEndTimeOverlay();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  window._endTimeObserver = observer;

  // Speed-related features
  // Inject responsive CSS
  var _vetStyle = document.getElementById("scaler-vet-style");
  if (!_vetStyle) {
    _vetStyle = document.createElement("style");
    _vetStyle.id = "scaler-vet-style";
    _vetStyle.textContent =
      "@media (max-width: 800px) { " +
        "[" + VIDEO_END_TIME_ATTR + "] { display:none !important; } " +
      "}";
    document.head.appendChild(_vetStyle);
  }

  if (currentSettings && currentSettings["video-end-time-speed"]) {
    watchForDropdown();
    setTimeout(injectExtraSpeedOptions, 1500);
    setTimeout(injectExtraSpeedOptions, 3000);
    setupSpeedHotkeys();
    _startSpeedGuard();
  }
}

function removeEndTimeOverlay() {
  // End time overlay
  const overlay = document.querySelector(`[${VIDEO_END_TIME_ATTR}]`);
  if (overlay) {
    if (overlay._endTimeInterval) clearInterval(overlay._endTimeInterval);
    if (overlay._rateChangeHandler && overlay._videoRef) {
      overlay._videoRef.removeEventListener(
        "ratechange",
        overlay._rateChangeHandler
      );
    }
    overlay.remove();
  }

  // Observer
  if (window._endTimeObserver) {
    window._endTimeObserver.disconnect();
    window._endTimeObserver = null;
  }

  // Hotkeys
  teardownHotkeys();

  // Speed guardian
  _stopSpeedGuard();

  // Dropdown injected items
  document.querySelectorAll(`.${SCALER_EXTRA_ITEM}`).forEach((el) => el.remove());

  // Dropdown observers
  if (window._scalerDropdownFinder) {
    window._scalerDropdownFinder.disconnect();
    window._scalerDropdownFinder = null;
  }
  if (window._scalerDropdownInjector) {
    window._scalerDropdownInjector.disconnect();
    window._scalerDropdownInjector = null;
  }

  _lastCustomSpeed = null;
}
