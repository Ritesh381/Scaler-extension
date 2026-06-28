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

// Counter for natively-dark REGIONS (code editors, players, dark panels, etc.).
// Same un-inversion as media, plus a brightness BUMP so the region's native
// dark-grey blends down toward the inverted near-black page instead of standing
// out as a lighter panel. A region sits between the root invert and this counter
// invert, so brightness > 1 darkens the final result (and keeps light text
// readable). Media INSIDE such a region is filter:none, so it only inherits the
// 1.1x brightness (a slight brighten) — never dimmed.
const SCALER_THEME_REGION_COUNTER =
  "invert(1) hue-rotate(180deg) brightness(1.1)";

// Class/attr used to flag natively-dark regions (code editors, video players,
// the lecture whiteboard, dark output panels) that must NOT be inverted again —
// otherwise a root invert turns them white. Flagged statically (selectors) and
// dynamically (runtime luminance scan).
const SCALER_NO_INVERT_CLASS = "scaler-no-invert";
const SCALER_DARK_ATTR = "data-scaler-dark-region";

// Monaco editors carry an UNAMBIGUOUS theme class — `vs-dark` / `hc-black` /
// `hc-dark` for dark themes, `vs` / `hc-light` for light — so we can counter-
// invert the dark ones STATICALLY, by class, the instant Monaco applies the
// theme. This is what makes a dark editor reliably stay dark.
//
// The pure runtime luminance scan (neutralizeDarkRegions) is not enough on its
// own for editors: it flags a region only when it happens to scan it AND the
// background color is already painted. Monaco fails both — its background is
// injected by a generated stylesheet slightly AFTER the element mounts, and a
// user switching the editor's theme light→dark mutates only CLASSES (no nodes
// added), so the childList observer never re-scans it. The result was a dark
// editor that the root invert flipped to white (#1e1e1e → #e1e1e1).
//
// We deliberately match ONLY the dark modifier, never the bare `.monaco-editor`:
// a LIGHT (`vs`) editor is white and must invert to dark like the rest of the
// page — countering it would leave it white (the regression fixed in bfb9b69).
// On Scaler the editor's containers are all light/transparent (`.layout__content`
// is #fff, etc.), so the `.monaco-editor.vs-dark` node is the OUTERMOST dark
// element — there is no counter-inverted ancestor for this to compound with.
const SCALER_DARK_EDITOR_SELECTOR =
  ".monaco-editor.vs-dark, .monaco-editor.hc-black, .monaco-editor.hc-dark";

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

