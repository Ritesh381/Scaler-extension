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
  const occurrences = (style.textContent.match(/html\.scaler-theme-active \{/g) || []).length;
  assert.equal(occurrences, 1, "exactly one root rule after switching");
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
