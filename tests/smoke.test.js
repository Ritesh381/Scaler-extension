const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { EXTENSION_ROOT, makeChrome, makeFetch } = require("./helpers/harness");

// The real extension loads all content scripts into ONE shared scope (so
// top-level `const`/`function` in one file are visible to the next). We mirror
// that by concatenating the manifest's content_scripts and eval-ing once.
function manifestContentScripts() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(EXTENSION_ROOT, "manifest.json"), "utf8"),
  );
  return manifest.content_scripts[0].js;
}

function buildBundleWindow() {
  const files = manifestContentScripts();
  const bundle = files
    .map((rel) => `\n/* ==== ${rel} ==== */\n` + fs.readFileSync(path.join(EXTENSION_ROOT, rel), "utf8"))
    .join("\n;\n");

  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;
  window.chrome = makeChrome();
  window.fetch = makeFetch(() => ({ ok: false, status: 404 }));
  window.console = console;
  // Minimal shims for browser APIs jsdom lacks, in case a constructor touches them.
  if (!window.navigator.mediaDevices) window.navigator.mediaDevices = {};
  if (!window.matchMedia) window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
  if (!window.PerformanceObserver) {
    window.PerformanceObserver = class { observe() {} disconnect() {} };
  }

  window.eval(bundle);
  return { dom, window, files };
}

test("the full content-script bundle evaluates without throwing", () => {
  assert.doesNotThrow(() => buildBundleWindow());
});

test("every documented feature entrypoint is wired up", () => {
  const { window } = buildBundleWindow();
  const expected = [
    "initLeetCodeLink",
    "initProblemsSearch",
    "initJoinSessionButtons",
    "initSubjectSort",
    "initContestLeaderboard",
    "initCustomMessages",
    "initProblemPicker",
    "initUsernameTracker",
    "initLectureInfo",
    "initInstructorInfo",
    "initLectureSummary",
    "initSpotlightSearch",
    "initThemeManager",
  ];
  for (const name of expected) {
    assert.equal(
      typeof window[name],
      "function",
      `expected window.${name} to be a function after load`,
    );
  }
});

test("shared utilities and self-instantiated singletons are present", () => {
  const { window } = buildBundleWindow();
  assert.equal(typeof window.tokenize, "function", "stringUtils loaded");
  assert.equal(typeof window.getElementByXPath, "function", "domUtils loaded");
  assert.ok(window.ScalerVideoDownloader, "videoDownloader singleton created");
  assert.ok(window.ScalerLiveStreamRecorder, "liveStreamRecorder singleton created");
});
