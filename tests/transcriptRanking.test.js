const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const FILE = "content/features/videoDownloader/transcriptRanking.js";

const v = (id, extra = {}) => ({
  versionId: id,
  upvotes: 0,
  downvotes: 0,
  downloadCount: 0,
  createdAt: "2026-09-01T00:00:00Z",
  ...extra,
});
const ids = (list) => Array.from(list, (x) => x.versionId);

test("rankTranscriptVersions: net votes, then downloads, then recency", () => {
  const { window } = loadFeature(FILE);
  const ranked = window.rankTranscriptVersions([
    v("old-popular", { downloadCount: 9 }),
    v("voted", { upvotes: 3, downvotes: 1 }),
    v("downvoted", { downvotes: 2, downloadCount: 50 }),
    v("new-popular", { downloadCount: 9, createdAt: "2026-10-01T00:00:00Z" }),
  ]);
  assert.deepEqual(ids(ranked), ["voted", "new-popular", "old-popular", "downvoted"]);
});

test("rankTranscriptVersions does not reorder its input", () => {
  const { window } = loadFeature(FILE);
  const input = [v("a"), v("b", { upvotes: 1 })];
  window.rankTranscriptVersions(input);
  assert.deepEqual(ids(input), ["a", "b"]);
});

test("findSameModelVersions ignores case and surrounding whitespace", () => {
  const { window } = loadFeature(FILE);
  const found = window.findSameModelVersions(
    [
      v("turbo", { model: " Whisper-Large-V3-Turbo " }),
      v("v3", { model: "whisper-large-v3" }),
      v("turbo-voted", { model: "whisper-large-v3-turbo", upvotes: 2 }),
    ],
    "whisper-large-v3-turbo",
  );
  assert.deepEqual(ids(found), ["turbo-voted", "turbo"], "same model only, best first");
});

test("a version with no recorded model never matches", () => {
  const { window } = loadFeature(FILE);
  const versions = [v("legacy", { model: "" }), v("null-model", { model: null })];
  assert.equal(window.findSameModelVersions(versions, "nova-3").length, 0);
  assert.equal(window.findSameModelVersions(versions, "").length, 0, "nothing matches a blank model");
});
