const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, makeFetch, tick } = require("./helpers/harness");

const FEATURE = "content/features/revisionTracker.js";

const REVISION_LOG_KEY = "scalerpp_revision_log";
const REVISION_SEEDED_KEY = "scalerpp_revision_seeded";

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

// ─── _getProblemTitle ─────────────────────────────────────────

test("_getProblemTitle: uses name field when present", () => {
  const { window } = load();
  assert.equal(window._getProblemTitle({ name: "Binary Search", ib_problem_id: 1 }), "Binary Search");
});

test("_getProblemTitle: falls back to problem_name", () => {
  const { window } = load();
  assert.equal(window._getProblemTitle({ problem_name: "Merge Sort", ib_problem_id: 2 }), "Merge Sort");
});

test("_getProblemTitle: falls back to title", () => {
  const { window } = load();
  assert.equal(window._getProblemTitle({ title: "Two Sum", ib_problem_id: 3 }), "Two Sum");
});

test("_getProblemTitle: falls back to Problem #ID when no name field", () => {
  const { window } = load();
  assert.equal(window._getProblemTitle({ ib_problem_id: 999 }), "Problem #999");
});

// ─── _detectNewSolves ─────────────────────────────────────────

test("_detectNewSolves: solved problem absent from log → detected", () => {
  const { window } = load();
  const result = window._detectNewSolves([makeApiProblem()], {});
  assert.equal(result.length, 1);
  assert.equal(result[0].ib_problem_id, 1001);
});

test("_detectNewSolves: already in log → not detected", () => {
  const { window } = load();
  const log = { "1001": makeLogEntry() };
  assert.equal(window._detectNewSolves([makeApiProblem()], log).length, 0);
});

test("_detectNewSolves: unsolved status → not detected", () => {
  const { window } = load();
  assert.equal(window._detectNewSolves([makeApiProblem({ status: "unsolved" })], {}).length, 0);
});

test("_detectNewSolves: null status → not detected", () => {
  const { window } = load();
  assert.equal(window._detectNewSolves([makeApiProblem({ status: null })], {}).length, 0);
});

test("_detectNewSolves: non-standard solved status (completed) → detected", () => {
  const { window } = load();
  assert.equal(window._detectNewSolves([makeApiProblem({ status: "completed" })], {}).length, 1);
});

// ─── _buildEntry ──────────────────────────────────────────────

test("_buildEntry: uses fallback title when API has no name", () => {
  const { window } = load();
  const problem = { ib_problem_id: 7777, type: "assignment", sbat_id: 1, status: "solved" };
  const entry = window._buildEntry(problem);
  assert.equal(entry.title, "Problem #7777");
});

test("_buildEntry: stage 0 and nextDue 1 day out by default", () => {
  const { window } = load();
  const before = Date.now();
  const entry = window._buildEntry(makeApiProblem());
  const after = Date.now();
  assert.equal(entry.stage, 0);
  assert.ok(entry.nextDue >= before + 86400000);
  assert.ok(entry.nextDue <= after + 86400000);
  assert.ok(entry.url.includes("1001"));
});

test("_buildEntry: accepts custom nextDue for backfill", () => {
  const { window } = load();
  const customDue = Date.now() - 1;
  const entry = window._buildEntry(makeApiProblem(), customDue);
  assert.equal(entry.nextDue, customDue);
});

test("_buildEntry: homework type uses 'homework' in URL", () => {
  const { window } = load();
  const entry = window._buildEntry(makeApiProblem({ type: "homework", ib_problem_id: 2002, sbat_id: 600 }));
  assert.ok(entry.url.includes("homework"));
  assert.ok(entry.url.includes("2002"));
});

// ─── _getDueToday ─────────────────────────────────────────────

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
  assert.equal(window._getDueToday(log).length, 0);
});

// ─── _advanceStage ────────────────────────────────────────────

test("_advanceStage: increments stage and recalculates nextDue", () => {
  const { window } = load();
  const entry = makeLogEntry({ stage: 0, intervals: [1, 3, 7, 14, 30] });
  const updated = window._advanceStage(entry);
  assert.equal(updated.stage, 1);
  assert.ok(updated.nextDue > Date.now() + 2 * 86400000);
  assert.ok(updated.nextDue < Date.now() + 4 * 86400000);
});

