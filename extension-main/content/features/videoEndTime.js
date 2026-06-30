// ============================================
// features/videoEndTime.js
// Video end time display + custom speed panel + hotkeys
//
// Shows "Ends at: HH:MM" on Scaler's video player.
// Replaces the native speed dropdown with a custom
// speed panel (slider + speed dial buttons).
// Keyboard shortcuts: Shift+. / Shift+, for ±0.1x.
// ============================================

const VIDEO_END_TIME_ATTR = "data-scaler-end-time";
const SPEED_PANEL_ID = "scaler-speed-panel";
const CUSTOM_SPEED_KEY = "scaler-custom-speed";
const SPEED_TIP_ID = "scaler-speed-tip";

// Speed dial presets
const SPEED_DIAL = [
  0.5, 1, 1.25, 1.5, 1.75, 2, 2.15, 2.5, 2.75,
  3, 3.5, 4, 6, 8, 12, 16,
];

let _lastCustomSpeed = null;
let _speedGuardInterval = null;

// ─── DOM helpers ────────────────────────────────

function findVideo() {
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

function findSpeedButton() {
  return document.querySelector(
    ".vp-playback-title, " +
    "[data-cy='video-player-controls-playback-rate-button']"
  );
}

function findSpeedDropdownContainer() {
  const btn = findSpeedButton();
  return btn ? btn.closest(".dropdown, .vp-controls__control") : null;
}

function formatEndTime(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ─── Speed Apply ────────────────────────────────

function applySpeed(video, speed) {
  if (!video) return;
  const rate = Math.max(0.1, Math.min(16, parseFloat(speed) || 1));
  video.playbackRate = rate;
  _lastCustomSpeed = rate;
  localStorage.setItem(CUSTOM_SPEED_KEY, String(rate));
  updateSpeedButtonLabel(rate);
  return rate;
}

function updateSpeedButtonLabel(rate) {
  const label = rate === Math.round(rate) ? rate + "" : rate.toFixed(2);
  const title = findSpeedButton();
  if (title) title.textContent = label + "x";
}

// ─── Speed Guardian ─────────────────────────────

function startSpeedGuard() {
  if (_speedGuardInterval) return;
  _speedGuardInterval = setInterval(() => {
    if (!_lastCustomSpeed) return;
    const video = findVideo();
    if (!video) return;
    if (Math.abs(video.playbackRate - _lastCustomSpeed) > 0.01) {
      // Only re-apply if it looks like a reset (rate changed to a close value
      // that's not our speed, or back to 1x while we were faster)
      if (video.playbackRate <= 2 || _lastCustomSpeed > 2) {
        video.playbackRate = _lastCustomSpeed;
      }
    }
  }, 600);
}

function stopSpeedGuard() {
  if (_speedGuardInterval) {
    clearInterval(_speedGuardInterval);
    _speedGuardInterval = null;
  }
}

// ─── End Time Overlay ───────────────────────────

function injectEndTime() {
  const video = findVideo();
  const td = findTimeDisplay();
  if (!video || !td) return;
  if (document.querySelector(`[${VIDEO_END_TIME_ATTR}]`)) return;

  const saved = parseFloat(localStorage.getItem(CUSTOM_SPEED_KEY));
  if (saved && saved > 0 && Math.abs(saved - video.playbackRate) > 0.01) {
    applySpeed(video, saved);
  }

  const wrap = document.createElement("div");
  wrap.setAttribute(VIDEO_END_TIME_ATTR, "true");
  wrap.style.cssText = "display:flex;align-items:center;gap:8px;flex-shrink:0";

  const el = document.createElement("div");
  el.className = "vp-controls__duration";
  el.style.whiteSpace = "nowrap";
  wrap.appendChild(el);

  td.parentNode.insertBefore(wrap, td.nextSibling);

  function tick() {
    if (!video || !video.duration || video.duration === Infinity) return;
    const rem = (video.duration - video.currentTime) / (video.playbackRate || 1);
    el.textContent = "Ends at: " + formatEndTime(new Date(Date.now() + rem * 1000));
  }

  tick();
  const iv = setInterval(tick, 1000);
  wrap._iv = iv;

  const rh = () => tick();
  video.addEventListener("ratechange", rh);
  wrap._rh = rh;
  wrap._vid = video;
}

// ─── Speed Panel (slider + speed dial) ──────────

function buildSpeedPanel() {
  // Remove existing panel if any
  const old = document.getElementById(SPEED_PANEL_ID);
  if (old) old.remove();

  const panel = document.createElement("div");
  panel.id = SPEED_PANEL_ID;
  panel.style.cssText = `
    position:fixed; z-index:99999;
    background:#1a1a2e; border:1px solid rgba(255,255,255,0.12);
    border-radius:12px; padding:16px 20px 18px;
    box-shadow:0 8px 32px rgba(0,0,0,0.6);
    min-width:280px;
    font-family:inherit;
  `;

  // ── Current speed display ──
  const currentRate = findVideo()?.playbackRate || 1;

  const header = document.createElement("div");
  header.style.cssText =
    "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px";

  const title = document.createElement("span");
  title.textContent = "Playback Speed";
  title.style.cssText = "color:rgba(255,255,255,0.7);font-size:13px;font-weight:500";

  const rateVal = document.createElement("span");
  rateVal.id = "scaler-speed-value";
  const disp = currentRate === Math.round(currentRate) ? currentRate + "" : currentRate.toFixed(2);
  rateVal.textContent = disp + "x";
  rateVal.style.cssText = "color:#fff;font-size:18px;font-weight:700";

  header.appendChild(title);
  header.appendChild(rateVal);
  panel.appendChild(header);

  // ── Slider ──
  const sliderWrap = document.createElement("div");
  sliderWrap.style.cssText = "margin-bottom:14px";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0.1";
  slider.max = "16";
  slider.step = "0.1";
  slider.value = String(currentRate);
  slider.style.cssText = `
    width:100%; height:4px; -webkit-appearance:none; appearance:none;
    background:linear-gradient(to right, #6366f1 0%, #6366f1 50%, rgba(255,255,255,0.15) 50%);
    border-radius:2px; outline:none; cursor:pointer;
  `;

  // Slider thumb styling
  const thumbStyle = document.createElement("style");
  thumbStyle.textContent = `
    #${SPEED_PANEL_ID} input[type=range]::-webkit-slider-thumb {
      -webkit-appearance:none; appearance:none;
      width:16px; height:16px; border-radius:50%;
      background:#6366f1; border:2px solid #fff;
      cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    }
    #${SPEED_PANEL_ID} input[type=range]::-moz-range-thumb {
      width:16px; height:16px; border-radius:50%;
      background:#6366f1; border:2px solid #fff;
      cursor:pointer;
    }
  `;
  document.head.appendChild(thumbStyle);

  // Slider gradient update on input
  const updateSliderBG = () => {
    const pct = ((slider.value - 0.1) / (16 - 0.1)) * 100;
    slider.style.background =
      `linear-gradient(to right, #6366f1 0%, #6366f1 ${pct}%, rgba(255,255,255,0.15) ${pct}%)`;
  };

  slider.addEventListener("input", () => {
    const val = parseFloat(slider.value);
    const video = findVideo();
    if (video) applySpeed(video, val);
    const disp2 = val === Math.round(val) ? val + "" : val.toFixed(2);
    document.getElementById("scaler-speed-value").textContent = disp2 + "x";
    updateSliderBG();
    highlightActiveDial(val);
  });

  sliderWrap.appendChild(slider);
  panel.appendChild(sliderWrap);

  // ── Speed dial buttons ──
  const dialGrid = document.createElement("div");
  dialGrid.style.cssText =
    "display:flex;flex-wrap:wrap;gap:6px;justify-content:center";

  SPEED_DIAL.forEach((s) => {
    const btn = document.createElement("button");
    btn.dataset.speed = String(s);
    const label = s === Math.round(s) ? s + "" : s.toFixed(2);
    btn.textContent = label + "x";
    btn.style.cssText = `
      padding:5px 10px; border-radius:6px; border:1px solid rgba(255,255,255,0.1);
      background:rgba(255,255,255,0.05); color:rgba(255,255,255,0.85);
      font-size:12px; cursor:pointer; transition:all 0.15s;
      font-family:inherit;
    `;

    if (Math.abs(s - currentRate) < 0.01) {
      btn.style.background = "#6366f1";
      btn.style.borderColor = "#6366f1";
      btn.style.color = "#fff";
    }

    btn.addEventListener("mouseenter", () => {
      if (!btn.classList.contains("active")) {
        btn.style.background = "rgba(255,255,255,0.12)";
      }
    });
    btn.addEventListener("mouseleave", () => {
      if (!btn.classList.contains("active")) {
        btn.style.background = "rgba(255,255,255,0.05)";
      }
    });

    btn.addEventListener("click", () => {
      const rate = parseFloat(btn.dataset.speed);
      const video = findVideo();
      if (video) {
        applySpeed(video, rate);
        slider.value = String(rate);
        updateSliderBG();
        const d = rate === Math.round(rate) ? rate + "" : rate.toFixed(2);
        document.getElementById("scaler-speed-value").textContent = d + "x";
        highlightActiveDial(rate);
      }
      closePanel();
    });

    dialGrid.appendChild(btn);
  });

  panel.appendChild(dialGrid);

  // ── Keyboard hint ──
  const hint = document.createElement("div");
  hint.style.cssText =
    "color:rgba(255,255,255,0.35);font-size:11px;text-align:center;margin-top:10px";
  hint.textContent = "Shift + , / .  to fine-tune ±0.1";
  panel.appendChild(hint);

  document.body.appendChild(panel);
  positionPanel(panel);

  // Active dial highlighter
  function highlightActiveDial(rate) {
    dialGrid.querySelectorAll("button").forEach((b) => {
      const sv = parseFloat(b.dataset.speed);
      b.classList.remove("active");
      b.style.background = Math.abs(sv - rate) < 0.01
        ? "#6366f1"
        : "rgba(255,255,255,0.05)";
      b.style.borderColor = Math.abs(sv - rate) < 0.01
        ? "#6366f1"
        : "rgba(255,255,255,0.1)";
      b.style.color = Math.abs(sv - rate) < 0.01 ? "#fff" : "rgba(255,255,255,0.85)";
    });
  }

  return panel;
}

function positionPanel(panel) {
  const btn = findSpeedButton();
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  const panelW = panel.offsetWidth || 280;

  // Position above the button, centered
  let left = rect.left + rect.width / 2 - panelW / 2;
  let top = rect.top - 12 - panel.offsetHeight;

  // Clamp to viewport
  if (left < 8) left = 8;
  if (left + panelW > window.innerWidth - 8) {
    left = window.innerWidth - panelW - 8;
  }
  if (top < 8) {
    // If not enough room above, place below
    top = rect.bottom + 12;
  }

  panel.style.left = left + "px";
  panel.style.top = top + "px";
}

function closePanel() {
  const p = document.getElementById(SPEED_PANEL_ID);
  if (p) p.remove();
}

// ─── Intercept Speed Button ─────────────────────

let _speedButtonIntercepted = false;

function interceptSpeedButton() {
  if (_speedButtonIntercepted) return;

  const container = findSpeedDropdownContainer();
  if (!container) {
    // Try again later
    setTimeout(interceptSpeedButton, 1000);
    return;
  }

  // Intercept clicks on the speed button
  container.addEventListener(
    "mousedown",
    (e) => {
      // Check if click is on or inside the speed button area
      const btn = findSpeedButton();
      if (!btn) return;
      if (!btn.contains(e.target) && !container.querySelector(".vp-playback-title")?.contains(e.target)) {
        return;
      }

      // Only intercept if speed feature is enabled
      if (!currentSettings || !currentSettings["video-end-time-speed"]) return;

      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();

      // Toggle panel
      const existing = document.getElementById(SPEED_PANEL_ID);
      if (existing) {
        closePanel();
        return;
      }

      buildSpeedPanel();
    },
    { capture: true }
  );

  _speedButtonIntercepted = true;
}

// ─── Tooltip ────────────────────────────────────

function showTooltip(speed) {
  const old = document.getElementById(SPEED_TIP_ID);
  if (old) old.remove();

  const tip = document.createElement("div");
  tip.id = SPEED_TIP_ID;
  const label = speed === Math.round(speed) ? speed + "" : speed.toFixed(2);
  tip.textContent = label + "x";
  tip.style.cssText = `
    position:fixed; top:50%; left:50%;
    transform:translate(-50%,-50%);
    background:rgba(0,0,0,0.85); color:#fff;
    font-size:28px; font-weight:700;
    padding:12px 28px; border-radius:12px;
    z-index:999999; pointer-events:none;
    animation:speed-tip-fade 1.2s ease-out forwards;
  `;

  if (!document.getElementById("speed-tip-kf")) {
    const s = document.createElement("style");
    s.id = "speed-tip-kf";
    s.textContent = `@keyframes speed-tip-fade {
      0%{opacity:1;transform:translate(-50%,-50%) scale(1)}
      60%{opacity:1;transform:translate(-50%,-50%) scale(1.05)}
      100%{opacity:0;transform:translate(-50%,-50%) scale(0.9)}
    }`;
    document.head.appendChild(s);
  }

  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 1300);
}

// ─── Hotkeys (0.1x step) ────────────────────────

function setupHotkeys() {
  if (window._scalerHK) return;

  const handler = (e) => {
    if (!currentSettings || !currentSettings["video-end-time-speed"]) return;
    const video = findVideo();
    if (!video || !video.duration) return;

    let newSpeed = null;

    if (e.shiftKey && (e.code === "Period" || e.key === ">" || e.key === ".")) {
      newSpeed = Math.min(16, (video.playbackRate || 1) + 0.1);
    } else if (e.shiftKey && (e.code === "Comma" || e.key === "<" || e.key === ",")) {
      newSpeed = Math.max(0.1, (video.playbackRate || 1) - 0.1);
    }

    if (newSpeed !== null) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      applySpeed(video, newSpeed);
      showTooltip(newSpeed);
      startSpeedGuard();
      // Round to 1 decimal for display
      const rounded = Math.round(newSpeed * 10) / 10;
      updateSpeedButtonLabel(rounded);
    }
  };

  window.addEventListener("keydown", handler, { capture: true });
  document.addEventListener("keydown", handler, { capture: true });
  window._scalerHK = handler;
}

