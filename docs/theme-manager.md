# Themes / Dark Mode

**Setting key:** `theme` — one of `off | dark | midnight | dracula | nord | sepia | solarized`
(default `dark`)
**Code:** [content/features/themeManager.js](../extension-main/content/features/themeManager.js)
(engine), [content/core/themePreload.js](../extension-main/content/core/themePreload.js)
(anti-FOUC shim), [content/features/dynamicTheme.js](../extension-main/content/features/dynamicTheme.js)
(unshipped experiment — see the last section)
**Assets:** `fonts/figtree.woff2` (bundled, listed in `web_accessible_resources`)

## The core idea

Scaler is a large, frequently-changing SPA. Re-skinning it selector-by-selector would break on
every dashboard tweak. Instead the engine recolours the **whole page with one CSS `filter` on the
root `<html>` element** and counter-inverts the things that must keep their real colours.

Filtering the *root* element specifically is deliberate: per spec, a filter on the root applies to
the viewport and does **not** establish a containing block for `position: fixed` descendants. So
Scaler's sticky header, its modals and the extension's own overlays keep working — which is what
makes this approach viable on a live third-party site.

Each theme is just a different filter recipe:

| id | filter | extras |
|---|---|---|
| `off` | `null` (native site) | — |
| `dark` | `invert(1) hue-rotate(180deg)` | — |
| `midnight` | `invert(0.9) sepia(0.14) hue-rotate(185deg) brightness(0.92) saturate(1.05)` | Figtree font, rounded corners, blue accent, custom `bg` |
| `dracula` | `invert(0.9) hue-rotate(200deg) saturate(1.15) contrast(0.95)` | — |
| `nord` | `invert(0.9) hue-rotate(165deg) saturate(0.8) brightness(0.98)` | — |
| `sepia` | `invert(0.9) hue-rotate(180deg) sepia(0.35) contrast(0.95)` | — |
| `solarized` | `invert(0.88) hue-rotate(180deg) sepia(0.45) saturate(1.25)` | — |

## Self-inverse maths

`invert(1) hue-rotate(180deg)` applied twice is the identity — it is **self-inverse**. That is why
plain **Dark** can restore media to its *exact* original colours: the same recipe used as a
counter cancels the root filter perfectly. Tinted recipes layer sepia/partial invert, which has no
exact CSS inverse, so their media counters are close but not pristine. The code tracks this
explicitly via `SCALER_SELF_INVERSE` and the `isSelfInverse` check in `buildThemeCss`.

Three counters exist:

- **Media counter** (`img, video, canvas, iframe, embed, object, svg image, [style*=background-image]`)
  = `SCALER_SELF_INVERSE`, so photos aren't inverted.
- **Region counter** = `SCALER_SELF_INVERSE brightness(1.1)`. A natively-dark panel is un-inverted
  *and* darkened slightly, so its native dark-grey blends into the inverted near-black page rather
  than standing out as a lighter box.
- **Media-inside-a-region** — the region already un-inverted the image but also applied its
  brightness bump, leaving it ~10 % bright. On a self-inverse theme this cancels exactly with
  `P · brightness(1/1.1) · P` (the two inversions telescope, the brightness factors multiply to 1).
  Tinted themes fall back to `none`.

## What must stay dark

Two independent mechanisms flag "don't invert this":

1. **Static, by class — Monaco editors.**
   `SCALER_DARK_EDITOR_SELECTOR = .monaco-editor.vs-dark, .hc-black, .hc-dark`.
   Monaco carries an unambiguous theme class, so a dark editor is countered the instant Monaco
   themes it. The bare `.monaco-editor` is deliberately **not** matched: a light (`vs`) editor is
   white and *should* invert to dark like the rest of the page.
   A pure runtime scan can't handle Monaco — its background arrives from a generated stylesheet
   slightly after mount, and a light→dark theme switch mutates only classes (no nodes added), so a
   `childList` observer never re-scans it. That combination used to turn dark editors white.
