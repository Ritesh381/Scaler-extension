// ============================================================
// videoDownloader.test.js
// The download button's content script: the FETCH_PROXY transport (base64,
// decoded by hlsDownloadEngine.js) and the observer lifecycle — nothing
// watches the DOM while the feature is off or off a class page.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, readFeature, tick } = require("./helpers/harness");

const VD = "content/features/videoDownloader/videoDownloader.js";
const ENGINE = "content/features/videoDownloader/hlsDownloadEngine.js";

function load({ url = "https://www.scaler.com/academy/mentee-dashboard/class/123/session", enabled = true } = {}) {
  const chrome = makeChrome();
  // init() awaits the promise form of storage.sync.get.
  chrome.storage.sync.get = async () => ({ cleanerSettings: { "video-downloader": enabled } });
  const hooks = [];
  const { window } = loadFeature([], {
    url,
    chrome,
    globals: {
      // urlObserver.js's hook registry, which the content script uses for SPA navigation.
      onUrlChange: (fn) => hooks.push(fn),
      PerformanceObserver: class {
        observe() {}
        disconnect() {}
      },
    },
  });
  window.eval(readFeature(VD) + "\n;globalThis.VideoDownloader = VideoDownloader;");
  window.eval(readFeature(ENGINE));
  return { window, chrome, hooks };
}

const toggle = (chrome, value) =>
  chrome.__messageListeners.forEach((fn) =>
    fn({ action: "toggleSetting", key: "video-downloader", value }, {}, () => {}),
  );

test("base64 transport round-trips through the engine's decoder (native and fallback)", async () => {
  const { window } = load();
  // Odd length and > one fallback chunk (32766 bytes) to cover the seams.
  const bytes = new window.Uint8Array(100003);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) & 0xff;
  const roundTrip = () =>
    new window.Uint8Array(window.hlsDecodeProxyBytes(window.VideoDownloader.toBase64(bytes.buffer), "base64"));

  assert.deepEqual(Buffer.from(roundTrip()), Buffer.from(bytes));
  window.eval("delete Uint8Array.prototype.toBase64; delete Uint8Array.fromBase64");
  const encoded = window.VideoDownloader.toBase64(bytes.buffer);
  assert.equal(encoded, Buffer.from(bytes).toString("base64"), "btoa fallback matches");
  assert.deepEqual(Buffer.from(roundTrip()), Buffer.from(bytes));
});

test("FETCH_PROXY answers binary as base64, compact on the wire", async () => {
  const { window, chrome } = load();
  window.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3, 250]).buffer });
  await tick(5);
  const reply = await new Promise((resolve) => {
    chrome.__messageListeners.forEach((fn) =>
      fn({ action: "FETCH_PROXY", url: "https://cdn.test/seg0.ts", type: "binary" }, {}, resolve),
    );
  });
  assert.equal(reply.success, true);
  assert.equal(reply.encoding, "base64");
  assert.equal(typeof reply.data, "string");
  assert.deepEqual(Array.from(new Uint8Array(window.hlsDecodeProxyBytes(reply.data, reply.encoding))), [1, 2, 3, 250]);
});

test("disabled: no DOM observer, no network observer", async () => {
  const { window } = load({ enabled: false });
  await tick(5);
  const vd = window.ScalerVideoDownloader;
  assert.equal(vd._observer, null);
  assert.equal(vd._networkObserver, null);
});

test("enabled off a class page: no DOM observer until navigation reaches one", async () => {
  const { window, hooks } = load({ url: "https://www.scaler.com/academy/mentee-dashboard/todos" });
  await tick(5);
  const vd = window.ScalerVideoDownloader;
  assert.equal(vd._observer, null);
  assert.ok(vd._networkObserver, "still listens for the stream URL");
  assert.equal(hooks.length, 1, "registered with urlObserver's onUrlChange");

  window.history.pushState({}, "", "/academy/mentee-dashboard/class/9/session");
  hooks.forEach((fn) => fn());
  assert.ok(vd._observer, "observing on the class page");

  window.history.pushState({}, "", "/academy/mentee-dashboard/todos");
  hooks.forEach((fn) => fn());
  assert.equal(vd._observer, null, "stopped again on leaving it");
});

test("toggle off tears everything down even without a button; toggle on restores", async () => {
  const { window, chrome } = load();
  await tick(5);
  const vd = window.ScalerVideoDownloader;
  assert.ok(vd._observer, "observing on a class page");
  vd._outsideClickHandler = () => {};
  let removed = 0;
  const realRemove = window.document.removeEventListener.bind(window.document);
  window.document.removeEventListener = (type, fn) => {
    if (type === "click") removed++;
    realRemove(type, fn);
  };

  toggle(chrome, false);
  assert.equal(vd._observer, null);
  assert.equal(vd._networkObserver, null);
  assert.equal(vd._outsideClickHandler, null);
  assert.equal(removed, 1, "document click listener removed");

  toggle(chrome, true);
  assert.ok(vd._observer, "observer back after re-enabling");
});
