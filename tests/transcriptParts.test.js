// ============================================================
// transcriptParts.test.js
// The transcript processor's handling of multi-part lectures: which streams
// it reads from its URL, and how the parts' texts become one transcript.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EXTENSION_ROOT, loadFeature, readFeature } = require("./helpers/harness");

const DIR = "content/features/videoDownloader";
const PAGE_HTML = fs.readFileSync(path.join(EXTENSION_ROOT, DIR, "transcriptProcessor.html"), "utf8");

function loadPage(query) {
  const { window } = loadFeature([], {
    html: PAGE_HTML,
    url: `https://ext.test/transcriptProcessor.html?${query}`,
  });
  // The page's <script> tags share one global scope; evaluate them as one.
  window.eval(
    ["tsAudioExtractor.js", "customAudioTranscriber.js", "transcriptProcessor.js"]
      .map((f) => readFeature(`${DIR}/${f}`))
      .join("\n;\n"),
  );
  return window;
}

const PARTS = [
  { label: "Part 1", url: "https://cdn.test/1/master.m3u8" },
  { label: "Part 2", url: "https://cdn.test/2/master.m3u8" },
];
const q = (o) => new URLSearchParams(o).toString();
const plain = (x) => JSON.parse(JSON.stringify(x));

test("a multi-part lecture lists every part's stream and stays startable", () => {
  const window = loadPage(q({ url: PARTS[0].url, parts: JSON.stringify(PARTS), lectureSlug: "s" }));
  // log() writes each line with innerText, which jsdom keeps as a plain property.
  const logs = Array.from(window.document.getElementById("logs").children, (d) => d.innerText).join("\n");
  assert.match(logs, /Multi-part lecture: 2 parts/);
  assert.match(logs, /Stream \(Part 1\): https:\/\/cdn\.test\/1/);
  assert.match(logs, /Stream \(Part 2\): https:\/\/cdn\.test\/2/);
  assert.equal(window.document.getElementById("start-btn").disabled, false);
});

test("parseStreamParts: valid parts win; anything malformed falls back to the single url", () => {
  const window = loadPage(q({ url: "https://cdn.test/single.m3u8" }));
  const single = [{ label: "", url: "https://cdn.test/single.m3u8" }];
  assert.deepEqual(plain(window.parseStreamParts(JSON.stringify(PARTS), "x")), PARTS);
  assert.deepEqual(
    plain(window.parseStreamParts(JSON.stringify([{ url: "a" }, { url: "b" }]), "x")),
    [{ label: "Part 1", url: "a" }, { label: "Part 2", url: "b" }],
    "missing labels are numbered",
  );
  assert.deepEqual(plain(window.parseStreamParts("not json", single[0].url)), single);
  assert.deepEqual(plain(window.parseStreamParts(JSON.stringify([{ label: "x" }]), single[0].url)), single);
  assert.deepEqual(plain(window.parseStreamParts(null, "")), []);
});

test("no stream at all disables Start", () => {
  const window = loadPage(q({ lectureSlug: "s" }));
  assert.equal(window.document.getElementById("start-btn").disabled, true);
});

test("joinPartTranscripts: one part unchanged, several under part headings", () => {
  const window = loadPage(q({ url: "https://cdn.test/single.m3u8" }));
  assert.equal(window.joinPartTranscripts([{ label: "" }], ["just text"]), "just text");
  assert.equal(
    window.joinPartTranscripts(PARTS, [" first part \n", "second part"]),
    "===== Part 1 =====\n\nfirst part\n\n===== Part 2 =====\n\nsecond part",
  );
});
