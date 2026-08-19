const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, tick } = require("./helpers/harness");

const FEATURE = "content/features/revisionTracker.js";

const REVISION_LOG_KEY = "scalerpp_revision_log";
const DAY_MS = 24 * 60 * 60 * 1000;

const PROBLEM_URL =
  "https://www.scaler.com/academy/mentee-dashboard/class/500/assignment/problems/1001";

function makeLogEntry(overrides = {}) {
  const now = Date.now();
  return {
    title: "Two Sum",
    url: PROBLEM_URL,
    ib_problem_id: "1001",
    solvedAt: now - 2 * DAY_MS,
    intervals: [1, 3, 7, 14, 30],
    stage: 0,
    nextDue: now - DAY_MS,
    ...overrides,
  };
}

// The queue is USER-controlled: problems enter it only via the "Mark for
// Revision" button (revisionMarker.js), never by polling Scaler's API.
function load(localStore = {}, globals = {}) {
  const chrome = makeChrome({ localStore });
  return loadFeature(FEATURE, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "revision-tracker": true },
      ...globals,
    },
    chrome,
  });
}

// ─── _buildEntry ──────────────────────────────────────────────

test("_buildEntry: keeps the supplied title", () => {
  const { window } = load();
  const e = window._buildEntry("Two Sum", PROBLEM_URL, 1001);
  assert.equal(e.title, "Two Sum");
  assert.equal(e.url, PROBLEM_URL);
});

test("_buildEntry: falls back to Problem #ID when title is missing", () => {
  const { window } = load();
  assert.equal(window._buildEntry("", PROBLEM_URL, 1001).title, "Problem #1001");
  assert.equal(window._buildEntry(null, PROBLEM_URL, 1001).title, "Problem #1001");
});

test("_buildEntry: ib_problem_id is normalised to a string", () => {
  // The log is keyed by string id; a numeric id here would key-collide oddly.
  const { window } = load();
  assert.strictEqual(window._buildEntry("t", PROBLEM_URL, 1001).ib_problem_id, "1001");
});

test("_buildEntry: starts at stage 0, due one day out", () => {
  const { window } = load();
  const e = window._buildEntry("Two Sum", PROBLEM_URL, 1001);
  assert.equal(e.stage, 0);
  assert.deepEqual(Array.from(e.intervals), [1, 3, 7, 14, 30]);
  assert.ok(e.nextDue > Date.now() + 0.9 * DAY_MS);
  assert.ok(e.nextDue < Date.now() + 1.1 * DAY_MS);
});

test("_buildEntry: returns its own intervals copy, not the shared constant", () => {
  // Two entries must not share one array — mutating one would reschedule both.
  const { window } = load();
  const a = window._buildEntry("a", PROBLEM_URL, 1);
  const b = window._buildEntry("b", PROBLEM_URL, 2);
  a.intervals.push(99);
  assert.deepEqual(Array.from(b.intervals), [1, 3, 7, 14, 30]);
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
  const log = { "1001": makeLogEntry({ nextDue: Date.now() + DAY_MS }) };
  assert.equal(window._getDueToday(log).length, 0);
});

test("_getDueToday: empty log yields an empty queue", () => {
  const { window } = load();
  assert.equal(window._getDueToday({}).length, 0);
});

// ─── _advanceStage ────────────────────────────────────────────

test("_advanceStage: increments stage and recalculates nextDue", () => {
  const { window } = load();
  const entry = makeLogEntry({ stage: 0, intervals: [1, 3, 7, 14, 30] });
  const updated = window._advanceStage(entry);
  assert.equal(updated.stage, 1);
  assert.ok(updated.nextDue > Date.now() + 2 * DAY_MS);
  assert.ok(updated.nextDue < Date.now() + 4 * DAY_MS);
});

test("_advanceStage: returns null after last interval (graduation)", () => {
  const { window } = load();
  assert.equal(window._advanceStage(makeLogEntry({ stage: 4 })), null);
});

test("_advanceStage: does not mutate the entry it is given", () => {
  const { window } = load();
  const entry = makeLogEntry({ stage: 1 });
  const before = { ...entry };
  window._advanceStage(entry);
  assert.deepEqual(entry, before);
});

