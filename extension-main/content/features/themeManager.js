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
//
// VIDEO-SCOPED MODE
// -----------------
// A counter-filter can never give a video its real colours back: hue-rotate
// clamps out-of-gamut values, so saturated colours (pure red) are simply not
// reachable through the root filter. When a lecture-sized <video> is on screen
// the root filter is therefore dropped and the theme is applied to every
// subtree EXCEPT the video and its ancestors (see scopeAroundVideos).
// ============================================

const SCALER_THEME_STYLE_ID = "scaler-theme-styles";
const SCALER_THEME_ROOT_CLASS = "scaler-theme-active";

// The canonical self-inverse recipe: applying `invert(1) hue-rotate(180deg)`
// twice is the identity. The plain Dark theme's filter IS exactly this recipe,
// which is why media counter-inverted with it returns to its EXACT original
// colors. Tinted themes layer extra sepia/partial-invert/etc. that has no exact
// CSS inverse, so only a self-inverse theme can guarantee pristine media.
const SCALER_SELF_INVERSE = "invert(1) hue-rotate(180deg)";

// Counter recipe applied to media so photos/videos are NOT inverted. For a
// self-inverse theme (Dark) this is the EXACT inverse of the root filter, so
// images keep their true colors; for tinted recipes it neutralises the dominant
// invert+hue and any residual tint is minor and visually acceptable.
const SCALER_THEME_MEDIA_COUNTER = SCALER_SELF_INVERSE;

// Counter for natively-dark REGIONS (code editors, players, dark panels, etc.).
// Same un-inversion as media, plus a brightness BUMP so the region's native
// dark-grey blends down toward the inverted near-black page instead of standing
// out as a lighter panel. A region sits between the root invert and this counter
// invert, so brightness > 1 darkens the final result (and keeps light text
// readable). The bump is factored out so the in-region media rule can cancel it
// exactly (see buildThemeCss) — otherwise images in dark panels render ~10%
// brighter than the original.
const SCALER_REGION_BRIGHTNESS = 1.1;
const SCALER_THEME_REGION_COUNTER = `${SCALER_SELF_INVERSE} brightness(${SCALER_REGION_BRIGHTNESS})`;

// Class/attr used to flag natively-dark regions (code editors, video players,
// the lecture whiteboard, dark output panels) that must NOT be inverted again —
// otherwise a root invert turns them white. Flagged statically (selectors) and
// dynamically (runtime luminance scan).
const SCALER_NO_INVERT_CLASS = "scaler-no-invert";
const SCALER_DARK_ATTR = "data-scaler-dark-region";

// A background is "dark" below this sRGB luminance (0..1).
const SCALER_DARK_LUMINANCE = 0.22;

// Video-scoped mode: root class used INSTEAD of SCALER_THEME_ROOT_CLASS while a
// lecture-sized video is on screen. The root is left unfiltered and each themed
// subtree carries SCALER_THEMED_CLASS (+ attr, so teardown can find them).
// Light ancestors of the video can't be filtered, so their background is
// recoloured inline and tagged with SCALER_VIDEO_PATH_ATTR for restoring.
const SCALER_THEME_SCOPED_CLASS = "scaler-theme-scoped";
const SCALER_THEMED_CLASS = "scaler-themed";
const SCALER_THEMED_ATTR = "data-scaler-themed";
const SCALER_VIDEO_PATH_ATTR = "data-scaler-video-path";

// Smallest <video> that switches the page to video-scoped mode. Keeps preview
// thumbnails and avatars on the (cheaper) root-filter path.
const SCALER_EXEMPT_VIDEO_MIN_W = 320;
const SCALER_EXEMPT_VIDEO_MIN_H = 180;

