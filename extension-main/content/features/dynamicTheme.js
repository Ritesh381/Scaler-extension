// ============================================================
// features/dynamicTheme.js
// Dark Reader-style DYNAMIC theming engine for scaler.com.
//
// WHY THIS EXISTS
// ---------------
// The original engine (themeManager.js) recolors the page with a single root
// `filter: invert(1) hue-rotate(180deg)`. That is simple and fast, but a global
// invert flips EVERYTHING — so box-shadows become white glows, dark gradient
// overlays invert, photos need counter-inverting, native form controls look
// wrong, and tinted themes can never perfectly restore images. Those are the
// edge cases we kept patching by hand.
//
// Dark Reader's default "dynamic" mode avoids them at the source: it does NOT
// invert the page. It reads each element's ACTUAL colors and RECOLORS them —
// light backgrounds become dark (hue preserved), dark text becomes light,
// borders/shadows/gradients are recolored, and images are simply left alone
// (no global invert means no counter is needed). This file implements that
// approach.
//
// PHASES (this is a multi-part build; see ROADMAP at the bottom):
//   1. Color core  — parse + HSL convert + recolor math   ← THIS COMMIT
//   2. DOM apply   — recolor live elements + base surfaces
//   3. Observe     — keep up with SPA mutations
//   4. Integrate   — wire into the theme picker; retire the filter for dark
//
// The color core is pure and fully unit-tested; the DOM layer below is the v1
// application and will be tuned against the live site.
// ============================================================

// ─── Color parsing ──────────────────────────────────────────────────────────

const _NAMED_COLORS = {
  transparent: { r: 0, g: 0, b: 0, a: 0 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
};

/**
 * Parse a CSS color string into {r,g,b,a} (0–255, a 0–1), or null if it isn't a
 * plain color we can read (gradients, var(), currentColor, unknown names).
 */
function parseColorToRgb(input) {
  if (!input) return null;
  const str = String(input).trim().toLowerCase();
  if (str in _NAMED_COLORS) return { ..._NAMED_COLORS[str] };

  // #rgb / #rgba / #rrggbb / #rrggbbaa
  if (str[0] === "#") {
    let hex = str.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].every((n) => !Number.isNaN(n))) return { r, g, b, a };
    }
    return null;
  }

  // rgb()/rgba() — also tolerates the space/slash CSS Color 4 syntax.
  const m = str.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)/i,
  );
  if (m) {
    let a = 1;
    if (m[4] !== undefined) {
      a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    }
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  return null;
}

/** Is this color effectively invisible (fully/near transparent)? */
function isTransparent(rgb) {
  return !rgb || rgb.a < 0.1;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function rgbToCss({ r, g, b, a }) {
  const R = Math.round(clamp(r, 0, 255));
  const G = Math.round(clamp(g, 0, 255));
  const B = Math.round(clamp(b, 0, 255));
  return a === undefined || a >= 1
    ? `rgb(${R}, ${G}, ${B})`
    : `rgba(${R}, ${G}, ${B}, ${Math.round(clamp(a, 0, 1) * 1000) / 1000})`;
}

// ─── RGB ⇄ HSL ────────────────────────────────────────────────────────────

/** {r,g,b} 0–255 → {h 0–360, s 0–1, l 0–1} (alpha passed through). */
function rgbToHsl({ r, g, b, a }) {
  const R = r / 255,
    G = g / 255,
    B = b / 255;
  const max = Math.max(R, G, B),
    min = Math.min(R, G, B);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case R:
        h = (G - B) / d + (G < B ? 6 : 0);
        break;
      case G:
        h = (B - R) / d + 2;
        break;
      default:
        h = (R - G) / d + 4;
    }
    h *= 60;
  }
  return { h, s, l, a: a === undefined ? 1 : a };
}

/** {h 0–360, s 0–1, l 0–1} → {r,g,b} 0–255 (alpha passed through). */
function hslToRgb({ h, s, l, a }) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
    a: a === undefined ? 1 : a,
  };
}

// ─── Recolor math (the Dark Reader-style transforms) ──────────────────────────
//
// All transforms keep HUE (so a blue button stays blue) and operate on LIGHTNESS
// so the page becomes dark without losing color identity. Already-dark inputs are
// largely left alone (so a natively-dark widget isn't bleached). Saturation is
// gently reduced so recolored surfaces aren't garish on a dark page.

/**
 * Background surfaces: light → dark (hue kept). Very light surfaces (incl.
 * pastels) collapse into a near-black band; mid-light colored elements (buttons,
 * badges) are only modestly darkened so they stay recognizable; already-dark
 * backgrounds are kept (clamped so they never read as a light panel).
 */
function modifyBackgroundColor(rgb) {
  if (isTransparent(rgb)) return null; // leave transparent as-is
  const { h, s, l, a } = rgbToHsl(rgb);
  let L, S;
  if (l <= 0.5) {
    L = Math.min(l, 0.4); // already dark — keep, but never a light panel
    S = s;
  } else if (l > 0.75) {
    L = (1 - l) * 0.22 + 0.09; // light surface → 0.09–0.15 dark band
    S = s * 0.5; // mute so tinted surfaces aren't loud
  } else {
    L = l * 0.6; // mid colored element → modest darken, stays colored
    S = s * 0.9;
  }
  return rgbToCss(hslToRgb({ h, s: S, l: L, a }));
}

