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

// Class/attr used to flag natively-dark regions (code editors, video players,
// the lecture whiteboard, dark output panels) that must NOT be inverted again —
// otherwise a root invert turns them white. Flagged statically (selectors) and
// dynamically (runtime luminance scan).
const SCALER_NO_INVERT_CLASS = "scaler-no-invert";
const SCALER_DARK_ATTR = "data-scaler-dark-region";

// Candidate containers scanned for being natively dark. Scaler renders whole
// sections dark by default (the lecture player + its top bar / chat sidebar /
// notice board / icon rail, code editors, terminals, etc.). Inverting those
// turns them white, so we scan structural containers broadly and the runtime
// luminance check (hasDarkBackground) confirms each is actually dark before
// flagging it — light elements are never touched. Document order means the
// OUTERMOST dark container is flagged and its children are skipped.
const SCALER_DARK_CANDIDATES = [
  "div",
  "section",
  "header",
  "footer",
  "nav",
  "aside",
  "main",
  "article",
  "ul",
  "ol",
  "form",
  "table",
  "pre",
  "code",
  ".monaco-editor",
  ".cm-editor",
  ".CodeMirror",
  ".ace_editor",
].join(",");

// Ignore slivers/icons — only treat reasonably-sized boxes as dark "regions".
const SCALER_DARK_MIN_W = 48;
const SCALER_DARK_MIN_H = 28;

// Figtree is bundled with the extension (fonts/figtree.woff2) so it loads
// reliably regardless of the page's CSP — exactly the font midnight-discord
// uses. This is the same fallback stack midnight-discord declares.
const SCALER_FONT_STACK =
  "'Figtree','figtree','gg sans','Noto Sans','Helvetica Neue',Helvetica,Arial,sans-serif";