test("_advanceStage: returns null after last interval (graduation)", () => {
  const { window } = load();
  assert.equal(window._advanceStage(makeLogEntry({ stage: 4 })), null);
});

// ─── Integration: initRevisionTracker ────────────────────────

function makeProblemsResponse(problems) {
  const obj = {};
  problems.forEach((p) => { obj[p.ib_problem_id] = p; });
  return { problems: obj };
}

function loadWithChrome(localStore = {}, fetchRouter = null) {
  const chrome = makeChrome({ localStore });
  const fetch = fetchRouter
    ? makeFetch(fetchRouter)
    : makeFetch(() => ({ ok: false, status: 401 }));
  return loadFeature(FEATURE, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "revision-tracker": true },
    },
    chrome,
    fetch,
  });
}

test("feature off → fetch never called", async () => {
  let fetched = false;
  const { window } = loadFeature(FEATURE, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "revision-tracker": false },
    },
    fetch: async () => { fetched = true; return { ok: true, json: async () => ({ problems: {} }) }; },
    chrome: makeChrome(),
  });
  await window.initRevisionTracker();
  assert.equal(fetched, false);
});

test("API failure → no throw, log unchanged", async () => {
  const { window, chrome } = loadWithChrome({}, () => ({ ok: false, status: 401 }));
  await window.initRevisionTracker();
  assert.equal(chrome.__local[REVISION_LOG_KEY], undefined);
});

test("network error → no throw", async () => {
  const { window } = loadFeature(FEATURE, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: async () => { throw new Error("Network error"); },
    chrome: makeChrome(),
  });
  await assert.doesNotReject(() => window.initRevisionTracker());
});

test("new solved problem → written to log with stage 0", async () => {
  const problem = makeApiProblem({ ib_problem_id: 9001, title: "Binary Search", sbat_id: 200 });
  const { window, chrome } = loadWithChrome(
    {},
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  await tick();
  const log = chrome.__local[REVISION_LOG_KEY];
  assert.ok(log?.["9001"], "entry written");
  assert.equal(log["9001"].stage, 0);
  assert.equal(log["9001"].title, "Binary Search");
});

test("already-logged problem not overwritten", async () => {
  const problem = makeApiProblem({ ib_problem_id: 9001 });
  const existingEntry = makeLogEntry({ stage: 2, nextDue: Date.now() + 7 * 86400000 });
  const { window, chrome } = loadWithChrome(
    { [REVISION_LOG_KEY]: { "9001": existingEntry } },
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  await tick();
  assert.equal(chrome.__local[REVISION_LOG_KEY]["9001"].stage, 2);
});

// ─── Backfill ─────────────────────────────────────────────────

test("first load seeds all solved problems as immediately due", async () => {
  const problem = makeApiProblem({ ib_problem_id: 5001, title: "Quick Sort", sbat_id: 100 });
  const { window, chrome } = loadWithChrome(
    {},
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  await tick();
  const log = chrome.__local[REVISION_LOG_KEY];
  assert.ok(log?.["5001"], "backfilled entry exists");
  assert.ok(log["5001"].nextDue <= Date.now(), "immediately due");
  assert.equal(chrome.__local[REVISION_SEEDED_KEY], true);
});

test("already-seeded → existing entry stage unchanged", async () => {
  const problem = makeApiProblem({ ib_problem_id: 6001 });
  const existingEntry = makeLogEntry({ stage: 1, nextDue: Date.now() + 3 * 86400000 });
  const { window, chrome } = loadWithChrome(
    {
      [REVISION_LOG_KEY]: { "6001": existingEntry },
      [REVISION_SEEDED_KEY]: true,
    },
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  await tick();
  assert.equal(chrome.__local[REVISION_LOG_KEY]["6001"].stage, 1);
});

test("initRevisionTracker: no DOM panel injected", async () => {
  const problem = makeApiProblem({ ib_problem_id: 8001 });
  const { window } = loadWithChrome(
    {},
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  assert.equal(window.document.querySelectorAll("[data-revision-injected]").length, 0);
});
