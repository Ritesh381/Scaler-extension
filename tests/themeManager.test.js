const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome } = require("./helpers/harness");

const THEME_FILE = "content/features/themeManager.js";
const ROOT_CLASS = "scaler-theme-active";
const STYLE_ID = "scaler-theme-styles";

test("exposes the theme engine API and a catalogue including 'off' + 'dark'", () => {
  const { window } = loadFeature(THEME_FILE);
  assert.equal(typeof window.applyTheme, "function");
  assert.equal(typeof window.initThemeManager, "function");
  assert.ok(window.SCALER_THEMES, "SCALER_THEMES catalogue present");
  assert.ok("off" in window.SCALER_THEMES, "has an off entry");
  assert.ok("dark" in window.SCALER_THEMES, "has a dark entry");
  // off must have no filter (native look); dark must have one.
  assert.equal(window.SCALER_THEMES.off.filter, null);
  assert.ok(window.SCALER_THEMES.dark.filter.includes("invert"));
});

test("applyTheme('dark') activates the root class and injects filter CSS", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "root class added");

  const style = window.document.getElementById(STYLE_ID);
  assert.ok(style, "stylesheet injected");
  assert.match(style.textContent, /filter:\s*invert\(1\)/, "root filter present");
  // Media must be counter-inverted so photos/videos stay natural.
  assert.match(style.textContent, /img,/, "media counter rule present");
});

test("applyTheme('off') tears the theme down cleanly", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  window.applyTheme("off");

  const root = window.document.documentElement;
  assert.ok(!root.classList.contains(ROOT_CLASS), "root class removed");
  const style = window.document.getElementById(STYLE_ID);
  // Node may remain but must be emptied.
  assert.equal(style ? style.textContent.trim() : "", "");
});

test("unknown theme ids fall back to 'off' (no theming applied)", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("not-a-real-theme");
  const root = window.document.documentElement;
  assert.ok(!root.classList.contains(ROOT_CLASS), "no class for bogus id");
});

test("switching themes replaces the recipe rather than stacking it", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  window.applyTheme("dracula");

  const style = window.document.getElementById(STYLE_ID);
  // Count only the real root filter rule (the @media print rule uses
  // `filter: none`, so it isn't matched here).
  const occurrences = (
    style.textContent.match(/scaler-theme-active \{\s*filter:\s*invert/g) || []
  ).length;
  assert.equal(occurrences, 1, "exactly one root filter rule after switching");
  assert.match(style.textContent, /hue-rotate\(200deg\)/, "dracula recipe applied");
});

