// ============================================================
// fetchTimeout.test.js
// bgFetch: every service-worker request gets a timeout unless the caller
// brings its own signal.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

function load(fetchImpl) {
  const { window } = loadFeature([], {});
  window.fetch = fetchImpl;
  window.eval(require("./helpers/harness").readFeature("background/fetchTimeout.js") + "\n;window.__bgFetch = bgFetch;");
  return window;
}

test("adds a timeout signal and rejects when the request hangs", async () => {
  let seen = null;
  const window = load((url, opts) => {
    seen = opts;
    return new Promise((_, reject) => opts.signal.addEventListener("abort", () => reject(opts.signal.reason)));
  });
  await assert.rejects(window.__bgFetch("https://x.test", { method: "POST" }, 30), (err) => err.name === "TimeoutError");
  assert.equal(seen.method, "POST", "caller options kept");
});

test("keeps a caller's own signal untouched", async () => {
  const ctrl = new AbortController();
  let seen = null;
  const window = load((url, opts) => {
    seen = opts;
    return Promise.resolve({ ok: true });
  });
  await window.__bgFetch("https://x.test", { signal: ctrl.signal });
  assert.equal(seen.signal, ctrl.signal);
});
