const { test } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
const { readFeature } = require("./helpers/harness");

const SRC = readFeature("content/core/themePreload.js");
const PRELOAD_ID = "scaler-theme-preload";

// jsdom's localStorage isn't available in this Node env, so inject a simple
// Map-backed stub the preload IIFE will read via the global `localStorage`.
function makeLocalStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

function run(lsData, pathname) {
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "https://www.scaler.com" + (pathname || "/dashboard"),
    runScripts: "outside-only",
  });
  const { window } = dom;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: makeLocalStorage(lsData),
  });
  window.eval(SRC);
  return window;
}

test("applies the saved theme filter before paint", () => {
  const window = run({
    scalerpp_theme: "dark",
    scalerpp_theme_filter: "invert(1) hue-rotate(180deg)",
  });
  const style = window.document.getElementById(PRELOAD_ID);
  assert.ok(style, "preload style injected");
  assert.match(style.textContent, /filter:\s*invert\(1\) hue-rotate\(180deg\)/);
  assert.match(style.textContent, /html img,/, "media counter present");
});

test("does nothing when theme is off or unset", () => {
  assert.equal(run({ scalerpp_theme: "off" }).document.getElementById(PRELOAD_ID), null);
  assert.equal(run({}).document.getElementById(PRELOAD_ID), null);
});

test("skips pages known to be natively dark", () => {
  const window = run(
    {
      scalerpp_theme: "dark",
      scalerpp_theme_filter: "invert(1) hue-rotate(180deg)",
      scalerpp_dark_paths: JSON.stringify(["/meetings/x/archive"]),
    },
    "/meetings/x/archive",
  );
  assert.equal(window.document.getElementById(PRELOAD_ID), null, "no preload on dark path");
});

test("rejects a malicious filter value (CSS-injection guard)", () => {
  const window = run({
    scalerpp_theme: "dark",
    scalerpp_theme_filter: "red;} body{display:none}",
  });
  assert.equal(
    window.document.getElementById(PRELOAD_ID),
    null,
    "injection attempt produces no style",
  );
});