// Elements left native (unfiltered) in video-scoped mode — the same things the
// root-mode media counter un-inverts, plus non-rendering tags.
const SCALER_NATIVE_TAGS = new Set([
  "img",
  "video",
  "canvas",
  "iframe",
  "embed",
  "object",
  "picture",
  "script",
  "style",
  "link",
  "template",
  "noscript",
]);

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
  // Root mode only: the accent is a pre-image that is correct only once the
  // root filter flips it. In video-scoped mode the root (scrollbar, selection)
  // is unfiltered, so the dark pre-image would show as-is.
  const s = `html.${SCALER_THEME_ROOT_CLASS}.${themeIdClass(id)}`;
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
 * Build the full CSS for a theme: the root colour filter (+ media counter),
 * the video-scoped variant of the same rules, plus any opted-in font /
 * rounded-corner extras. The root classes decide which variant applies.
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
    }

    /* Never invert when printing / exporting to PDF — print the native colors. */
    @media print {
      html.${r} { filter: none !important; }
    }
  `;
  css += buildFilteredScopeCss(theme, `html.${r}`);
  css += buildVideoScopedCss(theme);

  if (theme.font && fontUrl) css += buildFontCss(theme.id, fontUrl);
  if (theme.rounded) css += buildRoundedCss(theme.id);
  if (theme.accent) css += buildAccentCss(theme.id, theme.accent);
  return css;
}

/**
 * Rules for everything INSIDE a filtered element: media counters, dark-region
 * counters and the Scaler component fixes. Emitted once for the root filter
 * (`html.scaler-theme-active`) and once for video-scoped mode, where each themed
 * subtree carries the filter instead of the root.
 * @param {object} theme resolved theme entry (with id)
 * @param {string} scope selector of the filtered element
 */
function buildFilteredScopeCss(theme, scope) {
  // Everything that must be UN-inverted (counter-inverted) to stay dark:
  // runtime-flagged regions PLUS Monaco's dark theme variants (matched
  // statically by class). Built from one list so the counter rule and the
  // "media inside a region" rule below can never drift out of sync.
  const keepDarkSelectors = [
    `.${SCALER_NO_INVERT_CLASS}`,
    ...SCALER_DARK_EDITOR_SELECTOR.split(",").map((s) => s.trim()),
  ];
  const keepDarkRule = keepDarkSelectors
    .map((s) => `${scope} ${s}`)
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
    .flatMap((s) => mediaTags.map((m) => `${scope} ${s} ${m}`))
    .join(",\n    ");

  // Filter for media INSIDE a counter-inverted region. The region un-inverts the
  // media (good) but also applied its brightness bump, so plain `filter:none`
  // leaves an image ~10% brighter than the original. On a SELF-INVERSE theme we
  // can cancel that bump EXACTLY: `P · brightness(1/b) · P` telescopes to the
  // identity through the root- and region-inversions (P·P = identity, and the
  // two brightness factors multiply to 1), so images in dark panels/editors keep
  // their TRUE colors. Tinted themes are not self-inverse and have no exact CSS
  // cancel, so they keep the previous `none` (unchanged — no regression).
  const isSelfInverse = theme.filter === SCALER_SELF_INVERSE;
  const regionMediaFilter = isSelfInverse
    ? `${SCALER_SELF_INVERSE} brightness(${(1 / SCALER_REGION_BRIGHTNESS).toFixed(4)}) ${SCALER_SELF_INVERSE}`
    : "none";

  return `
    /* Real media: un-invert so photos/videos keep their natural colors. */
    ${scope} img,
    ${scope} video,
    ${scope} canvas,
    ${scope} iframe,
    ${scope} embed,
    ${scope} object,
    ${scope} svg image,
    ${scope} [style*="background-image"] {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
    }

    /* The extension's OWN spotlight overlay is already dark-themed, so the root
       invert would flip it to light. Un-invert it (plain counter, no darkening)
       so it renders exactly as designed. #id wins over the region rules below.

       Also kill its backdrop-filter: blur. A backdrop-filter samples the content
       BEHIND the element, but the root <html> filter moves the backdrop root, so
       the blur captures the PRE-invert (light) page and washes the whole overlay
       out to light (filter + backdrop-filter don't compose). The solid dim
       background already separates the panel, so dropping the blur in dark mode
       restores a correctly-dark overlay. */
    ${scope} #scaler-spotlight-overlay {
      filter: ${SCALER_THEME_MEDIA_COUNTER} !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
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
       inside it must NOT be inverted again (that would double-flip it). On a
       self-inverse theme we go further and cancel the region's brightness bump
       too, so images in dark panels keep their EXACT original colors rather than
       a ~10%-brighter version (see regionMediaFilter). */
    ${keepDarkMediaRule} {
      filter: ${regionMediaFilter} !important;
    }

    /* Double-negative guard: a media element that opts back in. */
    ${scope} .scaler-keep-invert {
      filter: none !important;
    }

    /* ── Scaler component fixes: dark overlays that the root invert flips to a
       white glow. A box-shadow / dark gradient scrim is part of the element's
       paint, so the filter inverts its color along with everything else — a
       black drop becomes an ugly white halo.

       The session / dashboard / curated-video cards (.past-events__info) fade
       their bottom to dark via an ::after gradient (a text-legibility scrim).
       Inverted, that fade glows white. We can't un-invert just the scrim, so we
       re-author it with a PRE-INVERTED gradient: white here renders BLACK after
       the root invert (white is achromatic, so this holds across every dark
       theme — exact on Dark, near-black on the tinted recipes). Result: the
       scrim stays a dark shadow, as designed. */
    ${scope} .past-events__info::after {
      background-image: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 0),
        rgba(255, 255, 255, 0.52) 90%,
        #ffffff
      ) !important;
    }

    /* ...and the card text that SITS on that scrim. Those labels are authored
       white, so the root invert paints them BLACK — onto a scrim the rule above
       deliberately keeps dark. The two fixes have to move together: keeping the
       scrim dark is only correct if its text stays light. Same pre-inversion
       trick, applied to the color: black here renders WHITE after the root
       invert (achromatic, so it holds across every dark theme). */
    ${scope} .past-events__headline,
    ${scope} .past-events__desc,
    ${scope} .past-events__close-button {
      color: #000000 !important;
    }

    /* The Scaler wordmark is dark navy ink on a TRANSPARENT canvas, so the
       generic media rule above works against it: the root invert had already
       made it legible (dark ink -> light ink) and un-inverting it puts it back
       to dark-on-dark, i.e. invisible against the themed page. Opt it out so it
       rides the root invert like the surrounding header text does.

       Scoped deliberately narrowly — to this one asset and its two mount points
       (page header + slide-out sidebar) — rather than to logos in general: a
       blanket "don't un-invert small images" rule would also flip genuinely
       dark ARTWORK, which the media rule is there to protect. */
    ${scope} img[src*="sst-logo"],
    ${scope} img[alt="sst_logo"],
    ${scope} .sidebar__header img[alt="logo"] {
      filter: none !important;
    }
  `;
}

/**
 * Video-scoped mode CSS. The root stays unfiltered, so a lecture video and its
 * player render pixel-exact, and every subtree flagged by scopeAroundVideos()
 * carries the theme filter instead. Inside those subtrees the usual media and
 * dark-region counters apply, from the same rules as root mode.
 * @param {object} theme resolved theme entry (with id)
 */
function buildVideoScopedCss(theme) {
  const s = `html.${SCALER_THEME_SCOPED_CLASS}`;
  const scope = `${s} .${SCALER_THEMED_CLASS}`;
  return `
    /* The root is NOT filtered in this mode, so paint it with the colour the
       filter would have turned theme.bg into. */
    ${s} {
      background-color: ${themedCssColor(theme, theme.bg || "#ffffff")} !important;
    }

    ${scope} {
      filter: ${theme.filter} !important;
    }

    @media print {
      ${scope} { filter: none !important; }
    }
  ` + buildFilteredScopeCss(theme, scope);
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
 * Parse an authored CSS colour — rgb()/rgba(), #rgb/#rgba/#rrggbb/#rrggbbaa or
 * hsl()/hsla() — into {r,g,b,a}. Returns null for anything else.
 */
function parseCssColor(str) {
  if (!str) return null;
  const s = String(str).trim();
  const rgb = parseRgb(s);
  if (rgb) return rgb;

  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) {
      h = h
        .split("")
        .map((x) => x + x)
        .join("");
    }
    if (h.length !== 6 && h.length !== 8) return null;
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
    };
  }

  const hsl = s.match(
    /^hsla?\(\s*(-?[\d.]+)(?:deg)?[,\s]+([\d.]+)%[,\s]+([\d.]+)%(?:[,/\s]+([\d.]+)(%?))?\s*\)$/i,
  );
  if (hsl) {
    // CSS Color 4 reference algorithm.
    const hue = ((+hsl[1] % 360) + 360) % 360;
    const sat = +hsl[2] / 100;
    const light = +hsl[3] / 100;
    const k = (n) => (n + hue / 30) % 12;
    const amp = sat * Math.min(light, 1 - light);
    const f = (n) =>
      light - amp * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    let a = 1;
    if (hsl[4] !== undefined) a = hsl[5] ? +hsl[4] / 100 : +hsl[4];
    return {
      r: Math.round(f(0) * 255),
      g: Math.round(f(8) * 255),
      b: Math.round(f(4) * 255),
      a,
    };
  }
  return null;
}

/**
 * Parse one filter function's argument: a number or percentage (1 when
 * omitted), or for hue-rotate an angle, returned in radians.
 */
function parseFilterAmount(name, arg) {
  const s = String(arg).trim();
  if (name === "hue-rotate") {
    const m = s.match(/^(-?[\d.]+)(deg|rad|grad|turn)?$/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const unit = (m[2] || "deg").toLowerCase();
    const deg =
      unit === "rad"
        ? (v * 180) / Math.PI
        : unit === "grad"
          ? v * 0.9
          : unit === "turn"
            ? v * 360
            : v;
    return (deg * Math.PI) / 180;
  }
  if (s === "") return 1;
  const v = parseFloat(s);
  if (Number.isNaN(v)) return 1;
  return s.endsWith("%") ? v / 100 : v;
}

/**
 * Run a flat colour through a CSS filter recipe the way the browser does: each
 * function in order, in sRGB, clamped after every step, using the Filter
 * Effects spec matrices. Video-scoped mode uses it to paint surfaces it can't
 * filter with the colour the filter would have produced. Functions that don't
 * change a flat colour (blur, drop-shadow, opacity) are skipped.
 * @param {string} filter CSS filter value, e.g. "invert(1) hue-rotate(180deg)"
 * @param {{r:number,g:number,b:number,a?:number}} rgb 0..255 channels
 * @returns {{r:number,g:number,b:number,a:number}}
 */
function applyFilterToRgb(filter, rgb) {
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  let c = [rgb.r / 255, rgb.g / 255, rgb.b / 255];
  const mul = (m) =>
    [0, 1, 2].map(
      (i) => m[i * 3] * c[0] + m[i * 3 + 1] * c[1] + m[i * 3 + 2] * c[2],
    );

  const re = /([a-z-]+)\(\s*([^)]*)\)/gi;
  let fn;
  while ((fn = re.exec(filter || ""))) {
    const name = fn[1].toLowerCase();
    const amount = parseFilterAmount(name, fn[2]);
    if (name === "invert") {
      const a = clamp01(amount);
      c = c.map((v) => a + v * (1 - 2 * a));
    } else if (name === "brightness") {
      c = c.map((v) => v * amount);
    } else if (name === "contrast") {
      c = c.map((v) => v * amount + 0.5 - 0.5 * amount);
    } else if (name === "grayscale") {
      const a = 1 - clamp01(amount);
      c = mul([
        0.2126 + 0.7874 * a, 0.7152 - 0.7152 * a, 0.0722 - 0.0722 * a,
        0.2126 - 0.2126 * a, 0.7152 + 0.2848 * a, 0.0722 - 0.0722 * a,
        0.2126 - 0.2126 * a, 0.7152 - 0.7152 * a, 0.0722 + 0.9278 * a,
      ]);
    } else if (name === "sepia") {
      const a = 1 - clamp01(amount);
      c = mul([
        0.393 + 0.607 * a, 0.769 - 0.769 * a, 0.189 - 0.189 * a,
        0.349 - 0.349 * a, 0.686 + 0.314 * a, 0.168 - 0.168 * a,
        0.272 - 0.272 * a, 0.534 - 0.534 * a, 0.131 + 0.869 * a,
      ]);
    } else if (name === "saturate") {
      const s = amount;
      c = mul([
        0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s,
        0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s,
      ]);
    } else if (name === "hue-rotate") {
      const cos = Math.cos(amount);
      const sin = Math.sin(amount);
      c = mul([
        0.213 + cos * 0.787 - sin * 0.213,
        0.715 - cos * 0.715 - sin * 0.715,
        0.072 - cos * 0.072 + sin * 0.928,
        0.213 - cos * 0.213 + sin * 0.143,
        0.715 + cos * 0.285 + sin * 0.14,
        0.072 - cos * 0.072 - sin * 0.283,
        0.213 - cos * 0.213 - sin * 0.787,
        0.715 - cos * 0.715 + sin * 0.715,
        0.072 + cos * 0.928 + sin * 0.072,
      ]);
    } else {
      continue;
    }
    c = c.map(clamp01);
  }
  return {
    r: Math.round(c[0] * 255),
    g: Math.round(c[1] * 255),
    b: Math.round(c[2] * 255),
    a: rgb.a === undefined ? 1 : rgb.a,
  };
}

/**
 * CSS string for what `theme.filter` turns an authored colour into. Unparseable
 * input is treated as white (the usual page background).
 */
function themedCssColor(theme, cssColor) {
  const src = parseCssColor(cssColor) || { r: 255, g: 255, b: 255, a: 1 };
  const t = applyFilterToRgb(theme.filter, src);
  return t.a < 1
    ? `rgba(${t.r}, ${t.g}, ${t.b}, ${t.a})`
    : `rgb(${t.r}, ${t.g}, ${t.b})`;
}

/**
 * Is this element's own background a solid, dark color? (Transparent/near-
 * transparent backgrounds inherit the parent and are left alone.)
 */
function hasDarkBackground(el) {
  const bg = ownOpaqueBg(el);
  return !!bg && luminance(bg) < SCALER_DARK_LUMINANCE;
}

/**
 * The element's own background when it is opaque enough to count (a >= 0.5),
 * else null. For a video-path element whose background video-scoped mode has
 * recoloured inline, this reports the ORIGINAL colour, so page-darkness and
 * context decisions never read our own override back.
 */
function ownOpaqueBg(el) {
  const saved = _pathBgOverrides.get(el);
  if (saved) return saved.original;
  if (
    el === document.documentElement &&
    el.classList.contains(SCALER_THEME_SCOPED_CLASS)
  ) {
    // Scoped CSS paints the root with the THEMED bg. Report the pre-image, as
    // root mode's own `background-color: theme.bg` does, so both modes reach
    // the same pageIsDark() verdict and never flip each other off.
    const theme = resolveTheme(_currentThemeId);
    return parseCssColor(theme.bg || "#ffffff");
  }
  try {
    const bg = parseRgb(getComputedStyle(el).backgroundColor);
    return bg && bg.a >= 0.5 ? bg : null;
  } catch (_) {
    return null;
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
  // Root mode scans anywhere; video-scoped mode only ever passes a themed
  // subtree (the rest of the page is unfiltered, so there is nothing to undo).
  const rootClasses = document.documentElement.classList;
  if (
    !rootClasses.contains(SCALER_THEME_ROOT_CLASS) &&
    !rootClasses.contains(SCALER_THEME_SCOPED_CLASS)
  ) {
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
    const bg = ownOpaqueBg(el);
    return bg ? luminance(bg) : null;
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
  return pageBaseLuminance() < SCALER_DARK_LUMINANCE;
}

// Currently-selected theme id (persists across SPA navigation). The rendered
// result is re-decided per page because some Scaler pages are natively dark.
let _currentThemeId = "off";

// What evaluateAndRender last rendered: "off" | "root" | "scoped", and in
// scoped mode the videos it was built around. A change in either forces a full
// re-render; otherwise the observer only patches newly added nodes.
let _renderedMode = "off";
let _scopedVideos = [];

// Video-path elements whose background was recoloured inline:
// element -> { original: {r,g,b,a}, value, priority } (the prior inline value).
const _pathBgOverrides = new Map();

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

// ── Video-scoped mode ──────────────────────────────────────────────────────

/**
 * Lecture-sized videos on the page: the ones the theme must leave untouched.
 * A hidden player measures 0×0 and is ignored.
 */
function findExemptVideos() {
  if (typeof document === "undefined") return [];
  const out = [];
  const videos = document.getElementsByTagName("video");
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    if (
      v.offsetWidth >= SCALER_EXEMPT_VIDEO_MIN_W &&
      v.offsetHeight >= SCALER_EXEMPT_VIDEO_MIN_H
    ) {
      out.push(v);
    }
  }
  return out;
}

function sameVideos(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Layout is unavailable under jsdom (every box measures 0); the size gates in
// classifyOffPath are skipped there, the same convention neutralizeDarkRegions
// follows.
function layoutAvailable() {
  return document.documentElement.clientWidth > 0;
}

/**
 * Left native in video-scoped mode: the media root mode counter-inverts back
 * to native anyway, the extension's own (already dark) spotlight overlay, and
 * non-rendering tags.
 */
function isNativeInScopedMode(el) {
  if (SCALER_NATIVE_TAGS.has(el.localName)) return true;
  if (el.id === "scaler-spotlight-overlay") return true;
  const style = el.getAttribute("style");
  return !!style && style.includes("background-image");
}

/**
 * Recolour a light video-path element's background to what the theme filter
 * would have made it. Path elements can't carry the filter themselves (it
 * would reach the video), so this is the only way their surface gets themed.
 */
function recolorPathBackground(el, original, theme) {
  if (_pathBgOverrides.has(el)) return;
  _pathBgOverrides.set(el, {
    original,
    value: el.style.getPropertyValue("background-color"),
    priority: el.style.getPropertyPriority("background-color"),
  });
  const t = applyFilterToRgb(theme.filter, original);
  el.style.setProperty(
    "background-color",
    `rgba(${t.r}, ${t.g}, ${t.b}, ${original.a})`,
    "important",
  );
  el.setAttribute(SCALER_VIDEO_PATH_ATTR, "");
}

/**
 * Decide how an element OFF the video path is themed, given whether the
 * surface it sits on is dark:
 *  - media / spotlight / background-image  → native (what root mode's
 *    counters produce anyway)
 *  - dark (own bg, or transparent on dark) → native, and its children are
 *    searched for light islands (a white chat panel in the dark player)
 *  - visible wrapper with no area          → descend (portal roots,
 *    display: contents); filtering it would re-anchor its fixed children
 *  - small light chip on a dark surface    → native (part of that chrome)
 *  - anything else                         → a themed subtree
 */
function classifyOffPath(el, onDark, hasLayout) {
  if (isNativeInScopedMode(el) || el.hasAttribute(SCALER_THEMED_ATTR)) return;
  const own = ownOpaqueBg(el);
  const dark = own ? luminance(own) < SCALER_DARK_LUMINANCE : onDark;
  if (dark) {
    Array.from(el.children).forEach((c) => classifyOffPath(c, true, hasLayout));
    return;
  }
  if (hasLayout) {
    let rendered = true;
    try {
      rendered = getComputedStyle(el).display !== "none";
    } catch (_) {
      /* assume rendered */
    }
    if (rendered) {
      // A portal root is usually a full-width block of zero height (its
      // children are position: fixed), so either dimension being 0 counts.
      const { width: w, height: h } = el.getBoundingClientRect();
      if (!w || !h) {
        Array.from(el.children).forEach((c) =>
          classifyOffPath(c, onDark, hasLayout),
        );
        return;
      }
      if (onDark && (w < SCALER_DARK_MIN_W || h < SCALER_DARK_MIN_H)) return;
    }
  }
  el.classList.add(SCALER_THEMED_CLASS);
  el.setAttribute(SCALER_THEMED_ATTR, "");
  neutralizeDarkRegions(el);
}

/**
 * Theme every subtree EXCEPT the given videos and their ancestors. A filter
 * on an ancestor always reaches the video, so instead of filtering the root
 * the filter goes onto each sibling along the path from <body> down to every
 * video (see classifyOffPath for which ones). Light path elements get their
 * background recoloured inline. Callers clear the previous scoped render
 * first (renderThemeMode).
 * @param {HTMLVideoElement[]} videos exempt videos (findExemptVideos)
 */
function scopeAroundVideos(videos) {
  if (!document.body || !videos.length) return;
  const path = new Set();
  videos.forEach((v) => {
    for (let el = v; el && el !== document.documentElement; el = el.parentElement) {
      path.add(el);
    }
  });
  const theme = resolveTheme(_currentThemeId);
  const hasLayout = layoutAvailable();

  const walkPath = (el, onDark) => {
    const own = ownOpaqueBg(el);
    if (own) {
      onDark = luminance(own) < SCALER_DARK_LUMINANCE;
      if (!onDark) recolorPathBackground(el, own, theme);
    }
    Array.from(el.children).forEach((child) => {
      if (path.has(child)) walkPath(child, onDark);
      else classifyOffPath(child, onDark, hasLayout);
    });
  };
  // Scoped mode is only chosen for pages that aren't natively dark.
  walkPath(document.body, false);
}

/**
 * Is the surface under `el` dark? Walks up to the first opaque background.
 */
function sitsOnDark(el) {
  for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
    const bg = ownOpaqueBg(a);
    if (bg) return luminance(bg) < SCALER_DARK_LUMINANCE;
  }
  return false;
}

/**
 * Incremental counterpart of scopeAroundVideos for a node the SPA just added.
 * Inside a themed subtree the usual dark-region scan applies; anywhere else
 * the node is classified against the surface it sits on.
 */
function extendScopedTheme(node) {
  if (node.closest(`.${SCALER_THEMED_CLASS}`)) {
    neutralizeDarkRegions(node);
    return;
  }
  classifyOffPath(node, sitsOnDark(node.parentElement), layoutAvailable());
}

/**
 * Undo a scoped render: drop every themed-subtree flag and restore recoloured
 * path backgrounds to their previous inline value.
 */
function clearScopedTheme() {
  if (typeof document === "undefined") return;
  document.querySelectorAll(`[${SCALER_THEMED_ATTR}]`).forEach((el) => {
    el.classList.remove(SCALER_THEMED_CLASS);
    el.removeAttribute(SCALER_THEMED_ATTR);
  });
  _pathBgOverrides.forEach((saved, el) => {
    if (saved.value) {
      el.style.setProperty("background-color", saved.value, saved.priority);
    } else {
      el.style.removeProperty("background-color");
    }
    el.removeAttribute(SCALER_VIDEO_PATH_ATTR);
  });
  _pathBgOverrides.clear();
}

function toggleRootClass(root, cls, want) {
  const has = root.classList.contains(cls);
  if (want && !has) root.classList.add(cls);
  else if (!want && has) root.classList.remove(cls);
}

/**
 * Decide this page's render mode and reconcile ONLY the root/theme classes
 * (cheap: one pageIsDark() read, a size check per <video>, classList diffs).
 * Diff-based so a stable page never toggles a class (no flashing).
 *  - "off"    theme off, or the page is natively dark → leave it native
 *  - "scoped" a lecture-sized video is on screen → theme around it
 *  - "root"   otherwise → filter the root
 * @returns {{mode: string, videos: HTMLVideoElement[]}}
 */
function reconcileThemeClasses() {
  const root = document.documentElement;
  const theme = resolveTheme(_currentThemeId);
  const isDark = pageIsDark();
  const wantTheme = !!theme.filter && !isDark;
  const videos = wantTheme ? findExemptVideos() : [];
  const mode = !wantTheme ? "off" : videos.length ? "scoped" : "root";
  const wantIdClass = wantTheme ? themeIdClass(theme.id) : null;

  // Learn which paths are natively dark (only meaningful when a theme is on).
  if (theme.filter) recordPageDarkness(isDark);

  toggleRootClass(root, SCALER_THEME_ROOT_CLASS, mode === "root");
  toggleRootClass(root, SCALER_THEME_SCOPED_CLASS, mode === "scoped");

  Object.keys(SCALER_THEMES).forEach((id) => {
    const cls = themeIdClass(id);
    if (cls !== wantIdClass && root.classList.contains(cls)) {
      root.classList.remove(cls);
    }
  });
  if (wantIdClass && !root.classList.contains(wantIdClass)) {
    root.classList.add(wantIdClass);
  }
  return { mode, videos };
}

/**
 * Render a mode from scratch: clear what the previous render left behind,
 * then flag dark regions (root) or build the themed subtrees (scoped).
 */
function renderThemeMode(mode, videos) {
  const wasScoped = _renderedMode === "scoped";
  clearScopedTheme();
  if (mode === "root") {
    // Scoped renders flag dark regions per themed subtree; rescan from scratch
    // so none of those ends up nested inside a root-mode region (that would
    // apply the counter twice and flip it back to light).
    if (wasScoped) clearDarkRegions();
    neutralizeDarkRegions(document.body);
  } else {
    clearDarkRegions();
    if (mode === "scoped") scopeAroundVideos(videos);
  }
  _renderedMode = mode;
  _scopedVideos = videos;
}

/**
 * Full evaluate for THIS page (theme off / native-dark / video / light). Does
 * a one-off full-document pass — used on apply and navigation, NOT on every
 * mutation (the observer handles only added subtrees to stay cheap).
 *  - theme off             → nothing.
 *  - page already dark     → leave it native (no invert, no extras).
 *  - lecture video showing → theme everything around the video.
 *  - light page            → invert + protect any dark widgets on it.
 */
function evaluateAndRender() {
  if (typeof document === "undefined" || !document.documentElement) return;
  const { mode, videos } = reconcileThemeClasses();
  renderThemeMode(mode, videos);
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
 * Flush queued mutations: reconcile classes (cheap) and handle ONLY the newly
 * added subtrees — never the whole document — unless the render mode or the
 * set of exempt videos changed, which needs a full re-render. This keeps cost
 * proportional to what changed, not to page size, so it doesn't churn CPU/
 * memory on a constantly-mutating dashboard.
 */
function flushPendingNodes() {
  if (contextGone()) {
    stopThemeObserver();
    return;
  }
  const { mode, videos } = reconcileThemeClasses();
  const added = Array.from(_pendingNodes).filter((n) => n && n.isConnected);
  _pendingNodes.clear();

  // A re-parented player wrapper keeps the same <video> but changes its path.
  const pathChanged =
    mode === "scoped" &&
    (!sameVideos(videos, _scopedVideos) ||
      added.some((n) => videos.some((v) => n.contains(v))));
  if (mode !== _renderedMode || pathChanged) {
    renderThemeMode(mode, videos);
  } else if (mode === "root") {
    added.forEach((node) => neutralizeDarkRegions(node));
  } else if (mode === "scoped") {
    added.forEach((node) => extendScopedTheme(node));
  }
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
  // A player's <video> can grow to lecture size when its stream's metadata
  // arrives, with no node added. Media events don't bubble, hence capture.
  document.addEventListener("loadedmetadata", scheduleFlush, true);
}

function stopThemeObserver() {
  if (_themeObserver) {
    _themeObserver.disconnect();
    _themeObserver = null;
  }
  if (typeof document !== "undefined") {
    document.removeEventListener("loadedmetadata", scheduleFlush, true);
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
    // Dark is the default: a user who has never picked a theme gets dark. An
    // explicit choice (including "off"/light) is a truthy stored value and wins.
    const theme = result?.cleanerSettings?.theme || "dark";
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
      applyTheme(next.theme || "dark");
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
  window.findExemptVideos = findExemptVideos;
  window.scopeAroundVideos = scopeAroundVideos;
  window.clearScopedTheme = clearScopedTheme;
  window.applyFilterToRgb = applyFilterToRgb;

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