// Theme catalogue. `filter: null` means "no theming" (off / light = the
// site's native look). Order here is the order shown in the popup dropdown.
//
// A theme may also carry styling extras that are layered ON TOP of the filter:
//   font:    apply the bundled Figtree font globally
//   rounded: apply midnight-discord's rounded corners to UI elements
// These are real CSS (unaffected by the root filter) and are scoped to the
// theme's own class, so they only touch the theme that opts in.
const SCALER_THEMES = {
  off: { label: "🌞 Light (Off)", filter: null },
  dark: {
    label: "🌚 Dark",
    filter: "invert(1) hue-rotate(180deg)",
  },
  midnight: {
    // Ported from refact0r/midnight-discord: its hue-220 blue-gray darkness
    // (approximated via a tuned root filter for full site compatibility) PLUS
    // its exact Figtree font, rounded corners and blue accent.
    //
    // The leading sepia() tints otherwise-hueless neutrals so they lean
    // blue-gray (hue ~220) after the invert+hue-rotate, matching midnight's
    // bg rather than a flat neutral grey.
    label: "🌌 Midnight",
    filter:
      "invert(0.9) sepia(0.14) hue-rotate(185deg) brightness(0.92) saturate(1.05)",
    // Root background shown behind transparent gaps. This is the PRE-image of
    // midnight's dark blue-gray — the filter flips its lightness to ~10%.
    bg: "hsl(40, 12%, 92%)",
    font: true,
    rounded: true,
    // Accent PRE-image: a dark blue that the root filter flips into midnight's
    // light blue (oklch(70% 0.1 215)). Applied to scrollbar/selection/links.
    accent: "hsl(212, 45%, 30%)",
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
 * The class that scopes a theme's optional font/rounding extras, e.g.
 * "scaler-theme-midnight". Lets extras touch only the opted-in theme.
 */
function themeIdClass(id) {
  return `scaler-theme-${id}`;
}

/**
 * Build midnight-discord's Figtree @font-face + global font-family override.
 * @param {string} fontUrl resolved URL to the bundled woff2.
 */
function buildFontCss(id, fontUrl) {
  const scope = `html.${themeIdClass(id)}`;
  return `
    @font-face {
      font-family: 'Figtree';
      font-style: normal;
      font-weight: 300 900;
      font-display: swap;
      src: url('${fontUrl}') format('woff2');
    }
    ${scope}, ${scope} * {
      font-family: ${SCALER_FONT_STACK} !important;
    }
  `;
}

/**
 * Build midnight-discord's rounded-corner styling, scoped to the theme class.
 * Uses case-insensitive class matching so it adapts to Scaler's utility class
 * names without hard-coding any of them.
 */
function buildRoundedCss(id) {
  const s = `html.${themeIdClass(id)}`;
  return `
    ${s} {
      --scaler-r-sm: 8px;
      --scaler-r-md: 12px;
      --scaler-r-lg: 16px;
    }
    ${s} button,
    ${s} input,
    ${s} textarea,
    ${s} select,
    ${s} [class*="btn" i],
    ${s} [class*="button" i],
    ${s} [class*="card" i],
    ${s} [class*="modal" i],
    ${s} [class*="dialog" i],
    ${s} [class*="panel" i],
    ${s} [class*="badge" i],
    ${s} [class*="chip" i],
    ${s} [class*="tag" i] {
      border-radius: var(--scaler-r-md) !important;
    }
    ${s} img,
    ${s} video,
    ${s} [class*="avatar" i],
    ${s} [class*="thumbnail" i],
    ${s} [class*="cover" i] {
      border-radius: var(--scaler-r-lg) !important;
    }
    ${s} ::-webkit-scrollbar-thumb {
      border-radius: var(--scaler-r-lg) !important;
    }
  `;
}

/**
 * Build midnight-discord's blue accent, scoped to the theme class.
 * `accent` is the PRE-image color: the root filter flips its lightness, so a
 * dark blue here renders as midnight's light blue on screen.
 */
function buildAccentCss(id, accent) {
  const s = `html.${themeIdClass(id)}`;
  return `
    ${s} { accent-color: ${accent} !important; }
    ${s} ::selection { background: ${accent} !important; color: #fff !important; }
    ${s} ::-webkit-scrollbar-thumb { background: ${accent} !important; }
    ${s} ::-webkit-scrollbar-thumb:hover { background: ${accent} !important; filter: brightness(1.2); }
    ${s} a:not([role="button"]),
    ${s} a:not([role="button"]) * {
      color: ${accent} !important;
    }
    ${s} :focus-visible {
      outline-color: ${accent} !important;
    }
  `;
}

/**
 * Build the full CSS for a theme: the root colour filter (+ media counter)
 * plus any opted-in font / rounded-corner extras.
 * @param {object} theme   resolved theme entry (with id)
 * @param {string} fontUrl resolved bundled-font URL
 */
function buildThemeCss(theme, fontUrl) {
  if (!theme || !theme.filter) return "";
  const r = SCALER_THEME_ROOT_CLASS;
  let css = `
    html.${r} {
      filter: ${theme.filter} !important;
      background-color: ${theme.bg || "#ffffff"} !important;
      transition: filter 0.25s ease;
    }

    /* Keep real media + natively-dark widgets looking natural — undo the root
       inversion. Stable editor/player classes are listed statically; other
       dark regions are flagged at runtime with .${SCALER_NO_INVERT_CLASS}. */
    html.${r} img,
    html.${r} video,
    html.${r} canvas,
    html.${r} iframe,
    html.${r} embed,
    html.${r} object,
    html.${r} svg image,
    html.${r} [style*="background-image"],
    html.${r} .monaco-editor,
    html.${r} .cm-editor,
    html.${r} .CodeMirror,
    html.${r} .ace_editor,
    html.${r} .${SCALER_NO_INVERT_CLASS} {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
    }

    /* A counter-inverted region is already back to normal orientation, so media
       inside it must NOT be inverted again (that would double-flip it). */
    html.${r} .${SCALER_NO_INVERT_CLASS} img,
    html.${r} .${SCALER_NO_INVERT_CLASS} video,
    html.${r} .${SCALER_NO_INVERT_CLASS} canvas,
    html.${r} .${SCALER_NO_INVERT_CLASS} iframe,
    html.${r} .${SCALER_NO_INVERT_CLASS} svg image,
    html.${r} .${SCALER_NO_INVERT_CLASS} [style*="background-image"] {
      filter: none !important;
    }

    /* Double-negative guard: a media element that opts back in. */
    html.${r} .scaler-keep-invert {
      filter: none !important;
    }
  `;

  if (theme.font && fontUrl) css += buildFontCss(theme.id, fontUrl);
  if (theme.rounded) css += buildRoundedCss(theme.id);
  if (theme.accent) css += buildAccentCss(theme.id, theme.accent);
  return css;
}

/**
 * Resolve the bundled font URL (chrome-extension:// in the browser; a plain
 * relative path under tests where chrome.runtime.getURL is absent).
 */
function resolveFontUrl() {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL("fonts/figtree.woff2");
    }
  } catch (_) {
    /* fall through */
  }
  return "fonts/figtree.woff2";
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
 * Parse a CSS color string ("rgb(...)" / "rgba(...)") into {r,g,b,a}.
 * Returns null for anything we can't read (e.g. "transparent", "", jsdom "").
 */
function parseRgb(str) {
  if (!str) return null;
  const m = str.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?/i,
  );
  if (!m) return null;
  return {
    r: +m[1],
    g: +m[2],
    b: +m[3],
    a: m[4] === undefined ? 1 : +m[4],
  };
}

/**
 * Perceived (sRGB) luminance 0..1 of an {r,g,b}.
 */
function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * Is this element's own background a solid, dark color? (Transparent/near-
 * transparent backgrounds inherit the parent and are left alone.)
 */
function hasDarkBackground(el) {
  try {
    const bg = parseRgb(getComputedStyle(el).backgroundColor);
    return !!bg && bg.a >= 0.5 && luminance(bg) < 0.22;
  } catch (_) {
    return false;
  }
}

