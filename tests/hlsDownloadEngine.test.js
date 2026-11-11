// ============================================================
// hlsDownloadEngine.test.js
// The HLS engine shared by the single-video processor and bulk download:
// rendition choice, ordered writes from parallel fetches, failed chunks,
// the scaler.com proxy (and its fallback), and cancellation.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome } = require("./helpers/harness");

const FILE = "content/features/videoDownloader/hlsDownloadEngine.js";
const BASE = "https://cdn.test/rec/1/";
const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=400000
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000
720p/index.m3u8
`;
const media = (n) =>
  "#EXTM3U\n" + Array.from({ length: n }, (_, i) => `#EXTINF:6,\nseg${i}.ts`).join("\n") + "\n#EXT-X-ENDLIST\n";

/**
 * A fake CDN: playlists by URL, segment i = one byte with value i, each
 * answered after `delay(i)` ms; `fail(i)` makes a segment always 500.
 */
function cdn({ segments = 6, delay = () => 0, fail = () => false } = {}) {
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    const seg = url.match(/seg(\d+)\.ts$/);
    if (seg) {
      const i = Number(seg[1]);
      await new Promise((r) => setTimeout(r, delay(i)));
      if (fail(i)) return { ok: false, status: 500 };
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([i]).buffer };
    }
    const text = url.endsWith("master.m3u8") ? MASTER : media(segments);
    return { ok: true, status: 200, text: async () => text };
  };
  return { fetch, requested };
}

function writable() {
  const writes = [];
  return { writes, write: async (data) => writes.push(Array.from(new Uint8Array(data))[0]) };
}

function engineFor(window, opts) {
  const logs = [];
  const progress = [];
  const engine = window.createHlsEngine({
    onLog: (l) => logs.push(l),
    onProgress: (d, t) => progress.push([d, t]),
    ...opts,
  });
  return { engine, logs, progress };
}

test("video takes the highest-bandwidth rendition; audio the dedicated audio one", async () => {
  const { fetch } = cdn({ segments: 2 });
  const { window } = loadFeature(FILE, { fetch });
  const video = engineFor(window, { type: "video" }).engine;
  assert.equal(video.getMediaPlaylistUrl(MASTER, BASE + "master.m3u8"), BASE + "720p/index.m3u8");
  const audio = engineFor(window, { type: "audio" }).engine;
  assert.equal(audio.getMediaPlaylistUrl(MASTER, BASE + "master.m3u8"), BASE + "audio/index.m3u8");
  assert.deepEqual(
    Array.from(await video.resolveSegments(BASE + "master.m3u8")),
    [BASE + "720p/seg0.ts", BASE + "720p/seg1.ts"],
  );
});

test("chunks finishing out of order are still written strictly in order", async () => {
  // Earlier segments are slower, so they finish last.
  const { fetch } = cdn({ segments: 8, delay: (i) => (8 - i) * 3 });
  const { window } = loadFeature(FILE, { fetch });
  const { engine, progress } = engineFor(window, { type: "video" });
  const out = writable();
  const segs = await engine.resolveSegments(BASE + "master.m3u8");
  await engine.downloadConcurrently(segs, out);
  assert.deepEqual(out.writes, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(Array.from(progress[progress.length - 1]), [8, 8]);
});

test("a chunk that keeps failing is skipped after its retries, with a warning", async () => {
  const { fetch } = cdn({ segments: 3, fail: (i) => i === 1 });
  const { window } = loadFeature(FILE, { fetch });
  const { engine, logs } = engineFor(window, { type: "video" });
  const out = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.deepEqual(out.writes, [0, 2]);
  assert.ok(logs.some((l) => /⚠ Chunk 2 failed after 3 retries/.test(l)));
});

test("with a source tab, fetches go through its proxy; an unreachable tab falls back to direct", async () => {
  const { fetch, requested } = cdn({ segments: 2 });
  const chrome = makeChrome();
  const proxied = [];
  let reachable = true;
  chrome.tabs = {
    sendMessage: (tabId, msg, cb) => {
      if (!reachable) {
        chrome.runtime.lastError = { message: "Could not establish connection." };
        cb(undefined);
        chrome.runtime.lastError = null;
        return;
      }
      proxied.push([tabId, msg.type, msg.url]);
      fetch(msg.url).then(async (res) =>
        cb({
          success: true,
          data: msg.type === "text" ? await res.text() : Array.from(new Uint8Array(await res.arrayBuffer())),
        }),
      );
    },
  };
  const { window } = loadFeature(FILE, { fetch, chrome });

  const { engine } = engineFor(window, { type: "video", sourceTabId: 42 });
  const out = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.deepEqual(out.writes, [0, 1]);
  assert.ok(proxied.every(([tab]) => tab === 42) && proxied.length === 4, "playlists + chunks via the proxy");

  reachable = false;
  requested.length = 0;
  const out2 = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out2);
  assert.deepEqual(out2.writes, [0, 1], "still downloads");
  assert.equal(requested.length, 4, "directly, once the source tab is gone");
});

