const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome } = require("./helpers/harness");

const FEATURE = "content/features/revisionTracker.js";

function makeApiProblem(overrides = {}) {
  return {
    ib_problem_id: 1001,
    title: "Two Sum",
    status: "solved",
    type: "assignment",
    sbat_id: 500,
    ...overrides,
  };
}

function makeLogEntry(overrides = {}) {
  const now = Date.now();
  return {
    title: "Two Sum",
    url: "https://www.scaler.com/academy/mentee-dashboard/class/500/assignment/problems/1001",
    solvedAt: now - 2 * 86400000,
    intervals: [1, 3, 7, 14, 30],
    stage: 0,
    nextDue: now - 86400000,
    ...overrides,
  };
}

function load() {
  return loadFeature(FEATURE, {
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "revision-tracker": true },
    },
  });
}

test("_detectNewSolves: solved problem absent from log → detected", () => {
  const { window } = load();
  const problems = [makeApiProblem()];
  const log = {};
  const result = window._detectNewSolves(problems, log);
  assert.equal(result.length, 1);
  assert.equal(result[0].ib_problem_id, 1001);
});

test("_detectNewSolves: already in log → not detected", () => {
  const { window } = load();
  const problems = [makeApiProblem()];
  const log = { "1001": makeLogEntry() };
  const result = window._detectNewSolves(problems, log);
  assert.equal(result.length, 0);
});

test("_detectNewSolves: unsolved problem → not detected", () => {
  const { window } = load();
  const problems = [makeApiProblem({ status: "unsolved" })];
  const result = window._detectNewSolves(problems, {});
  assert.equal(result.length, 0);
});

test("_buildEntry: builds correct entry with stage 0 and nextDue 1 day out", () => {
  const { window } = load();
  const before = Date.now();
  const entry = window._buildEntry(makeApiProblem());
  const after = Date.now();
  assert.equal(entry.stage, 0);
  assert.ok(entry.nextDue >= before + 86400000);
  assert.ok(entry.nextDue <= after + 86400000);
  assert.equal(entry.title, "Two Sum");
  assert.ok(entry.url.includes("1001"));
  assert.deepEqual(Array.from(entry.intervals), [1, 3, 7, 14, 30]);
});

test("_buildEntry: homework type uses 'homework' in URL", () => {
  const { window } = load();
  const entry = window._buildEntry(makeApiProblem({ type: "homework", ib_problem_id: 2002, sbat_id: 600 }));
  assert.ok(entry.url.includes("homework"));
  assert.ok(entry.url.includes("2002"));
});

test("_getDueToday: overdue entry included", () => {
  const { window } = load();
  const log = { "1001": makeLogEntry({ nextDue: Date.now() - 1 }) };
  const due = window._getDueToday(log);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, "1001");
});

test("_getDueToday: future entry excluded", () => {
  const { window } = load();
  const log = { "1001": makeLogEntry({ nextDue: Date.now() + 86400000 }) };
  const due = window._getDueToday(log);
  assert.equal(due.length, 0);
});

test("_advanceStage: increments stage and recalculates nextDue", () => {
  const { window } = load();
  const entry = makeLogEntry({ stage: 0, intervals: [1, 3, 7, 14, 30] });
  const updated = window._advanceStage(entry);
  assert.equal(updated.stage, 1);
  // nextDue should be ~3 days from now
  assert.ok(updated.nextDue > Date.now() + 2 * 86400000);
  assert.ok(updated.nextDue < Date.now() + 4 * 86400000);
});

test("_advanceStage: returns null after last interval (graduation)", () => {
  const { window } = load();
  const entry = makeLogEntry({ stage: 4, intervals: [1, 3, 7, 14, 30] });
  const result = window._advanceStage(entry);
  assert.equal(result, null);
});