/**
 * Scan candidate elements and flag the genuinely-dark ones so the CSS counter
 * rule keeps them dark instead of inverting them to white. Bounded to a
 * curated candidate set + a luminance check, so it's cheap and never touches
 * light elements. Skips anything already inside a flagged region.
 */
function neutralizeDarkRegions(scope) {
  if (typeof document === "undefined" || !document.documentElement) return;
  if (!document.documentElement.classList.contains(SCALER_THEME_ROOT_CLASS)) {
    return;
  }
  const root = scope && scope.querySelectorAll ? scope : document.body;
  if (!root) return;
  let nodes;
  try {
    nodes = root.querySelectorAll(SCALER_DARK_CANDIDATES);
  } catch (_) {
    return;
  }
  // Two phases to avoid layout thrash:
  //   1. read-only — measure size + background, collect dark candidates.
  //   2. mutate — add classes, skipping any whose ancestor is already flagged
  //      (so only the OUTERMOST dark region in a subtree is counter-inverted).
  // Phase 2 only touches classes/attrs + reads DOM structure (no layout), so it
  // never interleaves a style write with a layout read.
  const darkCandidates = [];
  nodes.forEach((el) => {
    if (el.hasAttribute(SCALER_DARK_ATTR)) return;
    // Skip tiny elements (icons, dividers) — only flag real regions. Only
    // applies when layout is available (offset* are 0 under jsdom / no layout).
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if ((w || h) && (w < SCALER_DARK_MIN_W || h < SCALER_DARK_MIN_H)) {
      return;
    }
    if (hasDarkBackground(el)) darkCandidates.push(el);
  });
  // Document order → ancestors precede descendants, so the closest() check
  // below sees an already-flagged ancestor and skips nested duplicates.
  darkCandidates.forEach((el) => {
    if (el.parentElement && el.parentElement.closest(`.${SCALER_NO_INVERT_CLASS}`)) {
      return;
    }
    el.classList.add(SCALER_NO_INVERT_CLASS);
    el.setAttribute(SCALER_DARK_ATTR, "");
  });
}

/**
 * Remove all runtime dark-region flags (used when theming is turned off).
 */
function clearDarkRegions() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(`[${SCALER_DARK_ATTR}]`).forEach((el) => {
    el.classList.remove(SCALER_NO_INVERT_CLASS);
    el.removeAttribute(SCALER_DARK_ATTR);
  });
}

let _darkRegionObserver = null;
let _darkRegionTimer = null;

/**
 * Keep dark regions flagged as the SPA swaps content in (debounced).
 */
function observeDarkRegions() {
  if (typeof MutationObserver === "undefined" || !document.body) return;
  if (_darkRegionObserver) return;
  _darkRegionObserver = new MutationObserver(() => {
    clearTimeout(_darkRegionTimer);
    _darkRegionTimer = setTimeout(() => neutralizeDarkRegions(document.body), 400);
  });
  _darkRegionObserver.observe(document.body, { childList: true, subtree: true });
}

function stopDarkRegionObserver() {
  if (_darkRegionObserver) {
    _darkRegionObserver.disconnect();
    _darkRegionObserver = null;
  }
  clearTimeout(_darkRegionTimer);
}

/**
 * Apply a theme by id. Pass "off" (or unknown) to remove all theming.
 * Safe to call repeatedly — it is idempotent.
 */
function applyTheme(themeId) {
  if (typeof document === "undefined" || !document.documentElement) return;

  const theme = resolveTheme(themeId);
  const root = document.documentElement;

  // Always clear any previous per-theme id class (e.g. scaler-theme-midnight)
  // so font/rounding extras never leak across a theme switch.
  Object.keys(SCALER_THEMES).forEach((id) =>
    root.classList.remove(themeIdClass(id)),
  );

  if (!theme.filter) {
    // Off: strip the class, clear the stylesheet, drop dark-region flags.
    root.classList.remove(SCALER_THEME_ROOT_CLASS);
    const existing = document.getElementById(SCALER_THEME_STYLE_ID);
    if (existing) existing.textContent = "";
    stopDarkRegionObserver();
    clearDarkRegions();
    return;
  }

  getThemeStyleNode().textContent = buildThemeCss(theme, resolveFontUrl());
  root.classList.add(SCALER_THEME_ROOT_CLASS);
  root.classList.add(themeIdClass(theme.id));

  // Protect natively-dark widgets (code editor, lecture player, etc.) from
  // being inverted to white, and keep protecting them as the SPA mutates.
  neutralizeDarkRegions(document.body);
  observeDarkRegions();
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
  window.neutralizeDarkRegions = neutralizeDarkRegions;
  window.clearDarkRegions = clearDarkRegions;

  // Apply ASAP. Content scripts run at document_idle, so content.js's
  // load / DOMContentLoaded handlers may fire AFTER this point (or already
  // have). Don't depend on them: documentElement exists now, so theme now.
  if (document.documentElement) {
    initThemeManager();
    watchThemeChanges();
  }
}
