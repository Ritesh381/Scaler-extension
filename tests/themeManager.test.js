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