2. **Runtime luminance scan — `neutralizeDarkRegions(scope)`.**
   Scans a curated candidate set (`div, section, header, …, pre, code, .cm-editor, .CodeMirror,
   .ace_editor`) and flags an element with `.scaler-no-invert` + `data-scaler-dark-region` when:
   - its own `background-color` is opaque (`a >= 0.5`) and `luminance < 0.22`
     (`0.2126R + 0.7152G + 0.0722B` over 255),
   - it is at least 48 × 28 px (skip icons and slivers),
   - it is not inside a dark Monaco editor (the static rule owns those; a second counter would
     double-flip), and not the spotlight overlay or its subtree.

   The scan runs in **two phases** — read-only measurement first, then class mutation — to avoid
   layout thrash. Because `querySelectorAll` returns document order, only the **outermost** dark
   region in a subtree gets flagged (`el.parentElement.closest('.scaler-no-invert')` skips
   nested ones).

`.scaler-keep-invert` is a double-negative escape hatch for media that *should* be inverted.

There is also a hand-written fix for `.past-events__info::after`, a dark gradient scrim that the
root invert turns into a white glow — it is re-authored as a **pre-inverted** white gradient so it
renders black after inversion.

The card text that sits **on** that scrim (`.past-events__headline`, `.past-events__desc`,
`.past-events__close-button`) is authored white, so the root invert paints it black — onto a scrim
we just forced to stay dark. It is pre-inverted the same way (`color: #000` renders white), and the
two fixes have to move together: keeping the scrim dark is only correct while its text stays light.

Finally, the Scaler wordmark (`img[src*="sst-logo"]`, mounted in the page header and the slide-out
sidebar) opts **out** of the media un-invert with `filter: none`. It is dark ink on a transparent
canvas, so un-inverting it — correct for a photo — puts it back to dark-on-dark. The opt-out is
scoped to that one asset on purpose: a general "small images should invert" rule would also flip
genuinely dark artwork, which the media rule exists to protect.

## Per-page decision

Some Scaler pages (the live classroom) are already dark. Inverting those is wrong.

- `pageBaseLuminance()` samples `body`, then `documentElement`, then the largest top-level child
  with an opaque background; `pageIsDark()` is `< 0.22`.
