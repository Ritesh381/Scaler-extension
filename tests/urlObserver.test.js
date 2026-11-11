// ============================================================
// urlObserver.test.js
// Feature re-init hooks run once per real URL change, after the debounce.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, readFeature, tick } = require("./helpers/harness");

/** Load scripts as one bundle: they share top-level const/let, as on the page. */
function loadBundle(files, opts) {
  const { window } = loadFeature([], opts);
  window.eval(files.map((f) => readFeature(f)).join("\n;\n"));
  return { window };
}


const FILES = ["content/cleaner/selectors.js", "content/core/settings.js", "content/core/urlObserver.js"];

function load(globals = {}) {
  const { window } = loadBundle(FILES, { globals: { runCleanup: () => {}, ...globals } });
  let runs = 0;
  window.onUrlChange(() => runs++);
  return { window, runs: () => runs };
}

test("a burst of change signals for one navigation runs the hooks once", async () => {
  const { window, runs } = load();
  window.setupUrlChangeDetection();
  window.history.pushState({}, "", "/academy/mentee-dashboard/todos");
  window.handleUrlChange();
  window.handleUrlChange();
  window.document.body.appendChild(window.document.createElement("div")); // observer path
  await tick(600);
  assert.equal(runs(), 1);
});

test("a same-URL replaceState runs no hooks", async () => {
  const { window, runs } = load();
  window.setupUrlChangeDetection();
  window.history.replaceState({}, "", window.location.href);
  window.handleUrlChange();
  await tick(400);
  assert.equal(runs(), 0);
});

test("the Navigation API, once it fires, replaces the body-wide observer", async () => {
  const listeners = {};
  const navigation = { addEventListener: (type, fn) => (listeners[type] = fn) };
  const { window, runs } = load({ navigation });
  window.setupUrlChangeDetection();
  assert.ok(window._scalerUrlObserver, "fallback observer runs until the API proves itself");

  window.history.pushState({}, "", "/academy/mentee-dashboard/core-curriculum");
  listeners.currententrychange();
  assert.equal(window._scalerUrlObserver, null, "observer dropped");
  await tick(400);
  assert.equal(runs(), 1);
});

test("setup is idempotent", () => {
  const { window } = load();
  window.setupUrlChangeDetection();
  const first = window._scalerUrlObserver;
  window.setupUrlChangeDetection();
  assert.equal(window._scalerUrlObserver, first);
});
