// ============================================================
// playlistCapture.test.js
// Multi-part lectures: reading the player's playlist panel, and the capture
// job that plays each part once to learn its stream URL.
// The fixture follows the lecture page's playlist panel (heading "Playlist",
// items "Part 1 · 15 minutes", icon fonts as ligature text).
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const FILES = [
  "content/utils/domUtils.js",
  "content/utils/hlsPlaylist.js",
  "content/features/videoDownloader/playlistCapture.js",
];

const PANEL = (items) => `
  <div class="playlist-panel">
    <div class="header"><span>Playlist</span><button>×</button></div>
    <div class="list">
      ${items
        .map(
          ([title, mins]) => `
        <div class="item" data-part="${title}">
          <span class="circle"><i class="material-icons">videocam</i></span>
          <div>
            <div class="title">${title}</div>
            <div class="meta"><i class="cr-icon-clock">schedule</i><span>${mins} minutes</span></div>
          </div>
        </div>`,
        )
        .join("")}
    </div>
  </div>`;

const PLAYER = ({ toggle = true, panel = "" } = {}) => `<!DOCTYPE html><html><body>
  <div class="vp-wrapper">
    <video></video>
    <div class="vp-controls">
      <button id="play" aria-label="Play"></button>
      ${toggle ? '<button id="toggle" title="Toggle playlist (P)"><i class="material-icons">playlist_play</i></button>' : ""}
    </div>
    <div id="slot">${panel}</div>
  </div>
</body></html>`;

const TWO_PARTS = [["Part 1", 15], ["Part 2", 99]];
const FAST = { player: 300, stream: 300, panel: 300, settle: 0 };
const url = (part, file, sig = "s1") => `https://cdn.test/rec/${part}/${file}?Signature=${sig}`;
const MASTER = "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n720p.m3u8\n";
const MEDIA = "#EXTM3U\n#EXTINF:6,\nseg0.ts\n";
const fetchText = async (u) => (u.includes("master") ? MASTER : MEDIA);

test("findPlaylistParts reads labels and durations, skipping icon ligatures", () => {
  const { window } = loadFeature(FILES, { html: PLAYER({ panel: PANEL(TWO_PARTS) }) });
  const parts = window.findPlaylistParts(window.document);
  assert.deepEqual(
    Array.from(parts, (p) => [p.label, p.minutes]),
    [["Part 1", 15], ["Part 2", 99]],
  );
  assert.equal(parts[1].target.className, "title", "click target is the label element");
});

test("findPlaylistParts → [] when no panel is rendered", () => {
  const { window } = loadFeature(FILES, { html: PLAYER() });
  assert.equal(window.findPlaylistParts(window.document).length, 0);
});

test("lectureHasPlaylist: panel count wins; closed panel falls back to the toggle", () => {
  const cases = [
    [PLAYER({ panel: PANEL(TWO_PARTS) }), true],
    [PLAYER({ panel: PANEL([["Part 1", 60]]) }), false],
    [PLAYER({ toggle: true }), true],
    [PLAYER({ toggle: false }), false],
  ];
  for (const [html, expected] of cases) {
    const { window } = loadFeature(FILES, { html });
    assert.equal(window.lectureHasPlaylist(window.document), expected);
  }
});

/**
 * Wire the fixture like a real player: Play loads part 1 (master + a
 * rendition, as players do); the toggle mounts the panel; clicking a part
 * loads its stream unless it's already the one playing.
 */
function fakePlayer(window, { partStreams, panelItems = TWO_PARTS, initialPart = "Part 1" }) {
  const doc = window.document;
  window.HTMLMediaElement.prototype.pause = () => {}; // jsdom: not implemented
  let emit = null;
  let stopped = false;
  let playing = initialPart;
  const load = (part) => {
    (partStreams[part] || []).forEach((u) => emit && emit(u));
  };
  doc.getElementById("play").addEventListener("click", () => load(playing));
  const toggle = doc.getElementById("toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      doc.getElementById("slot").innerHTML = PANEL(panelItems);
      doc.querySelectorAll(".item").forEach((item) =>
        item.addEventListener("click", () => {
          const part = item.getAttribute("data-part");
          if (part === playing) return; // already loaded
          playing = part;
          load(part);
        }),
      );
    });
  }
  const watch = (onUrl) => {
    emit = onUrl;
    return () => {
      emit = null;
      stopped = true;
    };
  };
  return { watch, isStopped: () => stopped };
}

