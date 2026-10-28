// ============================================================
// transcriptProcessor.test.js
// The same-model prompt: before a run spends API credits, a lecture that
// already has a version from the same model offers that version instead.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { EXTENSION_ROOT, loadFeature, makeChrome, makeFetch, readFeature, tick } = require("./helpers/harness");

const DIR = "content/features/videoDownloader";
const PAGE_HTML = fs.readFileSync(path.join(EXTENSION_ROOT, DIR, "transcriptProcessor.html"), "utf8");
const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const PAGE_URL =
  "https://ext.test/transcriptProcessor.html?url=https%3A%2F%2Fcdn.test%2Fmaster.m3u8" +
  "&type=transcript&title=Lecture&lectureSlug=lecture-slug&classId=";

const version = (extra) => ({
  versionId: "v-best",
  provider: "groq",
  model: "whisper-large-v3-turbo",
  upvotes: 2,
  downvotes: 0,
  downloadCount: 7,
  createdAt: "2026-10-20T10:00:00Z",
  ...extra,
});

/**
 * Load the processor page with Groq configured (blank model field → the
 * default whisper-large-v3-turbo) and a fake worker serving `versions`.
 * `choice` is what the user picks in the dialog ("" = dismissed with Esc).
 */
function loadProcessor({ versions, choice }) {
  const sent = [];
  const fetched = [];
  const downloads = [];
  const chrome = makeChrome({
    localStore: {
      scaler_transcript_config: {
        provider: "groq",
        providers: { groq: { baseUrl: GROQ_URL, model: "", apiKey: "gsk_test" } },
      },
    },
    syncStore: { scaler_user: { email: "me@example.com" } },
    sendMessage: (msg, cb) => {
      sent.push(msg);
      const reply = {
        getTranscriptVersions: { success: true, data: { versions } },
        getTranscriptVersion: { success: true, data: { text: "cached transcript text" } },
        recordVersionDownload: { success: true, data: { downloadCount: 8 } },
      }[msg.action];
      if (typeof cb === "function") cb(reply);
    },
  });
  // Every provider call fails the key check — enough to see whether a run
  // went on to spend credits.
  const fetch = makeFetch((url) => {
    fetched.push(url);
    return { status: 401, text: "invalid key" };
  });
  // The page's <script> tags share one global scope (top-level `class` and
  // `const` included), which separate evals would not — so evaluate them as
  // one bundle, in the page's order.
  const { window } = loadFeature([], { html: PAGE_HTML, url: PAGE_URL, chrome, fetch });
  window.eval(
    ["tsAudioExtractor.js", "customAudioTranscriber.js", "transcriptRanking.js", "transcriptProcessor.js"]
      .map((f) => readFeature(`${DIR}/${f}`))
      .join("\n;\n"),
  );

  window.URL.createObjectURL = () => "blob:test";
  window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {
    downloads.push(this.download);
  };

  const dialog = window.document.getElementById("cache-dialog");
  let shown = 0;
  // jsdom has no showModal; answer the way the user would.
  dialog.showModal = function () {
    shown += 1;
    setTimeout(() => {
      this.returnValue = choice;
      this.dispatchEvent(new window.Event("close"));
    });
  };

  return { window, sent, fetched, downloads, shownCount: () => shown };
}

async function start(window) {
  window.document.getElementById("start-btn").click();
  // Let the async handler run to the end (it re-enables the button).
  for (let i = 0; i < 40; i++) {
    await tick(10);
    if (!window.document.getElementById("start-btn").disabled) break;
  }
}

const hitProvider = (fetched) => fetched.some((u) => u.includes("api.groq.com"));

test("same model already transcribed + 'Download cached' → cached file, no credits spent", async () => {
  const p = loadProcessor({ versions: [version()], choice: "cached" });
  await start(p.window);

  assert.equal(p.shownCount(), 1, "prompt shown");
  assert.ok(!hitProvider(p.fetched), "provider never called");
  assert.deepEqual(p.downloads, ["Lecture.txt"], "cached transcript handed over as a file");
  assert.ok(
    p.sent.some((m) => m.action === "getTranscriptVersion" && m.versionId === "v-best"),
    "the matching version's text was fetched",
  );
  assert.ok(
    p.sent.some((m) => m.action === "recordVersionDownload" && m.versionId === "v-best"),
    "the version counts its download",
  );
  const track = p.sent.find((m) => m.action === "trackDownload");
  assert.equal(track.source, "cache");
  assert.equal(track.versionId, "v-best", "report names the version so it isn't counted twice");
});

test("same model already transcribed + 'Transcribe anyway' → the run goes ahead", async () => {
  const p = loadProcessor({ versions: [version()], choice: "generate" });
  await start(p.window);

  assert.equal(p.shownCount(), 1, "prompt shown");
  assert.ok(hitProvider(p.fetched), "went on to the provider key check");
  assert.equal(p.downloads.length, 0);
});

test("dismissing the prompt cancels the run", async () => {
  const p = loadProcessor({ versions: [version()], choice: "" });
  await start(p.window);

  assert.ok(!hitProvider(p.fetched), "nothing spent");
  assert.equal(p.downloads.length, 0);
  assert.equal(p.window.document.getElementById("status-text").innerText, "Ready to transcribe.");
});

test("versions from other models (or none recorded) don't trigger the prompt", async () => {
  const p = loadProcessor({
    versions: [version({ model: "whisper-large-v3" }), version({ versionId: "legacy", model: "" })],
    choice: "cached",
  });
  await start(p.window);

  assert.equal(p.shownCount(), 0, "no prompt");
  assert.ok(hitProvider(p.fetched), "generation proceeds straight away");
});