- `reconcileThemeClasses()` (cheap: one luminance read, a size check per `<video>`, classList
  diffs) decides the mode — `off`, `root`, or `scoped` when a lecture-sized video is on screen
  (see [Video-scoped mode](#video-scoped-mode-lecture-recordings)) — and adds/removes
  `scaler-theme-active` / `scaler-theme-scoped` plus the theme-specific class
  `scaler-theme-{id}`. Diff-based, so a stable page never toggles a class and never flashes.
- `evaluateAndRender()` = reconcile + `renderThemeMode()` (a one-off full-document region scan
  in root mode, `scopeAroundVideos()` in scoped mode, `clearDarkRegions()` when off) +
  `removePreloadStyle()`.

The stylesheet itself (`#scaler-theme-styles`) is written **once per theme** and is page-agnostic;
the root classes gate whether it applies.

## Video-scoped mode (lecture recordings)

### Why the counter-filter isn't enough for video

`invert(1) hue-rotate(180deg)` is self-inverse only on paper. `hue-rotate` produces
out-of-gamut values that are clamped after every step, so a saturated colour does not survive
the round trip. Worse, some colours cannot be produced through the root filter **at all**:
for `P(x) = (1, 0, 0)` the pre-image `x` would have to be `(1.574, 0.574, 0.574)`, which is
outside `[0, 1]`. No counter-filter on the `<video>`, however exact, can paint pure red under
a root `invert hue-rotate`.

Measured in Chromium on a fixture of the lecture page (Dark theme, colour bars as the video
frame):

| Colour | Root filter + counters | Video-scoped mode |
|---|---|---|
| red `(255, 0, 0)` | `(172, 63, 63)` | `(255, 0, 0)` |
| blue `(0, 0, 255)` | `(32, 32, 68)` | `(0, 0, 255)` |
| cyan `(0, 255, 255)` | `(84, 192, 192)` | `(0, 255, 255)` |

CSS has no way for an element to opt out of an ancestor's `filter`, so the only fix is to keep
the filter off every ancestor of the video.

### How it works

`reconcileThemeClasses()` picks one of three modes per page:

| Mode | When | Root class |
|---|---|---|
| `off` | theme off, or the page is natively dark | — |
| `scoped` | a `<video>` of at least 320 × 180 px is on screen (`findExemptVideos`) | `scaler-theme-scoped` |
| `root` | otherwise | `scaler-theme-active` |

In scoped mode `scopeAroundVideos(videos)` collects every ancestor of every exempt video (the
*path*) and walks down from `<body>`:

- **Path element** — never filtered. If its own background is opaque and light, it is
  recoloured inline to what the filter would have produced (`applyFilterToRgb`, which matches
  Chromium's output exactly, measured for every theme) and tagged `data-scaler-video-path` so
  teardown can restore the previous inline value.
- **Off-path element** — `classifyOffPath()`:
  - media (`img`, `video`, `canvas`, `iframe`, …), inline `background-image`, and the
    extension's spotlight overlay stay native — what root mode's counters produce anyway;
  - a dark element (own dark background, or transparent on a dark surface) stays native and
    its children are searched for *light islands* — this is how the white chat or playlist
    panel inside the dark player overlay gets themed;
  - a visible wrapper with zero width or height (a portal root whose children are
    `position: fixed`) is descended into rather than filtered;
  - a light chip smaller than 48 × 28 px on a dark surface is left native (it is part of that
    chrome's design);
  - anything else is flagged `.scaler-themed` + `data-scaler-themed` and gets the theme
    filter. `neutralizeDarkRegions()` then runs inside it, so dark buttons in a themed panel
    keep their counter exactly as in root mode.

The CSS for both modes comes from one helper, `buildFilteredScopeCss(theme, scope)`, emitted
once with `html.scaler-theme-active` and once with `html.scaler-theme-scoped .scaler-themed`,
so the media / region / component-fix rules can't drift apart. Root-mode output is unchanged
and emitted first. In scoped mode `<html>` is painted with the themed version of `theme.bg`;
the Midnight accent (a pre-image) is gated to root mode only.

### Keeping it current

- The existing body observer and rAF flush are reused. A flush re-renders from scratch only
  when the mode or the set of exempt videos changes, or when an added node contains an exempt
  video (a re-parented player). Otherwise added nodes are handled incrementally
  (`extendScopedTheme`): inside a themed subtree they get the dark-region scan; elsewhere
  they are classified against the surface they sit on (`sitsOnDark`).
- A capture-phase `loadedmetadata` listener on `document` schedules a flush, because a
  player's `<video>` can reach lecture size when its stream loads, with no node added. It is
  removed in `stopThemeObserver()`.
- `ownOpaqueBg()` reports the *original* colour of recoloured path elements, and theme.bg for
  `<html>` in scoped mode, so `pageIsDark()` never reads our own paint back and flips the page
  to `off`.
- Leaving scoped mode (`clearScopedTheme`) removes every flag and restores inline
  backgrounds; switching to root mode also clears dark-region flags first so none ends up
  nested inside a root-mode region.

### Limits

- A `position: fixed` element *inside* a themed panel is positioned relative to that panel,
  and `z-index` inside it can't escape it — a filter establishes a containing block and a
  stacking context. Zero-size portal roots are handled; a fixed popup inside a sized panel is
  not.
- Path elements' own borders, shadows and direct text nodes are not themed (only their
  background is recoloured).
- Natively-dark chrome renders in its exact native colours rather than root mode's slightly
  darkened ones (no `brightness(1.1)` region bump).

## Anti-FOUC preload

`themePreload.js` runs at `document_start`, before first paint, and reads the theme from the
**page's `localStorage`** (not `chrome.storage`, which is async and would be too late):

| key | contents |
|---|---|
| `scalerpp_theme` | theme id |
| `scalerpp_theme_filter` | the filter string |
| `scalerpp_theme_bg` | root background |
| `scalerpp_dark_paths` | JSON array of pathnames known to be natively dark (max 50, LRU-trimmed) |

Both the filter and the bg are regex-sanitised (`/^[a-zA-Z0-9().,%\s/-]+$/`) before being written
into CSS, so a hostile localStorage value can't break out of the declaration. If the current
pathname is in `scalerpp_dark_paths`, the preload skips entirely — no flash on a natively-dark
page.

The preload counters only **real media**, not editors: a light-theme editor is white and would be
left white. The main script's luminance check decides per editor once it loads, and then
`removePreloadStyle()` deletes the shim, because its ungated `html { filter }` would otherwise
keep inverting a natively-dark page.

`mirrorThemeToStorage()` and `recordPageDarkness()` keep those four keys current.

## Keeping up with the SPA

- `startThemeObserver()` — one `MutationObserver` on `document.body` collecting **added element
  nodes** into `_pendingNodes`.
- `scheduleFlush()` uses **`requestAnimationFrame`**, not a timer, so newly added dark regions are
  flagged *before* the browser paints them — a dark drawer never flashes white-then-black.
- `flushPendingNodes()` reconciles classes and scans **only the added subtrees**, keeping cost
  proportional to what changed rather than to page size. It calls `contextGone()` each flush and
  tears the observer down if the extension was reloaded.
- `stopThemeObserver()` disconnects, cancels the pending rAF and clears the node set; it is also
  wired to `pagehide` with `{ once: true }`.

## Entry points

- `initThemeManager()` reads `cleanerSettings.theme` **straight from `chrome.storage.sync`**
  (storage is the single source of truth, so it doesn't depend on `settings.js` load order) and
  defaults to `dark` when nothing was ever chosen.
- `watchThemeChanges()` listens to `chrome.storage.onChanged` for `cleanerSettings`, so a theme
  change from the popup applies instantly even if the tab message is missed.
- The module self-initialises at the bottom of the file (`if (document.documentElement)`) rather
  than waiting for `content.js`'s `load` handler, which may fire later.
- `content.js` also calls `applyTheme(value)` on the `theme` toggle message.
- Everything is exposed on `window` (`applyTheme`, `neutralizeDarkRegions`, `pageIsDark`, …) for
  the jsdom tests (`tests/themeManager.test.js`, `tests/themePreload.test.js`).

## Theme extras (midnight only, today)

Layered as real CSS on top of the filter, scoped to `html.scaler-theme-midnight`:

- **`buildFontCss`** — bundled Figtree via `@font-face`, applied by **inheritance on `html, body`
  only**. Never `* !important`: icon fonts (Material, FontAwesome, Scaler's `cr-icon`) set
  `font-family` directly on the element, and a directly-set value beats an inherited one. The old
  universal rule clobbered them and turned icons into garbled text.
- **`buildRoundedCss`** — rounded corners via case-insensitive attribute matching
  (`[class*="btn" i]`, `[class*="card" i]`, …) so it adapts to Scaler's class names.
- **`buildAccentCss`** — accent applied only to unambiguous surfaces (`accent-color`,
  `::selection`, scrollbar thumb, `:focus-visible`), never a blanket `a { color }` which would
  turn card titles blue. The `accent` value is a *pre-image*: a dark blue that the root filter
  flips into midnight's light blue.

`@media print` disables the filter so exports print in native colours.

## `dynamicTheme.js` — not shipped

A Dark-Reader-style **dynamic** engine that parses each element's real colours and recolours them
(instead of inverting), which would remove the whole class of invert artefacts: white box-shadow
glows, inverted gradient scrims, media counters, form-control weirdness. Its colour core is pure
and unit-tested (`tests/dynamicTheme.test.js`), but the file is **not listed in `manifest.json`**
and nothing references it — it is an in-progress replacement, not live code. Do not assume it runs.
