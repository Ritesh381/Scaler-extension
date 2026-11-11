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

/** Read a jsdom Blob's bytes (jsdom's Blob has no arrayBuffer()). */
function blobBytes(window, blob) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onload = () => resolve(Array.from(new Uint8Array(reader.result)));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

test("downloadToMemory returns a Blob of every chunk in order, built without a combined copy", async () => {
  const { fetch } = cdn({ segments: 5, delay: (i) => (5 - i) * 2 });
  const { window } = loadFeature(FILE, { fetch });
  // Record every Blob's parts: none may be one buffer holding the whole file.
  const RealBlob = window.Blob;
  const blobParts = [];
  window.Blob = function (parts, opts) {
    blobParts.push(parts);
    return new RealBlob(parts, opts);
  };
  const { engine } = engineFor(window, { type: "audio" });
  const blob = await engine.downloadToMemory(await engine.resolveSegments(BASE + "master.m3u8"), null, "audio/mpeg");
  window.Blob = RealBlob;
  assert.equal(blob.type, "audio/mpeg");
  assert.deepEqual(await blobBytes(window, blob), [0, 1, 2, 3, 4]);
  const buffers = blobParts.flat().filter((p) => !(p instanceof RealBlob));
  assert.ok(buffers.length > 0 && buffers.every((p) => p.byteLength === 1), "built from the 1-byte chunks themselves");
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

// ── Transport, rendition choice, backpressure, failures ──────────────────────

test("proxy replies in base64 are decoded; legacy number arrays still work", async () => {
  const { window } = loadFeature(FILE);
  const bytes = [0, 1, 127, 128, 254, 255, 10, 13];
  const b64 = Buffer.from(bytes).toString("base64");
  assert.deepEqual(Array.from(new Uint8Array(window.hlsDecodeProxyBytes(b64, "base64"))), bytes);
  assert.deepEqual(Array.from(new Uint8Array(window.hlsDecodeProxyBytes(bytes))), bytes);
  // The atob fallback, for Chrome builds without Uint8Array.fromBase64.
  window.eval("delete Uint8Array.fromBase64");
  assert.deepEqual(Array.from(new Uint8Array(window.hlsDecodeProxyBytes(b64, "base64"))), bytes);
});

test("a base64 proxy reply lands as the right bytes in the file", async () => {
  const { fetch } = cdn({ segments: 3 });
  const chrome = makeChrome();
  chrome.tabs = {
    sendMessage: (tabId, msg, cb) => {
      fetch(msg.url).then(async (res) =>
        cb(
          msg.type === "text"
            ? { success: true, data: await res.text() }
            : { success: true, data: Buffer.from(await res.arrayBuffer()).toString("base64"), encoding: "base64" },
        ),
      );
    },
  };
  const { window } = loadFeature(FILE, { fetch, chrome });
  const { engine } = engineFor(window, { type: "video", sourceTabId: 7 });
  const out = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.deepEqual(out.writes, [0, 1, 2]);
});

const MUXED = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2400000,CODECS="avc1.640028,mp4a.40.2"
1080p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=150000,CODECS="avc1.42c00d"
novideo-audio/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4d401e,mp4a.40.2"
360p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
`;

test("no audio rendition: audio/transcript take the lightest variant with AAC; video the heaviest", () => {
  const { window } = loadFeature(FILE);
  const pick = (type, master) =>
    engineFor(window, { type }).engine.getMediaPlaylistUrl(master, BASE + "master.m3u8");
  assert.equal(pick("video", MUXED), BASE + "1080p/index.m3u8");
  assert.equal(pick("audio", MUXED), BASE + "360p/index.m3u8", "skips the variant declared without mp4a");
  assert.equal(pick("transcript", MUXED), BASE + "360p/index.m3u8");
  // No CODECS at all: simply the lowest bandwidth.
  const bare = MASTER.replace(/#EXT-X-MEDIA.*\n/, "");
  assert.equal(pick("audio", bare), BASE + "360p/index.m3u8");
  assert.equal(pick("video", bare), BASE + "720p/index.m3u8");
});

test("backpressure: one slow chunk holds workers within the reorder window", async () => {
  const total = 60;
  const window_ = 12; // HLS_REORDER_WINDOW = 2 × HLS_CONCURRENCY
  let written = 0;
  let maxAhead = 0;
  const base = cdn({ segments: total, delay: (i) => (i === 0 ? 150 : 1) });
  const fetch = async (url, opts) => {
    const seg = url.match(/seg(\d+)\.ts$/);
    if (seg) maxAhead = Math.max(maxAhead, Number(seg[1]) - written);
    return base.fetch(url, opts);
  };
  const { window } = loadFeature(FILE, { fetch });
  const { engine } = engineFor(window, { type: "video" });
  const out = { writes: [], write: async (d) => { written++; out.writes.push(new Uint8Array(d)[0]); } };
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.ok(maxAhead < window_, `never more than the window ahead (was ${maxAhead})`);
  assert.deepEqual(out.writes, Array.from({ length: total }, (_, i) => i));
});

test("a write error stops the workers and rejects once with that error", async () => {
  const total = 200;
  const { fetch, requested } = cdn({ segments: total, delay: () => 1 });
  const { window } = loadFeature(FILE, { fetch });
  const { engine } = engineFor(window, { type: "video" });
  let writes = 0;
  const out = {
    write: async () => {
      if (++writes === 3) throw new Error("disk full");
    },
  };
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out), /disk full/);
    const fetchedAtFailure = requested.length;
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(fetchedAtFailure < 2 + 3 + 12 + 6, `stopped early (${fetchedAtFailure} requests)`);
    assert.equal(requested.length, fetchedAtFailure, "no fetches after the failure");
    assert.equal(writes, 3, "nothing written after the failed write");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a chunk fetch that hangs times out and goes through the retries", async () => {
  const base = cdn({ segments: 3 });
  let hung = 0;
  const fetch = (url, opts = {}) => {
    if (url.endsWith("seg1.ts") && hung++ === 0) {
      // Never answers; only the engine's timeout (its abort signal) ends it.
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(new window.DOMException("aborted", "AbortError")));
      });
    }
    return base.fetch(url, opts);
  };
  const { window } = loadFeature(FILE, { fetch });
  const { engine } = engineFor(window, { type: "video", chunkTimeoutMs: 30 });
  const out = writable();
  await engine.downloadConcurrently(await engine.resolveSegments(BASE + "master.m3u8"), out);
  assert.deepEqual(out.writes, [0, 1, 2]);
  assert.equal(hung, 2, "retried after the timeout");
});

test("tee: one pass writes the video and the extracted audio", async () => {
  const { fetch, requested } = cdn({ segments: 4 });
  const { window } = loadFeature(FILE, { fetch });
  const { engine } = engineFor(window, { type: "video" });
  const video = writable();
  const audio = writable();
  // Stand-in extractor: the "audio" of chunk i is the byte i + 100.
  const extractor = { extract: (raw) => new Uint8Array([new Uint8Array(raw)[0] + 100]) };
  const { segments, separateAudio } = await engine.resolveStream(BASE + "plain.m3u8");
  assert.equal(separateAudio, false);
  await engine.downloadConcurrently(segments, video, null, { writable: audio, extractor });
  assert.deepEqual(video.writes, [0, 1, 2, 3]);
  assert.deepEqual(audio.writes, [100, 101, 102, 103]);
  assert.equal(requested.filter((u) => u.endsWith(".ts")).length, 4, "each segment fetched once");
});
