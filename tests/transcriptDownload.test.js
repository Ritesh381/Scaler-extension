// ============================================================
// transcriptDownload.test.js
// The transcript page's audio download (downloadPartAudio) runs on the shared
// HLS engine: lightest variant with audio, direct fetch, and a count of the
// segments that never arrived — each one a gap that must keep the transcript
// out of the cache.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EXTENSION_ROOT, loadFeature, readFeature } = require("./helpers/harness");

const DIR = "content/features/videoDownloader";
const PAGE_HTML = fs.readFileSync(path.join(EXTENSION_ROOT, DIR, "transcriptProcessor.html"), "utf8");
const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1200000,CODECS="avc1.4d401f,mp4a.40.2"
720p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=400000,CODECS="avc1.4d401e,mp4a.40.2"
360p/index.m3u8
`;
const MEDIA = "#EXTM3U\n" + [0, 1, 2].map((i) => `#EXTINF:6,\nseg${i}.ts`).join("\n") + "\n#EXT-X-ENDLIST\n";

function loadPage(fetch) {
  const { window } = loadFeature([], {
    html: PAGE_HTML,
    url: "https://ext.test/transcriptProcessor.html?url=https%3A%2F%2Fcdn.test%2Fmaster.m3u8&type=transcript",
    fetch,
  });
  window.eval(
    [
      "tsAudioExtractor.js",
      "hlsDownloadEngine.js",
      "transcriptHeader.js",
      "customAudioTranscriber.js",
      "transcriptProviderConfig.js",
      "transcriptRanking.js",
      "transcriptProcessor.js",
    ]
      .map((f) => readFeature(`${DIR}/${f}`))
      .join("\n;\n"),
  );
  return window;
}

test("downloadPartAudio: lightest variant, one entry per segment, failed fetches counted", async () => {
  const requested = [];
  const fetch = async (url) => {
    requested.push(url);
    if (url.endsWith("master.m3u8")) return { ok: true, status: 200, text: async () => MASTER };
    if (url.endsWith("index.m3u8")) return { ok: true, status: 200, text: async () => MEDIA };
    if (url.endsWith("seg1.ts")) return { ok: false, status: 403 };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array(188).buffer };
  };
  const window = loadPage(fetch);
  const { audioSegments, fetchFailures } = await window.downloadPartAudio("https://cdn.test/master.m3u8");
  assert.equal(fetchFailures, 1, "the 403 segment is reported, not just logged");
  assert.equal(audioSegments.length, 3, "indices stay aligned");
  assert.ok(requested.some((u) => u.includes("/360p/")), "audio comes from the 360p variant");
  assert.ok(!requested.some((u) => u.includes("/720p/")), "the 720p variant is never fetched");
});
