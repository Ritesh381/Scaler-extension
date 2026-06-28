// ============================================================
// customAudioTranscriber.test.js
// Tests the silent-audio safeguards added to CustomAudioTranscriber:
//   - all-silent audio fails loudly instead of returning hallucinated filler
//   - individual silent chunks are skipped (not sent to the model)
//   - audible chunks are still transcribed and joined
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { JSDOM } = require("jsdom");

const EXTENSION_ROOT = path.resolve(__dirname, "..", "extension-main");
const SRC = fs.readFileSync(
  path.join(EXTENSION_ROOT, "content/features/videoDownloader/customAudioTranscriber.js"),
  "utf8",
);

function loadClass() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    runScripts: "outside-only",
  });
  // class declarations don't attach to globalThis automatically, so export it
  // explicitly from within the same eval scope.
  dom.window.eval(SRC + "\n;globalThis.CustomAudioTranscriber = CustomAudioTranscriber;");
  return dom.window.CustomAudioTranscriber;
}

// A non-provider-specific base URL routes through _transcribeOpenAICompatible,
// which we stub per-instance below.
function makeTranscriber(CustomAudioTranscriber) {
  return new CustomAudioTranscriber("https://my-custom-host/transcribe", "key-123", "whisper-1");
}

test("_isAllSilent: true when every chunk is below the silence threshold", () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  assert.equal(t._isAllSilent([{ peak: 0.0001 }, { peak: 0.002 }, { peak: 0.0 }]), true);
});

test("_isAllSilent: false when any chunk has audible peak", () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  assert.equal(t._isAllSilent([{ peak: 0.0001 }, { peak: 0.5 }]), false);
});

test("_isAllSilent: false for an empty set (nothing decoded yet)", () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  assert.equal(t._isAllSilent([]), false);
});

test("transcribe(): all-silent audio throws instead of returning filler", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  // Simulate the bug scenario: decode succeeds but every chunk is silent.
  t._prepareWavBlobs = async () => [
    { blob: "wav0", peak: 0.0 },
    { blob: "wav1", peak: 0.0005 },
  ];
  let called = 0;
  t._transcribeOpenAICompatible = async () => {
    called++;
    return "Thank you.";
  };

  await assert.rejects(() => t.transcribe(new ArrayBuffer(8)), /silent/i);
  assert.equal(called, 0, "model must not be called on silent audio");
});

test("transcribe(): silent chunks are skipped, audible chunks transcribed", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  // chunk 0 audible, chunk 1 silent, chunk 2 audible
  t._prepareWavBlobs = async () => [
    { blob: "wav0", peak: 0.4 },
    { blob: "wav1", peak: 0.001 },
    { blob: "wav2", peak: 0.3 },
  ];
  const sentBlobs = [];
  t._transcribeOpenAICompatible = async (blob) => {
    sentBlobs.push(blob);
    return blob === "wav0" ? "Hello everyone." : "Today we cover graphs.";
  };

  const result = await t.transcribe(new ArrayBuffer(8));

  assert.deepEqual(sentBlobs.sort(), ["wav0", "wav2"], "only audible chunks sent to model");
  assert.equal(result.silentChunks, 1);
  assert.equal(result.hasFailures, false);
  assert.match(result.text, /Hello everyone\./);
  assert.match(result.text, /Today we cover graphs\./);
});
