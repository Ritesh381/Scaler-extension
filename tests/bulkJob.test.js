const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const FILE = "content/features/bulkDownload/bulkJob.js";
const plain = (x) => JSON.parse(JSON.stringify(x));
const hashOf = (job) => "#" + encodeURIComponent(JSON.stringify(job));

test("parseBulkJob normalises the job and drops lectures without a class id", () => {
  const { window } = loadFeature(FILE);
  const job = window.parseBulkJob(
    hashOf({
      subject: "DevOps",
      types: { transcript: true, video: 1 },
      sourceTabId: 7,
      lectures: [
        { index: 2, classId: "101", title: "Linux", stamp: "13 AUG | 09:35 AM", url: "u" },
        { index: 3, classId: null, title: "no id" },
        { classId: "javascript:alert(1)" },
      ],
    }),
  );
  assert.deepEqual(plain(job), {
    subject: "DevOps",
    types: { transcript: true, video: true, audio: false },
    generateMissing: false,
    sourceTabId: 7,
    lectures: [{ index: 2, classId: "101", title: "Linux", stamp: "13 AUG | 09:35 AM", url: "u" }],
  });
});

test("parseBulkJob → null for anything unusable", () => {
  const { window } = loadFeature(FILE);
  for (const hash of ["", "#", "#not-json", hashOf({ lectures: [] }), hashOf({ lectures: [{ classId: "x" }] })]) {
    assert.equal(window.parseBulkJob(hash), null, hash);
  }
});

test("bulkFileName: number, date, title, part — safe on every OS", () => {
  const { window } = loadFeature(FILE);
  const lecture = { index: 3, stamp: "18 AUG | 03:45 PM", title: 'CI/CD: "GitHub" Actions?', classId: "9" };
  assert.equal(window.bulkFileName(lecture, "txt"), "03 - 18 Aug - CI CD GitHub Actions.txt");
  assert.equal(window.bulkFileName(lecture, "mp4", "Part 2"), "03 - 18 Aug - CI CD GitHub Actions – Part 2.mp4");
  assert.equal(
    window.bulkFileName({ index: 12, stamp: "", title: "  ", classId: "77" }, "mp3"),
    "12 - Lecture 77.mp3",
    "missing date and title still give a usable name",
  );
});

test("bulkSafeName strips reserved/control characters, trailing dots, and caps length", () => {
  const { window } = loadFeature(FILE);
  assert.equal(window.bulkSafeName("a/b\\c\u0007d..."), "a b c d");
  assert.equal(window.bulkSafeName("x".repeat(200)).length, 120);
});

test("runWithConcurrency: never more than `limit` at once, every item once", async () => {
  const { window } = loadFeature(FILE);
  let active = 0;
  let peak = 0;
  const done = [];
  await window.runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5 * (6 - n)));
    done.push(n);
    active--;
  });
  assert.equal(peak, 2);
  assert.deepEqual([...done].sort(), [1, 2, 3, 4, 5]);
});

test("runWithConcurrency: a failing item doesn't stop the rest; abort stops new ones", async () => {
  const { window } = loadFeature(FILE);
  const seen = [];
  await window.runWithConcurrency([1, 2, 3], 1, async (n) => {
    seen.push(n);
    if (n === 1) throw new Error("boom");
  });
  assert.deepEqual(seen, [1, 2, 3]);

  const controller = new window.AbortController();
  const started = [];
  await window.runWithConcurrency(
    [1, 2, 3],
    1,
    async (n) => {
      started.push(n);
      controller.abort();
    },
    controller.signal,
  );
  assert.deepEqual(started, [1], "nothing starts after abort");
});