test("capture: each part reports its own master playlist", async () => {
  const { window } = loadFeature(FILES, { html: PLAYER() });
  const player = fakePlayer(window, {
    partStreams: {
      "Part 1": [url(1, "master.m3u8"), url(1, "720p.m3u8")],
      "Part 2": [url(2, "master.m3u8"), url(2, "720p.m3u8")],
    },
  });
  const result = await window.capturePlaylistStreams({
    root: window.document,
    watch: player.watch,
    fetchText,
    timing: FAST,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(
    Array.from(result.parts, (p) => [p.label, p.minutes, p.url]),
    [
      ["Part 1", 15, url(1, "master.m3u8")],
      ["Part 2", 99, url(2, "master.m3u8")],
    ],
  );
  assert.ok(player.isStopped(), "network watch torn down");
});

test("capture: a resumed lecture's playing part gets the stream loaded before the clicks", async () => {
  const { window } = loadFeature(FILES, { html: PLAYER() });
  const player = fakePlayer(window, {
    initialPart: "Part 2",
    partStreams: {
      "Part 1": [url(1, "master.m3u8")],
      "Part 2": [url(2, "master.m3u8"), url(2, "720p.m3u8")],
    },
  });
  const result = await window.capturePlaylistStreams({
    root: window.document,
    watch: player.watch,
    fetchText,
    timing: FAST,
  });
  assert.deepEqual(Array.from(result.parts, (p) => p.url), [url(1, "master.m3u8"), url(2, "master.m3u8")]);
});

test("capture: a part that fails to load never inherits another part's stream", async () => {
  // Part 2 is clicked first and loads nothing; the stream loaded before the
  // clicks belongs to Part 1, which reloads it when clicked — so Part 2 must
  // stay null rather than be handed Part 1's video.
  const { window } = loadFeature(FILES, { html: PLAYER() });
  const player = fakePlayer(window, { partStreams: { "Part 1": [url(1, "master.m3u8")] } });
  const result = await window.capturePlaylistStreams({
    root: window.document,
    watch: player.watch,
    fetchText,
    timing: FAST,
  });
  assert.deepEqual(Array.from(result.parts, (p) => p.url), [url(1, "master.m3u8"), null]);
});

test("capture: a single-video lecture reports one unlabelled part", async () => {
  const { window } = loadFeature(FILES, { html: PLAYER({ toggle: false }) });
  const player = fakePlayer(window, { partStreams: { "Part 1": [url(1, "index.m3u8")] } });
  const result = await window.capturePlaylistStreams({
    root: window.document,
    watch: player.watch,
    fetchText,
    timing: FAST,
  });
  assert.deepEqual(Array.from(result.parts, (p) => [p.label, p.url]), [["", url(1, "index.m3u8")]]);
});

test("capture: no player → a clear failure, and the watch is still torn down", async () => {
  const { window } = loadFeature(FILES, { html: "<!DOCTYPE html><html><body><p>login</p></body></html>" });
  let stopped = false;
  const result = await window.capturePlaylistStreams({
    root: window.document,
    watch: () => () => {
      stopped = true;
    },
    fetchText,
    timing: { ...FAST, player: 50 },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /player never appeared/);
  assert.ok(stopped);
});

// ── Scaler's real markup (tests/fixtures/scaler-player.html) ─────────────────

const REAL = require("fs").readFileSync(require("path").join(__dirname, "fixtures/scaler-player.html"), "utf8");
const [REAL_PANEL, REAL_CONTROLS] = REAL.replace(/<!--[\s\S]*?-->/, "").trim().split("\n");

test("real Scaler markup: the open playlist panel reads as Part 1 · 15 / Part 2 · 99", () => {
  const { window } = loadFeature(FILES, { html: `<!DOCTYPE html><html><body>${REAL_PANEL}${REAL_CONTROLS}</body></html>` });
  const parts = window.findPlaylistParts(window.document);
  assert.deepEqual(Array.from(parts, (p) => [p.label, p.minutes]), [["Part 1", 15], ["Part 2", 99]]);
  assert.equal(parts[1].target.localName, "h3", "click goes to the item's title");
  assert.equal(window.lectureHasPlaylist(window.document), true);
});

test("real Scaler markup: panel closed → the unlabelled icon-playlist control still counts", () => {
  const { window } = loadFeature(FILES, { html: `<!DOCTYPE html><html><body>${REAL_CONTROLS}</body></html>` });
  const toggle = window.findPlaylistToggle(window.document);
  assert.ok(toggle && toggle.querySelector("i.icon-playlist"), "the <a> wrapping i.icon-playlist");
  assert.equal(window.lectureHasPlaylist(window.document), true);
});

test("real Scaler markup: Play is the play toggle while it shows the play icon, never while playing", () => {
  const html = `<!DOCTYPE html><html><body>${REAL_CONTROLS}</body></html>`;
  const { window } = loadFeature(FILES, { html });
  assert.equal(window.findPlayControl(window.document).getAttribute("data-cy"), "video-player-play-toggle");

  const playing = loadFeature(FILES, { html: html.replace('<i class="icon-play">', '<i class="icon-pause">') }).window;
  assert.equal(playing.findPlayControl(playing.document), null, "a pause button is not clicked");
});