// Mirrored into the PAGE's localStorage so the document_start preload
// (themePreload.js) can apply the theme before first paint — eliminating the
// light→dark flash (FOUC). The dark-paths list lets the preload skip pages
// that are natively dark, so it never flashes them.
const SCALER_LS_THEME = "scalerpp_theme";
const SCALER_LS_FILTER = "scalerpp_theme_filter";
const SCALER_LS_BG = "scalerpp_theme_bg";
const SCALER_LS_DARKPATHS = "scalerpp_dark_paths";
const SCALER_PRELOAD_STYLE_ID = "scaler-theme-preload";

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
 * Build midnight-discord's Figtree @font-face + font-family override.
 *
 * IMPORTANT: apply the font via INHERITANCE (html + body only), NOT with a
 * universal `* !important`. Icon fonts (Material Icons, FontAwesome, Scaler's
 * own `cr-icon`, etc.) declare their own font-family directly on the element;
 * a directly-set value always wins over an inherited one, so they keep their
 * glyphs. The old `* !important` set Figtree directly on EVERY element, which
 * clobbered those icon fonts and turned icons into garbled text.
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
    ${scope},
    ${scope} body {
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
    ${s} [class*="badge" i] {
      border-radius: var(--scaler-r-md) !important;
    }
    ${s} img,
    ${s} video,
    ${s} [class*="avatar" i],
    ${s} [class*="thumbnail" i] {
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
  // Only unambiguous accent surfaces — NOT a blanket `a { color }` override,
  // which would force every link (including card titles / nav items that are
  // anchors) to blue and hurt readability.
  return `
    ${s} { accent-color: ${accent} !important; }
    ${s} ::selection { background: ${accent} !important; color: #fff !important; }
    ${s} ::-webkit-scrollbar-thumb { background: ${accent} !important; }
    ${s} :focus-visible { outline-color: ${accent} !important; }
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

  // Everything that must be UN-inverted (counter-inverted) to stay dark:
  // runtime-flagged regions PLUS Monaco's dark theme variants (matched
  // statically by class). Built from one list so the counter rule and the
  // "media inside a region" rule below can never drift out of sync.
  const keepDarkSelectors = [
    `.${SCALER_NO_INVERT_CLASS}`,
    ...SCALER_DARK_EDITOR_SELECTOR.split(",").map((s) => s.trim()),
  ];
  const keepDarkRule = keepDarkSelectors
    .map((s) => `html.${r} ${s}`)
    .join(",\n    ");
  const mediaTags = [
    "img",
    "video",
    "canvas",
    "iframe",
    "svg image",
    '[style*="background-image"]',
  ];
  const keepDarkMediaRule = keepDarkSelectors
    .flatMap((s) => mediaTags.map((m) => `html.${r} ${s} ${m}`))
    .join(",\n    ");

  let css = `
    html.${r} {
      filter: ${theme.filter} !important;
      background-color: ${theme.bg || "#ffffff"} !important;
    }

    /* Never invert when printing / exporting to PDF — print the native colors. */
    @media print {
      html.${r} { filter: none !important; }
    }

    /* Real media: un-invert so photos/videos keep their natural colors. */
    html.${r} img,
    html.${r} video,
    html.${r} canvas,
    html.${r} iframe,
    html.${r} embed,
    html.${r} object,
    html.${r} svg image,
    html.${r} [style*="background-image"] {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
    }

    /* The extension's OWN spotlight overlay is already dark-themed, so the root
       invert would flip it to light. Un-invert it (plain counter, no darkening)
       so it renders exactly as designed. #id wins over the region rules below. */
    html.${r} #scaler-spotlight-overlay {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
    }

    /* Natively-dark regions: un-invert AND darken so they blend with the
       inverted near-black page instead of standing out as lighter panels.
       Two sources, both kept dark by the SAME counter:
         • .${SCALER_NO_INVERT_CLASS} — flagged at runtime by the luminance scan
           ONLY when a region's background is actually dark. Handles dark output
           panels, terminals, drawers, non-Monaco editors, etc.
         • Monaco's dark theme variants (.monaco-editor.vs-dark / .hc-black /
           .hc-dark) — matched statically by class so a dark editor stays dark
           the instant Monaco themes it, with no dependency on the scan having
           run (see SCALER_DARK_EDITOR_SELECTOR). A LIGHT (vs) editor is NOT
           matched and simply inverts to dark like the rest of the page. */
    ${keepDarkRule} {
      filter: ${SCALER_THEME_REGION_COUNTER} !important;
    }

    /* A counter-inverted region is already back to normal orientation, so media
       inside it must NOT be inverted again (that would double-flip it). */
    ${keepDarkMediaRule} {
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
    const descendants = Array.from(root.querySelectorAll(SCALER_DARK_CANDIDATES));
    // Include the scope node itself — an added subtree's own root may be dark.
    nodes =
      root.nodeType === 1 && root.matches && root.matches(SCALER_DARK_CANDIDATES)
        ? [root, ...descendants]
        : descendants;
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
    // Never flag the extension's own spotlight overlay or anything inside it —
    // it's handled entirely by its #id counter rule. Flagging the inner panel
    // would counter it on top of the overlay's counter (double-flip → light).
    if (el.id === "scaler-spotlight-overlay" || el.closest("#scaler-spotlight-overlay")) {
      return;
    }
    // A dark Monaco editor (and its whole subtree) is kept dark by the static
    // .vs-dark/.hc-* counter rule (see SCALER_DARK_EDITOR_SELECTOR). The scan
    // must not also flag any element inside it — a second counter on an inner
    // dark element (the text surface, gutter) would double-flip it back to
    // light. So the static rule owns dark editors; the scan owns everything else.
    if (el.closest(SCALER_DARK_EDITOR_SELECTOR)) return;
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

/**
 * Luminance of the page's effective base background. Reads body, then the
 * root element, then the largest opaque-background top-level child. Returns 1
 * (assume light) when nothing opaque is found.
 */
function pageBaseLuminance() {
  const sample = (el) => {
    if (!el) return null;
    try {
      const bg = parseRgb(getComputedStyle(el).backgroundColor);
      return bg && bg.a >= 0.5 ? luminance(bg) : null;
    } catch (_) {
      return null;
    }
  };
  let lum = sample(document.body);
  if (lum === null) lum = sample(document.documentElement);
  if (lum === null && document.body) {
    // Largest top-level child with an opaque background ≈ the app shell bg.
    let best = null;
    let bestArea = 0;
    Array.from(document.body.children).forEach((el) => {
      const area = (el.offsetWidth || 0) * (el.offsetHeight || 0);
      const l = sample(el);
      if (l !== null && area >= bestArea) {
        bestArea = area;
        best = l;
      }
    });
    lum = best;
  }
  return lum === null ? 1 : lum;
}

/**
 * Is the current page already dark by default? (Then inverting it is wrong —
 * we leave it native.)
 */
function pageIsDark() {
  return pageBaseLuminance() < 0.22;
}

// Currently-selected theme id (persists across SPA navigation). The rendered
// result is re-decided per page because some Scaler pages are natively dark.
let _currentThemeId = "off";

/**
 * Mirror the selected theme into the page's localStorage so the document_start
 * preload can re-apply it before first paint on the next load.
 */
function mirrorThemeToStorage(theme) {
  try {
    if (typeof localStorage === "undefined") return;
    if (!theme || !theme.filter) {
      localStorage.removeItem(SCALER_LS_THEME);
      localStorage.removeItem(SCALER_LS_FILTER);
      localStorage.removeItem(SCALER_LS_BG);
      return;
    }
    localStorage.setItem(SCALER_LS_THEME, theme.id);
    localStorage.setItem(SCALER_LS_FILTER, theme.filter);
    localStorage.setItem(SCALER_LS_BG, theme.bg || "#ffffff");
  } catch (_) {
    /* localStorage may be blocked — preload just won't run, no harm */
  }
}

/**
 * Remember whether the current path is natively dark, so the preload can skip
 * pre-inverting it next time (and stop skipping if it turns light again).
 */
function recordPageDarkness(isDark) {
  try {
    if (typeof localStorage === "undefined") return;
    let arr = [];
    try {
      arr = JSON.parse(localStorage.getItem(SCALER_LS_DARKPATHS) || "[]") || [];
    } catch (_) {
      arr = [];
    }
    const p = location.pathname;
    const has = arr.includes(p);
    if (isDark && !has) {
      arr.push(p);
      if (arr.length > 50) arr = arr.slice(-50);
      localStorage.setItem(SCALER_LS_DARKPATHS, JSON.stringify(arr));
    } else if (!isDark && has) {
      localStorage.setItem(
        SCALER_LS_DARKPATHS,
        JSON.stringify(arr.filter((x) => x !== p)),
      );
    }
  } catch (_) {
    /* no-op */
  }
}

/**
 * Remove the document_start preload <style>. Once the main class-gated styles
 * are in place, the preload's ungated `html { filter }` must go — otherwise it
 * would keep inverting a natively-dark page.
 */
function removePreloadStyle() {
  const el =
    typeof document !== "undefined" &&
    document.getElementById(SCALER_PRELOAD_STYLE_ID);
  if (el) el.remove();
}

/**
 * Reconcile ONLY the root/theme classes for the current page (cheap: one
 * pageIsDark() read + classList diffs). Returns whether inversion is active so
 * callers can decide whether to scan for dark regions. Diff-based so a stable
 * page never toggles a class (no flashing).
 */
function reconcileThemeClasses() {
  const root = document.documentElement;
  const theme = resolveTheme(_currentThemeId);
  const isDark = pageIsDark();
  const wantInvert = !!theme.filter && !isDark;
  const wantIdClass = wantInvert ? themeIdClass(theme.id) : null;

  // Learn which paths are natively dark (only meaningful when a theme is on).
  if (theme.filter) recordPageDarkness(isDark);

  const hasActive = root.classList.contains(SCALER_THEME_ROOT_CLASS);
  if (wantInvert && !hasActive) root.classList.add(SCALER_THEME_ROOT_CLASS);
  else if (!wantInvert && hasActive) {
    root.classList.remove(SCALER_THEME_ROOT_CLASS);
  }

  Object.keys(SCALER_THEMES).forEach((id) => {
    const cls = themeIdClass(id);
    if (cls !== wantIdClass && root.classList.contains(cls)) {
      root.classList.remove(cls);
    }
  });
  if (wantIdClass && !root.classList.contains(wantIdClass)) {
    root.classList.add(wantIdClass);
  }
  return wantInvert;
}

/**
 * Full evaluate for THIS page (theme off / native-dark / light+invert). Does a
 * one-off full-document dark-region scan — used on apply and navigation, NOT on
 * every mutation (the observer scans only added subtrees to stay cheap).
 *  - theme off            → nothing.
 *  - page already dark     → leave it native (no invert, no extras).
 *  - light page + invert   → invert + protect any dark widgets on it.
 */
function evaluateAndRender() {
  if (typeof document === "undefined" || !document.documentElement) return;
  if (reconcileThemeClasses()) neutralizeDarkRegions(document.body);
  else clearDarkRegions();
  // Main class-gated styles now govern the page — drop the preload shim so it
  // can't keep inverting a natively-dark page.
  removePreloadStyle();
}

let _themeObserver = null;
let _rafId = null;
let _rafPending = false;
let _pendingNodes = new Set();

// Schedule a flush before the next paint. Using requestAnimationFrame (not a
// timer) means newly-added dark regions are flagged BEFORE the browser paints
// them — so a dark drawer/panel never flashes white-then-black on open. Falls
// back to a short timer where rAF is unavailable.
function scheduleFlush() {
  if (_rafPending) return;
  _rafPending = true;
  const raf =
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame
      : (cb) => setTimeout(cb, 16);
  _rafId = raf(() => {
    _rafPending = false;
    _rafId = null;
    flushPendingNodes();
  });
}

/**
 * Has the extension context been invalidated (extension reloaded/updated)?
 * If so we must tear down so we don't keep firing into a dead context.
 */
function contextGone() {
  try {
    return !(typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id);
  } catch (_) {
    return true;
  }
}

/**
 * Flush queued mutations: reconcile classes (cheap) and scan ONLY the newly
 * added subtrees for dark regions — never the whole document. This keeps cost
 * proportional to what changed, not to page size, so it doesn't churn CPU/
 * memory on a constantly-mutating dashboard.
 */
function flushPendingNodes() {
  if (contextGone()) {
    stopThemeObserver();
    return;
  }
  const wantInvert = reconcileThemeClasses();
  if (wantInvert) {
    _pendingNodes.forEach((node) => {
      if (node && node.isConnected) neutralizeDarkRegions(node);
    });
  }
  _pendingNodes.clear();
}

/**
 * Re-evaluate the theme as the SPA swaps content / navigates (debounced) — so
 * dark widgets stay protected and natively-dark pages stay native. Only added
 * element subtrees are queued for scanning.
 */
function startThemeObserver() {
  if (typeof MutationObserver === "undefined" || !document.body) return;
  if (_themeObserver) return;
  _themeObserver = new MutationObserver((records) => {
    for (const rec of records) {
      rec.addedNodes &&
        rec.addedNodes.forEach((n) => {
          if (n.nodeType === 1) _pendingNodes.add(n);
        });
    }
    scheduleFlush();
  });
  _themeObserver.observe(document.body, { childList: true, subtree: true });
}

function stopThemeObserver() {
  if (_themeObserver) {
    _themeObserver.disconnect();
    _themeObserver = null;
  }
  if (_rafId != null && typeof cancelAnimationFrame === "function") {
    cancelAnimationFrame(_rafId);
  }
  _rafId = null;
  _rafPending = false;
  _pendingNodes.clear();
}

/**
 * Apply a theme by id. Pass "off" (or unknown) to remove all theming.
 * Safe to call repeatedly — it is idempotent.
 */
function applyTheme(themeId) {
  if (typeof document === "undefined" || !document.documentElement) return;

  _currentThemeId = resolveTheme(themeId).id;
  const theme = resolveTheme(_currentThemeId);

  // Mirror to localStorage so the next load's preload can avoid the FOUC.
  mirrorThemeToStorage(theme);

  if (!theme.filter) {
    // Off: clear stylesheet, flags, observer, classes.
    const existing = document.getElementById(SCALER_THEME_STYLE_ID);
    if (existing) existing.textContent = "";
    stopThemeObserver();
    evaluateAndRender();
    return;
  }

  // Stylesheet is theme-specific but page-agnostic — set it once here; the
  // root/id classes (toggled in evaluateAndRender) gate whether it takes effect.
  getThemeStyleNode().textContent = buildThemeCss(theme, resolveFontUrl());
  evaluateAndRender();
  startThemeObserver();
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
  window.pageIsDark = pageIsDark;
  window.evaluateAndRender = evaluateAndRender;

  // Apply ASAP. Content scripts run at document_idle, so content.js's
  // load / DOMContentLoaded handlers may fire AFTER this point (or already
  // have). Don't depend on them: documentElement exists now, so theme now.
  if (document.documentElement) {
    initThemeManager();
    watchThemeChanges();
  }

  // Tear down the observer/timers when the page goes away, so nothing lingers.
  if (typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", stopThemeObserver, { once: true });
  }
}