test("aborting stops the download with an AbortError", async () => {
  const { fetch } = cdn({ segments: 40, delay: () => 5 });
  const { window } = loadFeature(FILE, { fetch });
  const controller = new window.AbortController();
  const { engine } = engineFor(window, { type: "video", signal: controller.signal });
  const out = writable();
  const segs = await engine.resolveSegments(BASE + "master.m3u8");
  setTimeout(() => controller.abort(), 12);
  await assert.rejects(engine.downloadConcurrently(segs, out), (err) => err.name === "AbortError");
  assert.ok(out.writes.length < 40, "stopped early");
});

test("downloadToMemory returns every chunk concatenated in order", async () => {
  const { fetch } = cdn({ segments: 5, delay: (i) => (5 - i) * 2 });
  const { window } = loadFeature(FILE, { fetch });
  const { engine } = engineFor(window, { type: "audio" });
  const buf = await engine.downloadToMemory(await engine.resolveSegments(BASE + "master.m3u8"));
  assert.deepEqual(Array.from(new Uint8Array(buf)), [0, 1, 2, 3, 4]);
});

test("directFirst: fetches directly when the CDN answers; the proxy isn't touched", async () => {
  const { fetch, requested } = cdn({ segments: 3 });
  const chrome = makeChrome();
  let proxied = 0;
  chrome.tabs = { sendMessage: () => { proxied++; } };
  const { window } = loadFeature(FILE, { fetch, chrome });
  const { engine } = engineFor(window, { type: "video", sourceTabId: 42, directFirst: true });
  const out = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.deepEqual(out.writes, [0, 1, 2]);
  assert.equal(proxied, 0);
  assert.equal(requested.length, 5, "master + media + 3 chunks, all direct");
});

test("directFirst: one failed direct fetch switches the rest of the download to the proxy", async () => {
  const base = cdn({ segments: 4 });
  let directOk = true;
  const fetch = async (url) => {
    if (!directOk) throw new TypeError("Failed to fetch"); // CORS-style failure
    return base.fetch(url);
  };
  const chrome = makeChrome();
  let proxied = 0;
  chrome.tabs = {
    sendMessage: (tabId, msg, cb) => {
      proxied++;
      base.fetch(msg.url).then(async (res) =>
        cb({ success: true, data: msg.type === "text" ? await res.text() : Array.from(new Uint8Array(await res.arrayBuffer())) }),
      );
    },
  };
  const { window } = loadFeature(FILE, { fetch, chrome });
  const { engine } = engineFor(window, { type: "video", sourceTabId: 42, directFirst: true });
  const segs = await engine.resolveSegments(BASE + "master.m3u8"); // direct
  directOk = false;
  const out = writable();
  await engine.downloadConcurrently(segs, out);
  assert.deepEqual(out.writes, [0, 1, 2, 3], "nothing lost");
  assert.equal(proxied, 4, "every chunk via the proxy once direct failed");
});