/**
 * Foreground (text/icons): dark → light (hue kept), light text left light.
 * Clamped to a comfortable, not-pure-white range for readability.
 */
function modifyForegroundColor(rgb) {
  if (isTransparent(rgb)) return null;
  const { h, s, l, a } = rgbToHsl(rgb);
  const L = l >= 0.5 ? Math.max(l, 0.6) : clamp(1 - l * 0.5, 0.62, 0.92);
  return rgbToCss(hslToRgb({ h, s: s * 0.9, l: L, a }));
}

/** Borders: pushed into a subtle, low-saturation mid-dark range. */
function modifyBorderColor(rgb) {
  if (isTransparent(rgb)) return null;
  const { h, s, l, a } = rgbToHsl(rgb);
  const L =
    l > 0.5 ? clamp((1 - l) * 0.5 + 0.18, 0.18, 0.4) : clamp(l * 0.6 + 0.12, 0.12, 0.4);
  return rgbToCss(hslToRgb({ h, s: s * 0.5, l: L, a }));
}

/**
 * Recolor every color token inside a box-shadow / text-shadow value. On a dark
 * page a shadow should READ as a shadow — i.e. stay dark — so each color is
 * forced toward black while preserving its alpha. (This is why dynamic mode has
 * no white-glow problem: the shadow color is rewritten, not inverted.)
 */
function modifyShadow(shadowValue) {
  if (!shadowValue || shadowValue === "none") return null;
  return shadowValue.replace(
    /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi,
    (token) => {
      const rgb = parseColorToRgb(token);
      if (!rgb) return token;
      return rgbToCss({ r: 0, g: 0, b: 0, a: rgb.a });
    },
  );
}

/**
 * Recolor the color stops inside a CSS gradient (linear/radial/conic). Stops are
 * treated as background surfaces (modifyBackgroundColor) so a light→dark fade
 * becomes a dark fade instead of inverting to a light one. Non-gradient
 * background-image values (url(...)) are returned unchanged (images stay
 * natural — the whole point of not inverting).
 */
function modifyGradient(backgroundImage) {
  if (!backgroundImage || !/gradient\(/i.test(backgroundImage)) return null;
  return backgroundImage.replace(
    /rgba?\([^)]*\)|#[0-9a-f]{3,8}\b/gi,
    (token) => {
      const rgb = parseColorToRgb(token);
      if (!rgb) return token;
      if (isTransparent(rgb)) return token; // keep transparent stops
      return modifyBackgroundColor(rgb) || token;
    },
  );
}

// ─── Exposure (browser global + test harness) ────────────────────────────────
if (typeof window !== "undefined") {
  window.ScalerDynamicTheme = {
    // color core (phase 1)
    parseColorToRgb,
    rgbToHsl,
    hslToRgb,
    rgbToCss,
    modifyBackgroundColor,
    modifyForegroundColor,
    modifyBorderColor,
    modifyShadow,
    modifyGradient,
    isTransparent,
  };
}

// Also expose for CommonJS-style test requires if ever loaded that way.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseColorToRgb,
    rgbToHsl,
    hslToRgb,
    rgbToCss,
    modifyBackgroundColor,
    modifyForegroundColor,
    modifyBorderColor,
    modifyShadow,
    modifyGradient,
    isTransparent,
  };
}

// ============================================================================
// ROADMAP — remaining phases to reach Dark Reader-style parity
// ----------------------------------------------------------------------------
// Phase 2 — DOM application:
//   • Set base surfaces on <html>/<body>: dark bg, light text, `color-scheme:
//     dark` (so native form controls, scrollbars, and date pickers render dark
//     with zero extra work).
//   • Walk elements and write inline overrides ONLY where needed: non-transparent
//     computed backgroundColor → modifyBackgroundColor; dark computed color →
//     modifyForegroundColor; visible border → modifyBorderColor; box-shadow →
//     modifyShadow; gradient background-image → modifyGradient. Images are left
//     untouched. Tag processed nodes to avoid rework.
//   • NOTE on cross-origin CSS: Scaler serves most CSS from assets-v2.scaler.com
//     (cross-origin to www.scaler.com), so `sheet.cssRules` throws and stylesheet
//     parsing alone misses it. The computed-style walk above is origin-agnostic
//     and is therefore the v1 strategy. (Dark Reader re-fetches cross-origin CSS
//     via its background worker — a later optimization if the walk is too heavy.)
// Phase 3 — observe: a debounced MutationObserver re-recolors added subtrees and
//   reacts to inline-style/class changes; teardown on theme-off / pagehide.
// Phase 4 — integrate: add `engine: "dynamic"` to themes; route the Dark theme
//   through this engine (no root filter, no media counters, no dark-region scan,
//   no inversion-fix CSS — all obsolete under dynamic mode). Keep the filter
//   engine available as a fallback while this is tuned on the live site.
// ============================================================================
