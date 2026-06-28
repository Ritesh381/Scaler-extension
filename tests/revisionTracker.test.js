const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, makeFetch, tick } = require("./helpers/harness");

const FEATURE = "content/features/revisionTracker.js";

const REVISION_LOG_KEY = "scalerpp_revision_log";

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

// ─── Integration tests: initRevisionTracker ───────────────────

function makeProblemsResponse(problems) {
  const obj = {};
  problems.forEach((p) => { obj[p.ib_problem_id] = p; });
  return { problems: obj };
}

function loadWithChrome(localStore = {}, fetchRouter = null, settingOverride = {}) {
  const chrome = makeChrome({ localStore });
  const fetch = fetchRouter
    ? makeFetch(fetchRouter)
    : makeFetch(() => ({ ok: false, status: 401 }));
  return loadFeature(FEATURE, {
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "revision-tracker": true, ...settingOverride },
    },
    chrome,
    fetch,
  });
}

test("initRevisionTracker: feature off → fetch never called", async () => {
  let fetched = false;
  const { window } = loadFeature(FEATURE, {
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

test("initRevisionTracker: API failure → no throw, log unchanged", async () => {
  const { window, chrome } = loadWithChrome({}, () => ({ ok: false, status: 401 }));
  await window.initRevisionTracker();
  // log should remain empty — no write
  assert.deepEqual(chrome.__local, {});
});

test("initRevisionTracker: network error → no throw", async () => {
  const chrome = makeChrome();
  const { window } = loadFeature(FEATURE, {
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: async () => { throw new Error("Network error"); },
    chrome,
  });
  await assert.doesNotReject(() => window.initRevisionTracker());
});

test("initRevisionTracker: new solved problem → written to log with stage 0", async () => {
  const problem = makeApiProblem({ ib_problem_id: 9001, title: "Binary Search", sbat_id: 200 });
  const { window, chrome } = loadWithChrome(
    {},
    () => ({ ok: true, json: async () => makeProblemsResponse([problem]) })
  );
  await window.initRevisionTracker();
  await tick();
  const log = chrome.__local[REVISION_LOG_KEY];
  assert.ok(log, "log written");
  assert.ok(log["9001"], "entry for problem 9001");
  assert.equal(log["9001"].stage, 0);
  assert.equal(log["9001"].title, "Binary Search");
});

test("initRevisionTracker: already-logged problem not overwritten", async () => {
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

test("initRevisionTracker: SPA guard — called twice, fetch called once", async () => {
  let fetchCount = 0;
  const { window } = loadFeature(FEATURE, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: `<!DOCTYPE html><html><body><div data-revision-injected="true"></div></body></html>`,
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: async () => { fetchCount++; return { ok: true, json: async () => ({ problems: {} }) }; },
    chrome: makeChrome(),
  });
  await window.initRevisionTracker();
  assert.equal(fetchCount, 0, "guard attribute already present → no fetch");
});

// ─── DOM tests: _injectPanel ──────────────────────────────────

test("_injectPanel: panel not injected twice (SPA guard via attribute)", async () => {
  const problem = makeApiProblem({ ib_problem_id: 7001, title: "Merge Sort", sbat_id: 300 });
  const { window } = loadFeature(FEATURE, {
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: makeFetch(() => ({ ok: true, json: async () => makeProblemsResponse([problem]) })),
    chrome: makeChrome(),
  });
  await window.initRevisionTracker();
  await window.initRevisionTracker(); // second call
  const panels = window.document.querySelectorAll("[data-revision-injected]");
  assert.equal(panels.length, 1);
});

test("_injectPanel: shows N items when N problems are due today", async () => {
  const now = Date.now();
  const log = {
    "1001": makeLogEntry({ nextDue: now - 1000, title: "Two Sum" }),
    "1002": makeLogEntry({ nextDue: now - 2000, title: "Binary Search" }),
  };
  const chrome = makeChrome({ localStore: { [REVISION_LOG_KEY]: log } });
  const { window } = loadFeature(FEATURE, {
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: makeFetch(() => ({ ok: true, json: async () => ({ problems: {} }) })),
    chrome,
  });
  await window.initRevisionTracker();
  const btns = window.document.querySelectorAll(".srp-revisit-btn");
  assert.equal(btns.length, 2);
});

test("_injectPanel: shows empty state when nothing is due", async () => {
  const now = Date.now();
  const log = {
    "1001": makeLogEntry({ nextDue: now + 86400000 }), // future
  };
  const chrome = makeChrome({ localStore: { [REVISION_LOG_KEY]: log } });
  const { window } = loadFeature(FEATURE, {
    globals: { isExtensionValid: () => true, currentSettings: { "revision-tracker": true } },
    fetch: makeFetch(() => ({ ok: true, json: async () => ({ problems: {} }) })),
    chrome,
  });
  await window.initRevisionTracker();
  const empty = window.document.querySelector(".srp-empty");
  assert.ok(empty, "empty state element present");
  const btns = window.document.querySelectorAll(".srp-revisit-btn");
  assert.equal(btns.length, 0);
});