// ─── markProblemForRevision (public API) ──────────────────────

test("markProblemForRevision: writes a new problem to the log", async () => {
  const { window, chrome } = load();
  const added = await window.markProblemForRevision("Two Sum", PROBLEM_URL, 1001);
  await tick();
  assert.equal(added, true);
  const stored = await new Promise((r) =>
    chrome.storage.local.get(REVISION_LOG_KEY, (v) => r(v[REVISION_LOG_KEY])),
  );
  assert.ok(stored["1001"], "entry stored under its string id");
  assert.equal(stored["1001"].stage, 0);
  assert.equal(stored["1001"].title, "Two Sum");
});

test("markProblemForRevision: an already-queued problem is not re-added", async () => {
  // Re-marking must not reset an in-progress schedule back to stage 0.
  const existing = makeLogEntry({ stage: 3 });
  const { window, chrome } = load({ [REVISION_LOG_KEY]: { "1001": existing } });
  const added = await window.markProblemForRevision("Two Sum", PROBLEM_URL, 1001);
  await tick();
  assert.equal(added, false);
  const stored = await new Promise((r) =>
    chrome.storage.local.get(REVISION_LOG_KEY, (v) => r(v[REVISION_LOG_KEY])),
  );
  assert.equal(stored["1001"].stage, 3, "existing stage preserved");
});

test("markProblemForRevision: numeric and string ids address the same entry", async () => {
  const { window } = load();
  assert.equal(await window.markProblemForRevision("Two Sum", PROBLEM_URL, 1001), true);
  await tick();
  assert.equal(await window.markProblemForRevision("Two Sum", PROBLEM_URL, "1001"), false);
});

test("markProblemForRevision: no-ops once the extension context is gone", async () => {
  // An orphaned content script must not touch chrome.* after a reload.
  const { window } = load({}, { isExtensionValid: () => false });
  assert.equal(await window.markProblemForRevision("Two Sum", PROBLEM_URL, 1001), false);
});

test("markProblemForRevision: a storage failure is swallowed, not thrown", async () => {
  // Content scripts have no error boundary — a rejection here would surface as
  // an unhandled rejection in the page.
  const { window } = load();
  window.chrome.storage.local.get = () => {
    throw new Error("storage unavailable");
  };
  assert.equal(await window.markProblemForRevision("Two Sum", PROBLEM_URL, 1001), false);
});

// ─── Scope ────────────────────────────────────────────────────

test("revisionTracker injects no DOM of its own", () => {
  // Rendering belongs to revisionPanel.js; the tracker is storage/scheduling only.
  const { window } = load();
  assert.equal(window.document.body.children.length, 0);
});

// ─── Panel sizing (regression guard) ──────────────────────────

test("the revision list is height-capped and scrolls internally", () => {
  // The panel sits ABOVE Performance / Attendance / Notice Board in the sidebar.
  // If the list grew with the queue it would push all of them off-screen, which
  // is the whole reason the panel was moved there. jsdom does no layout, so the
  // guard is on the stylesheet itself.
  const fs = require("fs");
  const path = require("path");
  const css = fs.readFileSync(
    path.resolve(__dirname, "..", "extension-main", "content", "features", "revisionPanel.css"),
    "utf8",
  );
  const rule = css.match(/#srp-list\s*\{[^}]*\}/);
  assert.ok(rule, "#srp-list rule present");
  assert.match(rule[0], /max-height:/, "list height is capped");
  assert.match(rule[0], /overflow-y:\s*auto/, "list scrolls instead of growing");
  assert.match(rule[0], /--srp-visible-rows:\s*\d+/, "visible row count is tunable");
});

test("the panel opens problems with noopener", () => {
  // window.open(url, "_blank") without it hands the new tab a live opener
  // handle back to the dashboard.
  const fs = require("fs");
  const path = require("path");
  const js = fs.readFileSync(
    path.resolve(__dirname, "..", "extension-main", "content", "features", "revisionPanel.js"),
    "utf8",
  );
  assert.match(js, /window\.open\([^)]*"noopener"\)/, "revisit link uses noopener");
});