test("midnight ports the Figtree font and rounded corners", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("midnight");

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "root themed");
  assert.ok(root.classList.contains("scaler-theme-midnight"), "id class added");

  const css = window.document.getElementById(STYLE_ID).textContent;
  assert.match(css, /@font-face/, "@font-face injected");
  assert.match(css, /Figtree/, "Figtree font referenced");
  assert.match(css, /figtree\.woff2/, "bundled woff2 referenced");
  assert.match(css, /font-family:[^;]*Figtree/, "global font-family override");
  // Icon-safety: the font must NOT be forced on every element (`scope *`),
  // which would clobber icon fonts and turn icons into garbled text.
  assert.ok(
    !/scaler-theme-midnight\s*\*/.test(css),
    "font applied via inheritance, not a universal * override (icon-safe)",
  );
  assert.match(css, /border-radius:\s*var\(--scaler-r-/, "rounded corners applied");
  // Blue accent (pre-image color) on scrollbar/selection/links.
  assert.match(css, /::-webkit-scrollbar-thumb\s*\{\s*background:/, "accent scrollbar");
  assert.match(css, /::selection\s*\{\s*background:/, "accent selection");
  assert.match(css, /accent-color:/, "native accent-color set");
});

test("font/rounding extras don't leak to other themes", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("midnight");
  window.applyTheme("dark");

  const root = window.document.documentElement;
  assert.ok(!root.classList.contains("scaler-theme-midnight"), "midnight class dropped");
  assert.ok(root.classList.contains("scaler-theme-dark"), "dark id class set");
  const css = window.document.getElementById(STYLE_ID).textContent;
  assert.ok(!/@font-face/.test(css), "no font-face for plain dark");
  assert.ok(!/border-radius:\s*var\(--scaler-r-/.test(css), "no rounding for plain dark");
});

test("natively-dark widgets are flagged so the invert doesn't whiten them", () => {
  const html = `<!DOCTYPE html><html><body>
    <div class="monaco-editor" style="background-color: rgb(20, 22, 28)">code</div>
    <pre style="background-color: rgb(255, 255, 255)">light snippet</pre>
  </body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  window.applyTheme("dark");
  window.neutralizeDarkRegions(window.document.body);

  const editor = window.document.querySelector(".monaco-editor");
  const lightPre = window.document.querySelector("pre");
  assert.ok(
    editor.hasAttribute("data-scaler-dark-region"),
    "dark editor flagged for counter-invert",
  );
  assert.ok(
    !lightPre.hasAttribute("data-scaler-dark-region"),
    "light element left alone",
  );
});

test("a dark-theme Monaco editor is counter-inverted by CLASS (no scan needed)", () => {
  // Regression: a vs-dark editor used to render WHITE because the runtime
  // luminance scan misses it (Monaco paints its #1e1e1e background AFTER the
  // element mounts, and a light→dark theme swap mutates only classes — the
  // childList observer never re-scans). The static .vs-dark counter rule must
  // keep it dark regardless of whether neutralizeDarkRegions ever ran.
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const css = window.document.getElementById(STYLE_ID).textContent;

  // Dark variants are counter-inverted (un-inverted + darkened) by class.
  assert.match(
    css,
    /\.monaco-editor\.vs-dark[\s\S]*?filter:\s*invert\(1\)\s*hue-rotate\(180deg\)\s*brightness/,
    "vs-dark editor counter-inverted statically",
  );
  assert.match(css, /\.monaco-editor\.hc-black/, "hc-black variant covered");
  assert.match(css, /\.monaco-editor\.hc-dark/, "hc-dark variant covered");

  // The BARE .monaco-editor must NOT be countered — a LIGHT (vs) editor is
  // white and must invert to dark like the rest of the page (bfb9b69 fix).
  const withoutDarkVariants = css.replace(
    /\.monaco-editor\.(vs-dark|hc-black|hc-dark)/g,
    "",
  );
  assert.ok(
    !/(^|[,\s])\.monaco-editor(?![.\w-])/.test(withoutDarkVariants),
    "bare .monaco-editor is never statically countered (light editors still invert)",
  );

  // Media inside a dark editor must be un-inverted so it isn't double-flipped.
  assert.match(
    css,
    /\.monaco-editor\.vs-dark img/,
    "media inside a dark editor is exempted from re-inversion",
  );
});

test("Dark theme keeps img tags at their exact original colors (incl. in dark panels)", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const css = window.document.getElementById(STYLE_ID).textContent;
  const root = window.SCALER_THEMES.dark.filter; // invert(1) hue-rotate(180deg)

  // Top-level media counter must be the EXACT inverse of the root filter, so a
  // counter-inverted image returns to its true colors (self-inverse recipe).
  const topImg = css.match(/Real media[\s\S]*?\{\s*filter:\s*([^;]+?)\s*!important;/);
  assert.ok(topImg, "real-media rule present");
  assert.equal(topImg[1].trim(), root, "top-level img counter == exact inverse of root");

  // Media INSIDE a dark region must cancel the region's brightness bump too, so
  // images in dark panels/editors are pristine (not ~10% brighter). The filter
  // P·brightness(1/1.1)·P telescopes to identity through root+region inversions.
  const inRegion = css.match(/normal orientation[\s\S]*?\{\s*filter:\s*([^;]+?)\s*!important;/);
  assert.ok(inRegion, "in-region media rule present");
  assert.match(
    inRegion[1],
    /invert\(1\) hue-rotate\(180deg\) brightness\(0\.9091\) invert\(1\) hue-rotate\(180deg\)/,
    "in-region media cancels the region brightness exactly on the Dark theme",
  );
});

test("tinted themes leave in-region media untouched (no regression)", () => {
  // Tinted recipes have no exact CSS inverse, so the brightness-cancel must NOT
  // be applied — they keep the previous filter:none, unchanged behavior.
  for (const id of ["midnight", "sepia", "dracula", "nord", "solarized"]) {
    const { window } = loadFeature(THEME_FILE);
    window.applyTheme(id);
    const css = window.document.getElementById(STYLE_ID).textContent;
    const inRegion = css.match(/normal orientation[\s\S]*?\{\s*filter:\s*([^;]+?)\s*!important;/);
    assert.ok(inRegion, `${id}: in-region media rule present`);
    assert.equal(inRegion[1].trim(), "none", `${id}: in-region media stays filter:none`);
  }
});

test("spotlight overlay is counter-inverted AND its backdrop-filter is killed in dark mode", () => {
  // Regression: backdrop-filter:blur on the overlay samples the PRE-invert
  // (light) page through the root filter and washes the overlay out to light.
  // The theme must un-invert the overlay (so it stays dark-as-designed) and drop
  // its backdrop-filter (which can't compose with the root <html> filter).
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const css = window.document.getElementById(STYLE_ID).textContent;
  const rule = css.match(/#scaler-spotlight-overlay\s*\{[^}]*\}/);
  assert.ok(rule, "spotlight overlay rule present");
  assert.match(rule[0], /filter:\s*invert\(1\) hue-rotate\(180deg\)\s*!important/, "overlay counter-inverted");
  assert.match(rule[0], /backdrop-filter:\s*none\s*!important/, "backdrop-filter killed");
  assert.match(rule[0], /-webkit-backdrop-filter:\s*none\s*!important/, "-webkit-backdrop-filter killed");
});

test("session-card ::after scrim is pre-inverted so it stays a dark shadow (all dark themes)", () => {
  // Regression: .past-events__info::after is a dark bottom-fade scrim; the root
  // invert flipped it to a white glow. The theme must re-author it with a
  // PRE-INVERTED (white→black) gradient so it renders dark in every dark theme.
  for (const id of ["dark", "midnight", "sepia", "dracula", "nord", "solarized"]) {
    const { window } = loadFeature(THEME_FILE);
    window.applyTheme(id);
    const css = window.document.getElementById(STYLE_ID).textContent;
    const rule = css.match(/\.past-events__info::after\s*\{[^}]*\}/);
    assert.ok(rule, `${id}: past-events scrim rule present`);
    // White stops → render black after the invert; must NOT contain rgba(0,0,0…)
    // (that would invert to a white glow — the bug).
    assert.match(rule[0], /rgba\(255,\s*255,\s*255/, `${id}: scrim uses pre-inverted white stops`);
    assert.ok(!/rgba\(\s*0,\s*0,\s*0/.test(rule[0]), `${id}: scrim has no raw black stops`);
  }
});

test("session-card text on the scrim is pre-inverted so it stays light (all dark themes)", () => {
  // Regression (issue #31): .past-events__headline / __desc / __close-button are
  // authored WHITE, so the root invert paints them black — on top of the scrim
  // that the rule above deliberately keeps dark, leaving black-on-dark. They must
  // be re-authored pre-inverted (black → renders white) in every dark theme.
  for (const id of ["dark", "midnight", "sepia", "dracula", "nord", "solarized"]) {
    const { window } = loadFeature(THEME_FILE);
    window.applyTheme(id);
    const css = window.document.getElementById(STYLE_ID).textContent;
    const rule = css.match(
      /\.past-events__headline[^{]*\{[^}]*\}/,
    );
    assert.ok(rule, `${id}: past-events text rule present`);
    for (const sel of ["__headline", "__desc", "__close-button"]) {
      assert.ok(
        css.includes(`.past-events${sel}`),
        `${id}: .past-events${sel} is covered`,
      );
    }
    // Black here renders WHITE after the root invert. A raw #fff would render
    // black — the bug this guards against.
    assert.match(rule[0], /color:\s*#000000\s*!important/, `${id}: text pre-inverted to black`);
    assert.ok(!/color:\s*#fff/i.test(rule[0]), `${id}: text is not authored white`);
  }
});

test("the Scaler wordmark opts OUT of the media un-invert so it stays legible", () => {
  // Regression (issue #31): the logo is dark ink on a transparent canvas. The
  // generic `img` counter-invert (which exists to keep photos true-coloured) put
  // it back to dark-on-dark. It must be excluded so it rides the root invert.
  for (const id of ["dark", "midnight", "sepia", "dracula", "nord", "solarized"]) {
    const { window } = loadFeature(THEME_FILE);
    window.applyTheme(id);
    const css = window.document.getElementById(STYLE_ID).textContent;
    const rule = css.match(/html\.[\w-]+ img\[src\*="sst-logo"\][^{]*\{[^}]*\}/);
    assert.ok(rule, `${id}: logo opt-out rule present`);
    assert.match(rule[0], /filter:\s*none\s*!important/, `${id}: logo is not counter-inverted`);
    // Both mount points: page header and the slide-out sidebar.
    assert.ok(rule[0].includes('img[alt="sst_logo"]'), `${id}: header logo covered`);
    assert.ok(
      rule[0].includes('.sidebar__header img[alt="logo"]'),
      `${id}: sidebar logo covered`,
    );
  }
});

test("the logo opt-out is ordered AFTER the generic media un-invert", () => {
  // Both rules match the same <img> and both are !important, so the cascade is
  // decided by specificity/order. If the generic `html.x img` rule were emitted
  // last it would win for any equally-specific match and the logo would go dark
  // again — so assert the source order the fix depends on.
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const css = window.document.getElementById(STYLE_ID).textContent;
  const generic = css.indexOf("html.scaler-theme-active img,");
  const logo = css.indexOf('img[src*="sst-logo"]');
  assert.ok(generic !== -1, "generic media rule present");
  assert.ok(logo !== -1, "logo opt-out present");
  assert.ok(logo > generic, "logo opt-out comes after the generic media rule");
});

test("a natively-dark page is left native (no invert applied)", () => {
  // body has its own dark background → the whole page is already dark.
  const html = `<!DOCTYPE html><html><body style="background-color: rgb(14, 14, 18)">
    <div class="chat" style="background-color: rgb(22,22,28)">chat</div>
  </body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  assert.equal(window.pageIsDark(), true, "page detected as dark");

  window.applyTheme("dark");
  const root = window.document.documentElement;
  assert.ok(
    !root.classList.contains(ROOT_CLASS),
    "invert NOT applied on a natively-dark page",
  );
});

test("a light page still gets inverted", () => {
  const html = `<!DOCTYPE html><html><body style="background-color: rgb(255,255,255)">
    <div>content</div>
  </body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  assert.equal(window.pageIsDark(), false, "page detected as light");
  window.applyTheme("dark");
  assert.ok(
    window.document.documentElement.classList.contains(ROOT_CLASS),
    "invert applied on a light page",
  );
});

test("re-rendering a stable page does NOT toggle the invert class (no flash)", () => {
  const html = `<!DOCTYPE html><html><body style="background-color: rgb(255,255,255)">
    <div>content</div>
  </body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  window.applyTheme("dark");
  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "invert applied");

  // Spy on classList.remove — a stable re-render must NOT remove the class
  // (the old code removed-then-readded every render, causing a flash).
  let togglesOff = 0;
  const orig = root.classList.remove.bind(root.classList);
  root.classList.remove = (...cls) => {
    if (cls.includes(ROOT_CLASS)) togglesOff += 1;
    return orig(...cls);
  };

  // Simulate several DOM-render cycles.
  window.evaluateAndRender();
  window.evaluateAndRender();
  window.evaluateAndRender();

  assert.equal(togglesOff, 0, "invert class never removed on stable re-renders");
  assert.ok(root.classList.contains(ROOT_CLASS), "still inverted");
});

