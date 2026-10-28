// ============================================================
// transcriptParts.test.js
// The transcript processor's handling of multi-part lectures: which streams
// it reads from its URL, and how the parts' texts become one transcript.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EXTENSION_ROOT, loadFeature, makeChrome, makeFetch, readFeature, tick } = require("./helpers/harness");

const DIR = "content/features/videoDownloader";
const PAGE_HTML = fs.readFileSync(path.join(EXTENSION_ROOT, DIR, "transcriptProcessor.html"), "utf8");

function loadPage(query, { chrome, fetch, alerts } = {}) {
  const { window } = loadFeature([], {
    html: PAGE_HTML,
    url: `https://ext.test/transcriptProcessor.html?${query}`,
    chrome,
    fetch,
  });
  if (alerts) window.alert = (msg) => alerts.push(msg);
  // The page's <script> tags share one global scope; evaluate them as one.
  window.eval(
    ["tsAudioExtractor.js", "customAudioTranscriber.js", "transcriptHeader.js", "transcriptProcessor.js"]
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

// ── Bulk mode: opened by the bulk download page in a background tab ─────────

function bulkChrome(config) {
  const sent = [];
  const chrome = makeChrome({
    localStore: config ? { scaler_transcript_config: config } : {},
    sendMessage: (msg, cb) => {
      sent.push(msg);
      if (typeof cb === "function") cb({});
    },
  });
  return { chrome, sent };
}

async function settle(sent) {
  for (let i = 0; i < 40 && !sent.some((m) => m.type === "BULK_TRANSCRIPT_DONE"); i++) await tick(10);
  return sent.find((m) => m.type === "BULK_TRANSCRIPT_DONE");
}

test("bulk mode starts on its own and reports a missing API key instead of alerting", async () => {
  const { chrome, sent } = bulkChrome(null);
  const alerts = [];
  loadPage(q({ url: PARTS[0].url, classId: "42", mode: "bulk" }), { chrome, alerts });
  const done = await settle(sent);
  assert.ok(done, "result reported");
  assert.equal(done.ok, false);
  assert.equal(done.classId, "42");
  assert.match(done.error, /No API key saved/);
  assert.equal(alerts.length, 0, "no alert in a background tab");
});

test("bulk mode reports a run that stops early (bad key) exactly once", async () => {
  const { chrome, sent } = bulkChrome({
    provider: "groq",
    providers: { groq: { baseUrl: "https://api.groq.com/openai/v1/audio/transcriptions", model: "", apiKey: "bad" } },
  });
  const fetch = makeFetch(() => ({ status: 401, text: "invalid key" }));
  loadPage(q({ url: PARTS[0].url, classId: "42", mode: "bulk" }), { chrome, fetch, alerts: [] });
  const done = await settle(sent);
  await tick(20);
  assert.equal(done.ok, false);
  assert.match(done.error, /API Key/i);
  assert.equal(sent.filter((m) => m.type === "BULK_TRANSCRIPT_DONE").length, 1);
});

test("outside bulk mode nothing starts by itself", async () => {
  const { chrome, sent } = bulkChrome(null);
  loadPage(q({ url: PARTS[0].url, classId: "42" }), { chrome, alerts: [] });
  await tick(50);
  assert.equal(sent.filter((m) => m.type === "BULK_TRANSCRIPT_DONE").length, 0);
});
