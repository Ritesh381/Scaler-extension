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
    editor.classList.contains("scaler-no-invert"),
    "dark editor flagged for counter-invert",
  );
  assert.ok(
    !lightPre.classList.contains("scaler-no-invert"),
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
    el.classList.contains("scaler-no-invert"),
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
  assert.ok(!editor.classList.contains("scaler-no-invert"), "flag removed on off");
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