test("scanning an added subtree flags its own dark root (incremental scan)", () => {
  const html = `<!DOCTYPE html><html><body style="background-color: rgb(255,255,255)"></body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  window.applyTheme("dark");

  // Simulate the SPA inserting a dark widget; observer would pass it as scope.
  const el = window.document.createElement("div");
  el.setAttribute("style", "background-color: rgb(16, 16, 20)");
  window.document.body.appendChild(el);
  window.neutralizeDarkRegions(el); // scope === the added node itself

  assert.ok(
    el.hasAttribute("data-scaler-dark-region"),
    "added dark root flagged without a full-document scan",
  );
});

test("turning the theme off clears dark-region flags", () => {
  const html = `<!DOCTYPE html><html><body>
    <div class="monaco-editor" style="background-color: rgb(18, 18, 24)">code</div>
  </body></html>`;
  const { window } = loadFeature(THEME_FILE, { html });
  window.applyTheme("dark");
  window.neutralizeDarkRegions(window.document.body);
  window.applyTheme("off");
  const editor = window.document.querySelector(".monaco-editor");
  assert.ok(!editor.hasAttribute("data-scaler-dark-region"), "flag removed on off");
});

test("initThemeManager reads the saved theme from chrome.storage.sync", async () => {
  const chrome = makeChrome({ syncStore: { cleanerSettings: { theme: "nord" } } });
  // The real extension uses the MV3 promise form (`await storage.sync.get`),
  // as settings.js does. The shared harness mock is callback-only, so wrap it.
  chrome.storage.sync.get = async (keys) => ({
    cleanerSettings: { theme: "nord" },
    ...(keys === "cleanerSettings" ? {} : {}),
  });
  const { window } = loadFeature(THEME_FILE, { chrome });

  await window.initThemeManager();

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "theme applied from storage");
  const style = window.document.getElementById(STYLE_ID);
  assert.match(style.textContent, /hue-rotate\(165deg\)/, "nord recipe applied");
});

test("dark is the default: initThemeManager applies dark when no theme is stored", async () => {
  // A fresh user (empty cleanerSettings / no theme key) must get DARK, not light.
  const chrome = makeChrome({ syncStore: {} });
  chrome.storage.sync.get = async () => ({}); // nothing stored
  const { window } = loadFeature(THEME_FILE, { chrome });

  await window.initThemeManager();

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "dark applied by default on a light page");
  const style = window.document.getElementById(STYLE_ID);
  assert.match(style.textContent, /filter:\s*invert\(1\)/, "dark recipe applied by default");
  assert.ok(root.classList.contains("scaler-theme-dark"), "dark id class set by default");
});

test("an explicit 'off' choice still wins over the dark default", async () => {
  // The dark default must only fill in an UNSET theme — never override a user
  // who deliberately turned theming off.
  const chrome = makeChrome({ syncStore: { cleanerSettings: { theme: "off" } } });
  chrome.storage.sync.get = async () => ({ cleanerSettings: { theme: "off" } });
  const { window } = loadFeature(THEME_FILE, { chrome });

  await window.initThemeManager();

  assert.ok(
    !window.document.documentElement.classList.contains(ROOT_CLASS),
    "explicit off respected — no invert applied",
  );
});

// ── Video-scoped mode ────────────────────────────────────────────────────────
// A root invert+hue-rotate clamps saturated colours (pure red can't come back
// out of it), so a lecture-sized <video> must not sit under any filter at all.

const SCOPED_CLASS = "scaler-theme-scoped";

// The lecture page in miniature: a light dashboard shell under a dark overlay
// holding the player, a white chat panel (with a dark button) and a dark rail.
const PLAYER_HTML = `<!DOCTYPE html><html><body style="background-color: rgb(255, 255, 255)">
  <div id="shell">Dashboard</div>
  <div id="overlay" style="background-color: rgb(18, 18, 18)">
    <div id="topbar" style="background-color: rgb(31, 31, 31)">Lecture</div>
    <div id="main">
      <div id="player" style="background-color: rgb(0, 0, 0)">
        <video id="v"></video>
        <img id="thumb" src="x.png">
        <div id="controls">00:00 / 00:00</div>
        <div id="playlist" style="background-color: rgb(255, 255, 255)">Part 1</div>
      </div>
      <div id="chat" style="background-color: rgb(255, 255, 255)">
        <div id="notice" style="background-color: rgb(30, 42, 74)">Notice Board</div>
      </div>
      <div id="rail" style="background-color: rgb(43, 43, 43)"></div>
    </div>
  </div>
</body></html>`;

// jsdom has no layout: give the video the box a real player would have.
function sizeVideo(window, w, h) {
  const v = window.document.getElementById("v");
  Object.defineProperty(v, "offsetWidth", { configurable: true, value: w });
  Object.defineProperty(v, "offsetHeight", { configurable: true, value: h });
  return v;
}

const themed = (window, id) =>
  window.document.getElementById(id).hasAttribute("data-scaler-themed");

test("scoped CSS is emitted AFTER the unchanged root-mode rules", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const css = window.document.getElementById(STYLE_ID).textContent;

  const rootMedia = css.indexOf("html.scaler-theme-active img,");
  const scopedFilter = css.search(
    /html\.scaler-theme-scoped \[data-scaler-themed\] \{\s*filter:\s*invert\(1\) hue-rotate\(180deg\)/,
  );
  const scopedMedia = css.indexOf("html.scaler-theme-scoped [data-scaler-themed] img,");
  assert.ok(rootMedia !== -1, "root media counter still present");
  assert.ok(scopedFilter !== -1, "themed subtrees carry the theme filter");
  assert.ok(scopedMedia !== -1, "media inside a themed subtree is counter-inverted");
  assert.ok(scopedMedia > rootMedia, "root rules come first (existing tests anchor on them)");
  assert.match(css, /html\.scaler-theme-scoped \{\s*background-color:\s*rgb\(0, 0, 0\)/, "root painted with the themed bg");
});

test("a lecture-sized video switches the page to scoped mode, never filtering its ancestors", () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  const video = sizeVideo(window, 640, 360);
  window.applyTheme("dark");

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(SCOPED_CLASS), "scoped mode on");
  assert.ok(!root.classList.contains(ROOT_CLASS), "root filter OFF");
  for (let el = video; el && el !== root; el = el.parentElement) {
    assert.ok(!el.hasAttribute("data-scaler-themed"), `${el.id || el.tagName} on the video path is not filtered`);
  }
});

test("scoped mode themes light panels, keeps dark chrome and media native", () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  sizeVideo(window, 640, 360);
  window.applyTheme("dark");

  assert.ok(themed(window, "shell"), "light shell themed");
  assert.ok(themed(window, "chat"), "white chat panel themed");
  assert.ok(themed(window, "playlist"), "white playlist panel inside the black player themed");
  assert.ok(!themed(window, "topbar"), "dark top bar left native");
  assert.ok(!themed(window, "rail"), "dark icon rail left native");
  assert.ok(!themed(window, "controls"), "transparent controls over the black player left native");
  assert.ok(!themed(window, "thumb"), "media never carries the filter");
  assert.ok(
    window.document.getElementById("notice").hasAttribute("data-scaler-dark-region"),
    "dark button inside a themed panel keeps its counter",
  );
});

test("a light video ancestor is recoloured inline and restored on teardown", () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  sizeVideo(window, 640, 360);
  const body = window.document.body;
  window.applyTheme("dark");

  assert.ok(body.hasAttribute("data-scaler-video-path"), "body tagged as a recoloured path element");
  assert.equal(body.style.backgroundColor, "rgb(0, 0, 0)", "white body painted as Dark renders white");
  assert.equal(window.pageIsDark(), false, "our own recolour never reads back as a dark page");

  window.applyTheme("off");
  assert.equal(body.style.backgroundColor, "rgb(255, 255, 255)", "original inline background restored");
  assert.ok(!body.hasAttribute("data-scaler-video-path"), "path tag removed");
  assert.equal(window.document.querySelectorAll("[data-scaler-themed]").length, 0, "no themed subtrees left");
  assert.ok(!window.document.documentElement.classList.contains(SCOPED_CLASS), "scoped class removed");
});

test("a small video keeps the page on the root filter", () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  sizeVideo(window, 200, 112);
  window.applyTheme("dark");

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "root mode");
  assert.ok(!root.classList.contains(SCOPED_CLASS), "not scoped");
  assert.equal(window.document.querySelectorAll("[data-scaler-themed]").length, 0);
});

test("leaving scoped mode for root mode clears scoped flags first", () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  sizeVideo(window, 640, 360);
  window.applyTheme("dark");
  assert.ok(themed(window, "chat"));

  sizeVideo(window, 0, 0); // player hidden / navigated away
  window.evaluateAndRender();

  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "back on the root filter");
  assert.equal(window.document.querySelectorAll("[data-scaler-themed]").length, 0, "themed flags cleared");
  assert.equal(window.document.body.style.backgroundColor, "rgb(255, 255, 255)", "body background restored");
  assert.ok(
    window.document.getElementById("overlay").hasAttribute("data-scaler-dark-region"),
    "root-mode dark-region scan ran from scratch",
  );
  assert.ok(
    !window.document.getElementById("notice").hasAttribute("data-scaler-dark-region"),
    "no scoped-era flag left nested inside a root-mode region (would double-flip)",
  );
});

// ── Markers must survive the page rewriting an element's class ───────────────
// Scaler's React components set the whole class string on every state change
// (the chat sidebar goes "m-sidebar" → "m-sidebar m-sidebar--open"), which
// wipes any class the theme added. A marker the CSS depends on can't be a class.

// The stylesheet rules that put a filter on `el`, as the browser would match them.
function filterRulesFor(window, el) {
  const out = [];
  const visit = (rules) => {
    for (const rule of rules) {
      if (rule.cssRules && !rule.selectorText) {
        if (!/print/.test(rule.conditionText || rule.media?.mediaText || "")) visit(rule.cssRules);
        continue;
      }
      if (!rule.selectorText || !/filter\s*:/.test(rule.cssText)) continue;
      const hit = rule.selectorText.split(/,\s*/).some((sel) => {
        try {
          return el.matches(sel);
        } catch (_) {
          return false;
        }
      });
      if (hit) out.push(rule.cssText);
    }
  };
  for (const sheet of window.document.styleSheets) visit(sheet.cssRules);
  return out;
}

test("a themed panel keeps its filter when the page rewrites its class", async () => {
  const { window } = loadFeature(THEME_FILE, { html: PLAYER_HTML });
  sizeVideo(window, 640, 360);
  window.applyTheme("dracula");
  const chat = window.document.getElementById("chat");
  assert.ok(filterRulesFor(window, chat).some((css) => /invert\(0\.9\)/.test(css)), "themed to start with");

  chat.className = "m-sidebar"; // closed
  chat.className = "m-sidebar m-sidebar--open"; // reopened: React set the whole string both times
  assert.ok(
    filterRulesFor(window, chat).some((css) => /invert\(0\.9\)/.test(css)),
    "the theme filter still applies to the panel",
  );

  // Content mounted into the reopened panel belongs to it: no filter of its own.
  const content = window.document.createElement("div");
  content.id = "archive";
  content.style.backgroundColor = "rgb(255, 255, 255)";
  chat.appendChild(content);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(filterRulesFor(window, content).length, 0, "content is themed through the panel, once");
});

test("a dark region keeps its counter when the page rewrites its class", () => {
  const { window } = loadFeature(THEME_FILE, {
    html: `<!DOCTYPE html><html><body style="background-color: rgb(255, 255, 255)">
      <div id="term" class="terminal" style="background-color: rgb(20, 20, 20)">$ ls</div></body></html>`,
  });
  window.applyTheme("dark");
  const term = window.document.getElementById("term");
  assert.equal(filterRulesFor(window, term).length, 1, "countered to start with");

  term.className = "terminal terminal--focused";
  assert.equal(filterRulesFor(window, term).length, 1, "still countered: it would turn white otherwise");
});

// ── Elements that are sized after they are first seen ────────────────────────
// Size gates are read when an element is first seen. A panel that mounts
// collapsed and slides open, a shell filled after it mounts, a video resized
// by CSS: none add a node, so each needs a second look when its size changes.

// Give jsdom a layout: an element measures its data-box="WxH" (default 200x100).
function fakeLayout(window) {
  const box = (el) => {
    const m = /^(\d+)x(\d+)$/.exec(el.getAttribute("data-box") || "");
    return m ? [Number(m[1]), Number(m[2])] : [200, 100];
  };
  Object.defineProperty(window.document.documentElement, "clientWidth", { configurable: true, value: 1280 });
  window.Element.prototype.getBoundingClientRect = function () {
    const [width, height] = box(this);
    return { width, height, top: 0, left: 0, right: width, bottom: height };
  };
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return box(this)[0]; } });
  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get() { return box(this)[1]; } });
}

// A ResizeObserver the test fires by hand.
function fakeResizeObserver(window) {
  const observers = [];
  window.ResizeObserver = class {
    constructor(cb) {
      this.cb = cb;
      this.targets = new Set();
      observers.push(this);
    }
    observe(el) { this.targets.add(el); }
    unobserve(el) { this.targets.delete(el); }
    disconnect() { this.targets.clear(); }
  };
  return {
    watched: () => observers.flatMap((o) => Array.from(o.targets)),
    resize(...els) {
      observers.forEach((o) => {
        const hit = els.filter((el) => o.targets.has(el));
        if (hit.length) o.cb(hit.map((target) => ({ target })));
      });
    },
  };
}

// Long enough for the mutation observer's requestAnimationFrame flush.
const flushed = () => new Promise((resolve) => setTimeout(resolve, 60));

const LATE_HTML = `<!DOCTYPE html><html><body style="background-color: rgb(255, 255, 255)">
  <div id="overlay" style="background-color: rgb(18, 18, 18)">
    <div id="player" style="background-color: rgb(0, 0, 0)"><video id="v" data-box="640x360"></video></div>
    <div id="slot"></div>
  </div>
</body></html>`;

const PANEL_HTML = `<div id="panel" data-box="0x600" style="background-color: rgb(255, 255, 255)">
  <div id="head" style="background-color: rgb(255, 255, 255)">Chat</div>
  <div id="notice" style="background-color: rgb(30, 42, 74)">Notice Board</div>
  <div id="msgs" style="background-color: rgb(244, 244, 244)"></div>
</div>`;

function loadLate(html = LATE_HTML) {
  const { window } = loadFeature(THEME_FILE, { html });
  fakeLayout(window);
  const ro = fakeResizeObserver(window);
  window.applyTheme("dark");
  return { window, ro, $: (id) => window.document.getElementById(id) };
}

test("a panel that mounts collapsed is themed as a whole once it opens", async () => {
  const { window, ro, $ } = loadLate();
  $("slot").innerHTML = PANEL_HTML;
  await flushed();

  // Width 0 at mount: the panel is passed over and only its pieces are themed,
  // which leaves the panel's own white background unthemed around them.
  assert.ok(!themed(window, "panel"), "collapsed panel is passed over");
  assert.ok(themed(window, "head") && themed(window, "msgs"), "its sized pieces are themed for now");
  assert.ok(ro.watched().includes($("panel")), "and the panel is watched");

  $("panel").setAttribute("data-box", "320x600"); // the slide-in finished
  ro.resize($("panel"));

  assert.ok(themed(window, "panel"), "panel themed once it has a size");
  assert.ok(!themed(window, "head") && !themed(window, "msgs"), "pieces no longer carry a second filter");
  assert.ok($("notice").hasAttribute("data-scaler-dark-region"), "dark button inside keeps its counter");
  assert.ok(!ro.watched().includes($("panel")), "panel no longer watched");
});

test("a panel still mid-slide on a dark surface is not written off as a chip", async () => {
  const { window, ro, $ } = loadLate();
  $("slot").innerHTML = PANEL_HTML;
  await flushed();

  $("panel").setAttribute("data-box", "6x600"); // first frame of the slide
  ro.resize($("panel"));
  assert.ok(!themed(window, "panel"), "a 6px sliver is not themed");
  assert.ok(ro.watched().includes($("panel")), "but it is still watched");

  $("panel").setAttribute("data-box", "320x600");
  ro.resize($("panel"));
  assert.ok(themed(window, "panel"), "themed when it reaches full size");
});

test("content added to a shell that mounted empty themes the shell, not just the content", async () => {
  const { window, $ } = loadLate();
  $("slot").innerHTML = `<div id="shell2" data-box="300x0" style="background-color: rgb(255, 255, 255)"></div>`;
  await flushed();
  assert.ok(!themed(window, "shell2"), "an empty, zero-height shell is passed over");

  $("shell2").setAttribute("data-box", "300x200");
  $("shell2").innerHTML = `<div id="row1">Chat</div><div id="row2">Hello</div>`;
  await flushed();

  assert.ok(themed(window, "shell2"), "the shell is themed");
  assert.ok(!themed(window, "row1") && !themed(window, "row2"), "its rows are themed through it");
});

test("root mode: a dark drawer that mounts collapsed is protected once it opens", async () => {
  const { window, ro, $ } = loadLate(`<!DOCTYPE html><html><body style="background-color: rgb(255, 255, 255)">
    <div id="slot"></div></body></html>`);
  assert.ok(window.document.documentElement.classList.contains(ROOT_CLASS), "root mode");

  $("slot").innerHTML = `<div id="drawer" data-box="0x300" style="background-color: rgb(30, 30, 30)">
    <div id="dhead" data-box="320x60" style="background-color: rgb(17, 17, 17)">Menu</div></div>`;
  await flushed();
  const flagged = (id) => $(id).hasAttribute("data-scaler-dark-region");
  assert.ok(!flagged("drawer"), "width 0: not a dark region yet");
  assert.ok(flagged("dhead"), "its sized dark header is");

  $("drawer").setAttribute("data-box", "320x300");
  ro.resize($("drawer"));
  assert.ok(flagged("drawer"), "drawer kept dark once open");
  assert.ok(!flagged("dhead"), "header not countered a second time (that would turn it light)");
});

test("a video resized with no DOM change re-decides the render mode", async () => {
  const { window, ro, $ } = loadLate(LATE_HTML.replace("640x360", "200x112"));
  const root = window.document.documentElement;
  assert.ok(root.classList.contains(ROOT_CLASS), "small video: root filter");

  $("v").setAttribute("data-box", "640x360"); // the player grew by CSS alone
  ro.resize($("v"));
  await flushed();
  assert.ok(root.classList.contains(SCOPED_CLASS), "lecture-sized now: scoped mode");
  assert.ok(!root.classList.contains(ROOT_CLASS), "root filter off the video");
});

test("watched elements are released when removed and when the theme is turned off", async () => {
  const { window, ro, $ } = loadLate();
  $("slot").innerHTML = PANEL_HTML;
  await flushed();
  const panel = $("panel");
  assert.ok(ro.watched().includes(panel));

  panel.remove();
  $("slot").appendChild(window.document.createElement("span"));
  await flushed();
  assert.ok(!ro.watched().includes(panel), "a removed element is no longer held");

  window.applyTheme("off");
  assert.equal(ro.watched().length, 0, "nothing watched with the theme off");
});

test("applyFilterToRgb matches what Chromium renders", () => {
  // Expected values measured from Chromium screenshots of the same filters.
  const { window } = loadFeature(THEME_FILE);
  const t = window.SCALER_THEMES;
  const rgb = (c) => [c.r, c.g, c.b];
  const white = { r: 255, g: 255, b: 255 };
  assert.deepEqual(rgb(window.applyFilterToRgb(t.dark.filter, white)), [0, 0, 0]);
  assert.deepEqual(rgb(window.applyFilterToRgb(t.dark.filter, { r: 255, g: 0, b: 0 })), [255, 146, 146]);
  assert.deepEqual(rgb(window.applyFilterToRgb(t.midnight.filter, white)), [24, 24, 25]);
  assert.deepEqual(rgb(window.applyFilterToRgb(t.sepia.filter, { r: 128, g: 128, b: 128 })), [142, 136, 124]);
  // Functions apply in order.
  assert.deepEqual(rgb(window.applyFilterToRgb("invert(1) brightness(0.5)", white)), [0, 0, 0]);
  assert.deepEqual(rgb(window.applyFilterToRgb("brightness(0.4) invert(1)", white)), [153, 153, 153]);
});

// ── Hot-path cost (observer flush, settings writes) ──────────────────────────

test("applyThemeIfChanged skips a re-theme when the theme didn't change", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const style = window.document.getElementById(STYLE_ID);
  let writes = 0;
  new window.MutationObserver((r) => (writes += r.length)).observe(style, { childList: true, characterData: true, subtree: true });

  window.applyThemeIfChanged("dark");
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(writes, 0, "stylesheet untouched");
    window.applyThemeIfChanged("off");
    assert.ok(!window.document.documentElement.classList.contains(ROOT_CLASS), "a real change still applies");
  });
});

test("a settings write that leaves the theme alone does not re-theme", () => {
  const listeners = [];
  const chrome = makeChrome();
  chrome.storage.onChanged = { addListener: (fn) => listeners.push(fn) };
  const { window } = loadFeature(THEME_FILE, { chrome });
  window.applyTheme("dark");
  let applied = 0;
  const real = window.applyTheme;
  // applyThemeIfChanged calls applyTheme by its global name.
  window.eval("applyTheme = function (id) { window.__applied = (window.__applied || 0) + 1; }");
  listeners.forEach((fn) =>
    fn({ cleanerSettings: { oldValue: { theme: "dark", x: 1 }, newValue: { theme: "dark", x: 2 } } }, "sync"),
  );
  applied = window.__applied || 0;
  window.applyTheme = real;
  assert.equal(applied, 0);
});

test("dark regions in several added subtrees are flagged in one pass, nested ones once", () => {
  const { window } = loadFeature(THEME_FILE);
  window.applyTheme("dark");
  const doc = window.document;
  const outer = doc.createElement("div");
  outer.style.backgroundColor = "rgb(10, 10, 10)";
  const inner = doc.createElement("div");
  inner.style.backgroundColor = "rgb(12, 12, 12)";
  outer.appendChild(inner);
  const other = doc.createElement("section");
  other.style.backgroundColor = "rgb(5, 5, 5)";
  doc.body.append(outer, other);

  window.neutralizeDarkRegions(outer);
  window.neutralizeDarkRegions(other);
  const flagged = Array.from(doc.querySelectorAll("[data-scaler-dark-region]"));
  assert.ok(flagged.includes(outer) && flagged.includes(other), "both regions flagged");
  assert.ok(!flagged.includes(inner), "a dark child of a flagged region is not flagged again");
});
