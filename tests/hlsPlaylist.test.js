const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const FILE = "content/utils/hlsPlaylist.js";

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio/index.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"
720p/index.m3u8
`;
const MEDIA = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXT-X-ENDLIST
`;

test("hlsIsMasterPlaylist tells masters from media playlists", () => {
  const { window } = loadFeature(FILE);
  assert.equal(window.hlsIsMasterPlaylist(MASTER), true);
  assert.equal(window.hlsIsMasterPlaylist(MEDIA), false);
  assert.equal(window.hlsIsMasterPlaylist(null), false);
});

test("hlsStreamKey ignores the signed query", () => {
  const { window } = loadFeature(FILE);
  assert.equal(
    window.hlsStreamKey("https://cdn.test/rec/1/master.m3u8?Policy=a&Signature=b"),
    window.hlsStreamKey("https://cdn.test/rec/1/master.m3u8?Policy=c&Signature=d"),
  );
  assert.notEqual(
    window.hlsStreamKey("https://cdn.test/rec/1/master.m3u8"),
    window.hlsStreamKey("https://cdn.test/rec/2/master.m3u8"),
  );
});

test("hlsChooseTopLevelStream prefers the master over its renditions", () => {
  const { window } = loadFeature(FILE);
  const chosen = window.hlsChooseTopLevelStream([
    { url: "https://cdn.test/rec/1/720p/index.m3u8", text: MEDIA },
    { url: "https://cdn.test/rec/1/master.m3u8", text: MASTER },
    { url: "https://cdn.test/rec/1/audio/index.m3u8", text: MEDIA },
  ]);
  assert.equal(chosen, "https://cdn.test/rec/1/master.m3u8");
});

test("hlsChooseTopLevelStream without a master takes the first request; nothing → null", () => {
  const { window } = loadFeature(FILE);
  assert.equal(
    window.hlsChooseTopLevelStream([
      { url: "https://cdn.test/a.m3u8", text: MEDIA },
      { url: "https://cdn.test/b.m3u8", text: null },
    ]),
    "https://cdn.test/a.m3u8",
  );
  assert.equal(window.hlsChooseTopLevelStream([]), null);
});
