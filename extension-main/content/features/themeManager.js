// ============================================
// features/themeManager.js
// Site-wide Dark Mode & elegant theme engine for scaler.com
//
// HOW IT WORKS
// ------------
// Scaler's site is a large, frequently-changing SPA, so per-selector
// re-skinning would be brittle and break on every dashboard tweak. Instead
// we recolor the WHOLE page with a single CSS `filter` recipe applied to the
// root <html> element, and counter-invert real media (images / video /
// canvas / iframes / background photos) so they keep their natural colors.
//
// Filtering the ROOT element is deliberate: per the CSS spec a filter on the
// root element applies to the viewport and does NOT establish a containing
// block for `position: fixed` descendants. That means Scaler's sticky header,
// modals and the extension's own overlays keep working correctly — which is
// the main reason this approach is "compatible" with the live site.
//
// Each theme is just a different filter recipe, giving distinct, elegant
// moods (classic dark, deep midnight, dracula, nord, warm sepia, solarized)
// from one robust engine with zero per-page maintenance.
// ============================================

const SCALER_THEME_STYLE_ID = "scaler-theme-styles";
const SCALER_THEME_ROOT_CLASS = "scaler-theme-active";

// Counter recipe applied to media so photos/videos are NOT inverted.
// invert(1) hue-rotate(180deg) is its own inverse, so this neutralises the
// dominant invert+hue of every dark recipe below (any extra brightness /
// saturate tuning is minor on media and visually acceptable).
const SCALER_THEME_MEDIA_COUNTER = "invert(1) hue-rotate(180deg)";

// Theme catalogue. `filter: null` means "no theming" (off / light = the
// site's native look). Order here is the order shown in the popup dropdown.
const SCALER_THEMES = {
  off: { label: "🌞 Light (Off)", filter: null },
  dark: {
    label: "🌚 Dark",
    filter: "invert(1) hue-rotate(180deg)",
  },
  midnight: {
    label: "🌌 Midnight",
    filter: "invert(0.92) hue-rotate(180deg) brightness(0.92) contrast(1.05)",
  },
  dracula: {
    label: "🧛 Dracula",
    filter: "invert(0.9) hue-rotate(200deg) saturate(1.15) contrast(0.95)",
  },
  nord: {
    label: "🏔️ Nord",
    filter: "invert(0.9) hue-rotate(165deg) saturate(0.8) brightness(0.98)",
  },
  sepia: {
    label: "📜 Warm Sepia",
    filter: "invert(0.9) hue-rotate(180deg) sepia(0.35) contrast(0.95)",
  },
  solarized: {
    label: "🌗 Solarized",
    filter: "invert(0.88) hue-rotate(180deg) sepia(0.45) saturate(1.25)",
  },
};

/**
 * Resolve a theme id to a valid entry, falling back to "off".
 */
function resolveTheme(themeId) {
  if (themeId && Object.prototype.hasOwnProperty.call(SCALER_THEMES, themeId)) {
    return { id: themeId, ...SCALER_THEMES[themeId] };
  }
  return { id: "off", ...SCALER_THEMES.off };
}

/**
 * Build the CSS for a given theme recipe.
 */
function buildThemeCss(filter) {
  if (!filter) return "";
  return `
    html.${SCALER_THEME_ROOT_CLASS} {
      filter: ${filter} !important;
      background-color: #ffffff !important;
      transition: filter 0.25s ease;
    }

    /* Keep real media looking natural — undo the root inversion. */
    html.${SCALER_THEME_ROOT_CLASS} img,
    html.${SCALER_THEME_ROOT_CLASS} video,
    html.${SCALER_THEME_ROOT_CLASS} canvas,
    html.${SCALER_THEME_ROOT_CLASS} iframe,
    html.${SCALER_THEME_ROOT_CLASS} embed,
    html.${SCALER_THEME_ROOT_CLASS} object,
    html.${SCALER_THEME_ROOT_CLASS} svg image,
    html.${SCALER_THEME_ROOT_CLASS} [style*="background-image"],
    html.${SCALER_THEME_ROOT_CLASS} .scaler-no-invert {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
    }

    /* Double-negative guard: a media element that opts back in. */
    html.${SCALER_THEME_ROOT_CLASS} .scaler-keep-invert {
      filter: none !important;
    }
  `;
}

/**
 * Ensure the <style id="scaler-theme-styles"> node exists and return it.
 */
function getThemeStyleNode() {
  let node = document.getElementById(SCALER_THEME_STYLE_ID);
  if (!node) {
    node = document.createElement("style");
    node.id = SCALER_THEME_STYLE_ID;
    (document.head || document.documentElement).appendChild(node);
  }
  return node;
}

/**
 * Apply a theme by id. Pass "off" (or unknown) to remove all theming.
 * Safe to call repeatedly — it is idempotent.
 */
function applyTheme(themeId) {
  if (typeof document === "undefined" || !document.documentElement) return;

  const theme = resolveTheme(themeId);
  const root = document.documentElement;

  if (!theme.filter) {
    // Off: strip the class and clear the stylesheet.
    root.classList.remove(SCALER_THEME_ROOT_CLASS);
    const existing = document.getElementById(SCALER_THEME_STYLE_ID);
    if (existing) existing.textContent = "";
    return;
  }

  getThemeStyleNode().textContent = buildThemeCss(theme.filter);
  root.classList.add(SCALER_THEME_ROOT_CLASS);
}

/**
 * Read the saved theme straight from chrome.storage.sync and apply it.
 * Storage is the single source of truth (the popup writes there), so this is
 * robust regardless of content-script load timing or whether settings.js has
 * finished loading. Falls back gracefully when the extension context is gone.
 */
async function initThemeManager() {
  try {
    if (
      typeof chrome === "undefined" ||
      !chrome.storage ||
      !chrome.storage.sync
    ) {
      return;
    }
    const result = await chrome.storage.sync.get("cleanerSettings");
    const theme = result?.cleanerSettings?.theme || "off";
    applyTheme(theme);
  } catch (error) {
    if (error?.message && error.message.includes("context invalidated")) return;
    console.warn("[Scaler++] themeManager init failed:", error);
  }
}

/**
 * React to settings changes written by the popup. This makes the theme apply
 * the instant it is saved — independent of the tab-messaging path — so it works
 * even if a message is missed or the content script loaded after page load.
 */
function watchThemeChanges() {
  try {
    if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
    if (watchThemeChanges._wired) return;
    watchThemeChanges._wired = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "sync" || !changes.cleanerSettings) return;
      const next = changes.cleanerSettings.newValue || {};
      applyTheme(next.theme || "off");
    });
  } catch (_) {
    /* no-op */
  }
}

// Expose for the test harness / other modules (no-op in the browser global).
if (typeof window !== "undefined") {
  window.SCALER_THEMES = SCALER_THEMES;
  window.applyTheme = applyTheme;
  window.initThemeManager = initThemeManager;
  window.watchThemeChanges = watchThemeChanges;

  // Apply ASAP. Content scripts run at document_idle, so content.js's
  // load / DOMContentLoaded handlers may fire AFTER this point (or already
  // have). Don't depend on them: documentElement exists now, so theme now.
  if (document.documentElement) {
    initThemeManager();
    watchThemeChanges();
  }
}