function teardownHotkeys() {
  if (window._scalerHK) {
    window.removeEventListener("keydown", window._scalerHK, { capture: true });
    document.removeEventListener("keydown", window._scalerHK, { capture: true });
    window._scalerHK = null;
  }
}

// ─── Init / Teardown ────────────────────────────

function initVideoEndTime() {
  if (window._endTimeObs) return;

  // Responsive CSS
  if (!document.getElementById("scaler-vet-css")) {
    const s = document.createElement("style");
    s.id = "scaler-vet-css";
    s.textContent =
      "@media(max-width:800px){[" + VIDEO_END_TIME_ATTR + "]{display:none!important}}";
    document.head.appendChild(s);
  }

  injectEndTime();

  const obs = new MutationObserver(() => injectEndTime());
  obs.observe(document.body, { childList: true, subtree: true });
  window._endTimeObs = obs;

  if (currentSettings && currentSettings["video-end-time-speed"]) {
    interceptSpeedButton();
    setTimeout(interceptSpeedButton, 2000);
    setupHotkeys();
    startSpeedGuard();
  }

  // Close panel on Escape / click outside
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });
  document.addEventListener("mousedown", (e) => {
    const p = document.getElementById(SPEED_PANEL_ID);
    if (p && !p.contains(e.target)) {
      const btn = findSpeedButton();
      if (!btn || !btn.contains(e.target)) {
        closePanel();
      }
    }
  });
}

function removeEndTimeOverlay() {
  // End time overlay
  const wrap = document.querySelector(`[${VIDEO_END_TIME_ATTR}]`);
  if (wrap) {
    if (wrap._iv) clearInterval(wrap._iv);
    if (wrap._rh && wrap._vid) wrap._vid.removeEventListener("ratechange", wrap._rh);
    wrap.remove();
  }

  closePanel();
  if (window._endTimeObs) {
    window._endTimeObs.disconnect();
    window._endTimeObs = null;
  }

  teardownHotkeys();
  stopSpeedGuard();
  _lastCustomSpeed = null;
  _speedButtonIntercepted = false;
}
