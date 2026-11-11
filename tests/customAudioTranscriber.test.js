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

// ── Empty transcription is a result, not a failure ──────────────────────
// Whisper returns "" for a chunk that carries no speech (background noise,
// music, a slide left on screen). That chunk is above the silence threshold,
// so it is genuinely sent to the model and genuinely answered. Treating the
// empty answer as a failed request made a perfectly good 9,400-word lecture
// refuse to save itself to the cache.

test("transcribe(): a chunk that legitimately transcribes to empty is not a failure", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  t._prepareWavBlobs = async () => [
    { blob: "wav0", peak: 0.4 },
    { blob: "wav1", peak: 0.3 }, // audible, but no speech in it
  ];
  t._transcribeOpenAICompatible = async (blob) =>
    blob === "wav0" ? "Hello everyone." : "";

  const result = await t.transcribe(new ArrayBuffer(8));

  assert.equal(result.hasFailures, false, "an empty model answer is not a failure");
  assert.match(result.text, /Hello everyone\./);
});

test("transcribe(): a chunk whose every attempt throws IS a failure", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  t._prepareWavBlobs = async () => [
    { blob: "wav0", peak: 0.4 },
    { blob: "wav1", peak: 0.3 },
  ];
  let attempts = 0;
  t._transcribeOpenAICompatible = async (blob) => {
    if (blob === "wav0") return "Hello everyone.";
    attempts++;
    throw new Error("HTTP 500");
  };

  const result = await t.transcribe(new ArrayBuffer(8));

  assert.equal(attempts, 3, "a throwing chunk exhausts its retries");
  assert.equal(result.hasFailures, true);
  assert.match(result.text, /Hello everyone\./);
});

test("resolveModel: a typed model always wins (trimmed)", () => {
  const CAT = loadClass();
  assert.equal(CAT.resolveModel("https://api.groq.com/openai/v1/audio/transcriptions", " whisper-large-v3 "), "whisper-large-v3");
});

test("resolveModel: a blank field resolves to the default the request will use", () => {
  const CAT = loadClass();
  assert.equal(CAT.resolveModel("https://api.groq.com/openai/v1/audio/transcriptions", ""), "whisper-large-v3-turbo");
  assert.equal(CAT.resolveModel("https://api.deepgram.com/v1/listen", ""), "nova-3");
  assert.equal(CAT.resolveModel("https://api.elevenlabs.io/v1/speech-to-text", "  "), "scribe_v2");
  assert.equal(CAT.resolveModel("https://api.openai.com/v1/audio/transcriptions", undefined), "gpt-transcribe");
  assert.equal(CAT.resolveModel("https://my-custom-host/transcribe", ""), "gpt-transcribe");
});

// ── transcribeFromSegments: decode → upload streaming ─────────────────────

/** 450 one-byte segments = 3 batches of ≤200; batch b decodes to two blobs. */
function streamingFixture(CAT, { failBatch = -1 } = {}) {
  const t = makeTranscriber(CAT);
  let batchNo = 0;
  t._prepareWavBlobs = async () => {
    const b = batchNo++;
    if (b === failBatch) throw new Error("bad audio");
    return [
      { blob: `b${b}-0`, peak: 0.5 },
      { blob: `b${b}-1`, peak: 0.5 },
    ];
  };
  // Later chunks answer faster, so out-of-order completion is exercised.
  t._transcribeOpenAICompatible = async (blob) => {
    const [b, i] = blob.slice(1).split("-").map(Number);
    await new Promise((r) => setTimeout(r, (6 - (b * 2 + i)) * 3));
    return `${blob}.`;
  };
  const segments = Array.from({ length: 450 }, () => new Uint8Array([1]));
  return { t, segments };
}

test("transcribeFromSegments: streamed batches keep the text in order and free consumed segments", async () => {
  const CAT = loadClass();
  const { t, segments } = streamingFixture(CAT);
  const progress = [];
  const result = await t.transcribeFromSegments(segments, (pct, done, total) => progress.push([pct, done, total]));
  assert.equal(result.text, "b0-0. b0-1. b1-0. b1-1. b2-0. b2-1.");
  assert.equal(result.hasFailures, false);
  assert.ok(segments.every((s) => s === null), "consumed segments released");
  assert.deepEqual(Array.from(progress[progress.length - 1]), [100, 6, 6]);
  assert.ok(progress.every(([pct]) => pct <= 100));
});

test("transcribeFromSegments: an undecodable stretch marks the result as having failures", async () => {
  const CAT = loadClass();
  // Batch 1 fails whole and in both halves (calls 1, 2, 3); batch 2 is call 4.
  const t = makeTranscriber(CAT);
  let call = 0;
  t._prepareWavBlobs = async () => {
    const c = call++;
    if (c >= 1 && c <= 3) throw new Error("bad audio");
    return [{ blob: `c${c}`, peak: 0.5 }];
  };
  t._transcribeOpenAICompatible = async (blob) => `${blob}.`;
  const segments = Array.from({ length: 450 }, () => new Uint8Array([1]));
  const result = await t.transcribeFromSegments(segments);
  assert.equal(result.text, "c0. c4.");
  assert.equal(result.hasFailures, true, "a gap must not be cached as complete");
});

test("transcribeFromSegments: an empty batch is a gap, not silently skipped", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  t._prepareWavBlobs = async () => [{ blob: "w", peak: 0.5 }];
  t._transcribeOpenAICompatible = async () => "Hello.";
  const segments = [
    ...Array.from({ length: 200 }, () => new Uint8Array([1])),
    ...Array.from({ length: 200 }, () => new Uint8Array(0)),
  ];
  const result = await t.transcribeFromSegments(segments);
  assert.equal(result.hasFailures, true);
});

test("transcribeFromSegments: all-silent audio still throws without calling the model", async () => {
  const CAT = loadClass();
  const t = makeTranscriber(CAT);
  t._prepareWavBlobs = async () => [{ blob: "w", peak: 0.0001 }];
  let called = 0;
  t._transcribeOpenAICompatible = async () => {
    called++;
    return "Thank you.";
  };
  await assert.rejects(() => t.transcribeFromSegments([new Uint8Array([1])]), /silent/i);
  assert.equal(called, 0);
});
