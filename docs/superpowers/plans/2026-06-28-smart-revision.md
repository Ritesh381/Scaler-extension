# Smart Revision — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically detect solved Scaler problems and surface a spaced-repetition revision queue in an injected in-page panel on the Scaler dashboard.

**Architecture:** A single content-script module (`revisionTracker.js`) fetches `/academy/mentee/problems-data` once per page load (session-cached), diffs against a `chrome.storage.local` log to detect new solves, schedules them on fixed intervals `[1, 3, 7, 14, 30]` days, and injects a collapsible panel showing today's due items. Pure logic functions are exposed on `window` for testability.

**Tech Stack:** Chrome MV3 content script, `chrome.storage.local`, vanilla DOM, Node.js built-in test runner + jsdom (existing harness).

## Before Starting

Create the feature branch first — all task commits go here:

```bash
git fetch upstream
git checkout -b feature/smart-revision upstream/main
```

## Global Constraints

- All commits GPG-signed: `git commit -S`
- Author: `OfficialAbhinavSingh` / `abhinav.25bcs10345@sst.scaler.com`
- No Jest — Node.js built-in `node:test` + `node:assert/strict` only
- No new npm dependencies
- Feature must never throw or break the Scaler page on any error path
- Test runner: `cd tests && node --test` from repo root
- Extension root: `extension-main/`

---

## File Map

| Action | Path | Responsibility |
|---|---|---|
| CREATE | `extension-main/content/features/revisionTracker.js` | All revision logic + DOM injection |
| CREATE | `extension-main/content/features/revisionPanel.css` | Panel styles (dark-mode aware) |
| CREATE | `tests/revisionTracker.test.js` | Full test suite |
| MODIFY | `extension-main/content/cleaner/selectors.js` | Add `"revision-tracker": true` to DEFAULT_SETTINGS |
| MODIFY | `extension-main/content/content.js` | Init call, toggle handler, URL-change hook |
| MODIFY | `extension-main/manifest.json` | Add JS + CSS to content_scripts |
| MODIFY | `extension-main/popup.html` | Add toggle row in Enhancements section |
| MODIFY | `extension-main/popup.js` | Add entry to TOGGLE_MAP |

---

### Task 1: Pure Logic Functions

**Files:**
- Create: `extension-main/content/features/revisionTracker.js`
- Create: `tests/revisionTracker.test.js`

**Interfaces:**
- Produces:
  - `window._detectNewSolves(apiProblems, log)` → `Problem[]`
  - `window._buildEntry(apiProblem)` → `LogEntry`
  - `window._getDueToday(log)` → `DueItem[]`
  - `window._advanceStage(entry)` → `LogEntry | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/revisionTracker.test.js`:

```js
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
  assert.deepEqual(entry.intervals, [1, 3, 7, 14, 30]);
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
```

- [ ] **Step 2: Run tests — expect failure**

```bash
cd /path/to/repo && node --test tests/revisionTracker.test.js
```
Expected: `ReferenceError` or `TypeError` — file does not exist yet.

- [ ] **Step 3: Create revisionTracker.js with pure functions**

Create `extension-main/content/features/revisionTracker.js`:

```js
// ============================================================
// content/features/revisionTracker.js — Smart Revision
// Detect solved Scaler problems and schedule spaced revision.
// ============================================================

const REVISION_LOG_KEY = "scalerpp_revision_log";
const PANEL_ATTR = "data-revision-injected";
const DAY_MS = 24 * 60 * 60 * 1000;
const REVISION_INTERVALS = [1, 3, 7, 14, 30]; // days

// Session-level cache — avoids duplicate fetches on SPA navigation
let _problemsCache = null;

// ─── Pure helpers ─────────────────────────────────────────────

function _buildProblemUrl(p) {
  const segment = p.type === "assignment" ? "assignment" : "homework";
  return (
    `https://www.scaler.com/academy/mentee-dashboard/class/` +
    `${p.sbat_id}/${segment}/problems/${p.ib_problem_id}`
  );
}

function _buildEntry(apiProblem) {
  const now = Date.now();
  return {
    title: apiProblem.title,
    url: _buildProblemUrl(apiProblem),
    solvedAt: now,
    intervals: [...REVISION_INTERVALS],
    stage: 0,
    nextDue: now + REVISION_INTERVALS[0] * DAY_MS,
  };
}

function _detectNewSolves(apiProblems, log) {
  return apiProblems.filter(
    (p) => p.status === "solved" && !log[String(p.ib_problem_id)]
  );
}

function _getDueToday(log) {
  const now = Date.now();
  return Object.entries(log)
    .filter(([, entry]) => entry.nextDue <= now)
    .map(([id, entry]) => ({ id, ...entry }));
}

// Returns updated entry, or null when all intervals are exhausted (graduated).
function _advanceStage(entry) {
  const nextStage = entry.stage + 1;
  if (nextStage >= entry.intervals.length) return null;
  return {
    ...entry,
    stage: nextStage,
    nextDue: Date.now() + entry.intervals[nextStage] * DAY_MS,
  };
}

// Expose for tests
window._detectNewSolves = _detectNewSolves;
window._getDueToday = _getDueToday;
window._advanceStage = _advanceStage;
window._buildEntry = _buildEntry;
```

- [ ] **Step 4: Run tests — expect pass**

```bash
node --test tests/revisionTracker.test.js
```
Expected: all 9 tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add extension-main/content/features/revisionTracker.js tests/revisionTracker.test.js
git commit -S -m "feat(revision): pure logic functions — detect solves, schedule intervals, advance stage"
```

---

### Task 2: Storage Helpers + Init Flow

**Files:**
- Modify: `extension-main/content/features/revisionTracker.js` (add storage + init)
- Modify: `tests/revisionTracker.test.js` (add integration tests)

**Interfaces:**
- Consumes: `window._detectNewSolves`, `window._buildEntry`, `window._getDueToday` (Task 1)
- Produces: `window.initRevisionTracker()` — async, no return value

- [ ] **Step 1: Write failing tests for init flow**

Append to `tests/revisionTracker.test.js`:

```js
const { makeFetch, tick } = require("./helpers/harness");

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
```

Note: The constant `REVISION_LOG_KEY` must be accessible in the test. Add to top of test file after the `load()` function:
```js
const REVISION_LOG_KEY = "scalerpp_revision_log";
```

- [ ] **Step 2: Run — expect failures**

```bash
node --test tests/revisionTracker.test.js
```
Expected: new tests fail (`initRevisionTracker is not a function`).

- [ ] **Step 3: Add storage helpers + initRevisionTracker to revisionTracker.js**

Append to `extension-main/content/features/revisionTracker.js` (before the `window._*` exports):

```js
// ─── Storage ──────────────────────────────────────────────────

function _readLog() {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(REVISION_LOG_KEY, (result) => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve(result[REVISION_LOG_KEY] || {});
    });
  });
}

function _writeLog(log) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [REVISION_LOG_KEY]: log }, () => {
      if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
      else resolve();
    });
  });
}

// ─── Main entry point ─────────────────────────────────────────

async function initRevisionTracker() {
  if (!isExtensionValid()) return;
  if (typeof currentSettings !== "undefined" && !currentSettings["revision-tracker"]) return;
  if (document.querySelector(`[${PANEL_ATTR}]`)) return;

  if (!_problemsCache) {
    try {
      const res = await fetch(
        "https://www.scaler.com/academy/mentee/problems-data",
        { credentials: "include" }
      );
      if (!res.ok) return;
      _problemsCache = await res.json();
    } catch {
      return;
    }
  }

  const apiProblems = Object.values(_problemsCache.problems || {});

  let log;
  try {
    log = await _readLog();
  } catch {
    log = {};
  }

  const newSolves = _detectNewSolves(apiProblems, log);
  if (newSolves.length > 0) {
    newSolves.forEach((p) => {
      log[String(p.ib_problem_id)] = _buildEntry(p);
    });
    try {
      await _writeLog(log);
    } catch (e) {
      console.warn("[Scaler++ Revision] Storage write failed:", e);
    }
  }

  const due = _getDueToday(log);
  _injectPanel(due);
}

window.initRevisionTracker = initRevisionTracker;
```

Also add a stub for `_injectPanel` so the file is syntactically complete for now:

```js
// ─── DOM (implemented in Task 3) ──────────────────────────────
function _injectPanel(dueProblems) {
  // stub — full implementation in Task 3
}
```

Place the stub BEFORE `initRevisionTracker` so the reference resolves.

- [ ] **Step 4: Run — expect pass**

```bash
node --test tests/revisionTracker.test.js
```
Expected: all tests pass, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add extension-main/content/features/revisionTracker.js tests/revisionTracker.test.js
git commit -S -m "feat(revision): storage helpers + initRevisionTracker flow"
```

---

### Task 3: Panel DOM Injection + CSS

**Files:**
- Modify: `extension-main/content/features/revisionTracker.js` (replace `_injectPanel` stub)
- Create: `extension-main/content/features/revisionPanel.css`
- Modify: `tests/revisionTracker.test.js` (add DOM tests)

**Interfaces:**
- Consumes: `_readLog()`, `_writeLog()`, `_advanceStage()` (Task 2)
- Produces: panel injected into `document.body` / `main`; `[data-revision-injected]` attribute set

- [ ] **Step 1: Write failing DOM tests**

Append to `tests/revisionTracker.test.js`:

```js
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
```

- [ ] **Step 2: Run — expect failures**

```bash
node --test tests/revisionTracker.test.js
```
Expected: 3 new tests fail (stub `_injectPanel` does nothing).

- [ ] **Step 3: Replace `_injectPanel` stub with full implementation**

Replace the stub in `extension-main/content/features/revisionTracker.js`:

```js
// ─── DOM ──────────────────────────────────────────────────────

function _escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function _injectPanel(dueProblems) {
  const anchor =
    document.querySelector("main") ||
    document.body;

  const count = dueProblems.length;
  const collapsed =
    typeof sessionStorage !== "undefined" &&
    sessionStorage.getItem("scalerpp_revision_collapsed") === "true";

  const itemsHtml =
    count === 0
      ? '<p class="srp-empty">Nothing due today ✓</p>'
      : dueProblems
          .map(
            (p) =>
              `<div class="srp-item" data-pid="${_escapeHtml(p.id)}">` +
              `<span class="srp-item-title">${_escapeHtml(p.title)}</span>` +
              `<button class="srp-revisit-btn" data-pid="${_escapeHtml(p.id)}" ` +
              `data-url="${_escapeHtml(p.url)}">Revisit</button></div>`
          )
          .join("");

  const panel = document.createElement("div");
  panel.className = "scaler-revision-panel";
  panel.setAttribute(PANEL_ATTR, "true");
  panel.innerHTML =
    `<div class="srp-header">` +
    `<span class="srp-title">📚 Revise Today${count > 0 ? ` (${count})` : ""}</span>` +
    `<button class="srp-toggle" aria-label="Toggle panel">${collapsed ? "+" : "−"}</button>` +
    `</div>` +
    `<div class="srp-body${collapsed ? " srp-hidden" : ""}">${itemsHtml}</div>`;

  anchor.prepend(panel);

  panel.querySelector(".srp-toggle").addEventListener("click", () => {
    const body = panel.querySelector(".srp-body");
    const isNowCollapsed = body.classList.toggle("srp-hidden");
    panel.querySelector(".srp-toggle").textContent = isNowCollapsed ? "+" : "−";
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem("scalerpp_revision_collapsed", String(isNowCollapsed));
    }
  });

  panel.querySelectorAll(".srp-revisit-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const pid = btn.dataset.pid;
      const url = btn.dataset.url || "https://www.scaler.com/academy";
      window.open(url, "_blank");
      try {
        const log = await _readLog();
        if (!log[pid]) return;
        const updated = _advanceStage(log[pid]);
        if (updated === null) {
          delete log[pid];
        } else {
          log[pid] = updated;
        }
        await _writeLog(log);

        const item = panel.querySelector(`.srp-item[data-pid="${pid}"]`);
        if (item) item.remove();

        const remaining = panel.querySelectorAll(".srp-revisit-btn").length;
        const titleEl = panel.querySelector(".srp-title");
        if (titleEl) {
          titleEl.textContent =
            `📚 Revise Today${remaining > 0 ? ` (${remaining})` : ""}`;
        }
        if (remaining === 0) {
          const body = panel.querySelector(".srp-body");
          if (body) body.innerHTML = '<p class="srp-empty">Nothing due today ✓</p>';
        }
      } catch (e) {
        console.warn("[Scaler++ Revision] Failed to update log:", e);
      }
    });
  });
}
```

- [ ] **Step 4: Create revisionPanel.css**

Create `extension-main/content/features/revisionPanel.css`:

```css
.scaler-revision-panel {
  margin: 12px 16px 0;
  background: #fff;
  border: 1px solid #e5e7eb;
  border-radius: 8px;
  overflow: hidden;
  font-family: inherit;
  box-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  position: relative;
  z-index: 1;
}

.srp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
}

.srp-title {
  font-size: 13px;
  font-weight: 600;
  color: #111827;
}

.srp-toggle {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 16px;
  color: #6b7280;
  padding: 0 4px;
  line-height: 1;
}

.srp-toggle:hover {
  color: #111827;
}

.srp-body {
  padding: 8px 14px;
}

.srp-body.srp-hidden {
  display: none;
}

.srp-empty {
  font-size: 12px;
  color: #6b7280;
  margin: 4px 0;
  padding: 4px 0;
}

.srp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid #f3f4f6;
  gap: 8px;
}

.srp-item:last-child {
  border-bottom: none;
}

.srp-item-title {
  font-size: 12px;
  color: #1f2937;
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.srp-revisit-btn {
  flex-shrink: 0;
  background: #2563eb;
  color: #fff;
  border: none;
  border-radius: 4px;
  padding: 3px 10px;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s;
}

.srp-revisit-btn:hover {
  background: #1d4ed8;
}

/* Dark mode — all scaler-theme-active variants */
html.scaler-theme-active .scaler-revision-panel {
  background: #1e1e2e;
  border-color: #333350;
}

html.scaler-theme-active .srp-header {
  background: #161622;
  border-color: #333350;
}

html.scaler-theme-active .srp-title {
  color: #e2e8f0;
}

html.scaler-theme-active .srp-toggle {
  color: #94a3b8;
}

html.scaler-theme-active .srp-toggle:hover {
  color: #e2e8f0;
}

html.scaler-theme-active .srp-item {
  border-color: #2a2a3e;
}

html.scaler-theme-active .srp-item-title {
  color: #cbd5e1;
}

html.scaler-theme-active .srp-empty {
  color: #94a3b8;
}

html.scaler-theme-active .srp-revisit-btn {
  background: #3b82f6;
}

html.scaler-theme-active .srp-revisit-btn:hover {
  background: #2563eb;
}

@media print {
  .scaler-revision-panel { display: none; }
}
```

- [ ] **Step 5: Run tests — expect all pass**

```bash
node --test tests/revisionTracker.test.js
```
Expected: all tests pass, 0 failures.

- [ ] **Step 6: Commit**

```bash
git add extension-main/content/features/revisionTracker.js \
        extension-main/content/features/revisionPanel.css \
        tests/revisionTracker.test.js
git commit -S -m "feat(revision): panel DOM injection + CSS with dark-mode support"
```

---

### Task 4: Wire into Extension

**Files:**
- Modify: `extension-main/content/cleaner/selectors.js`
- Modify: `extension-main/content/content.js`
- Modify: `extension-main/manifest.json`

**Interfaces:**
- Consumes: `window.initRevisionTracker` (Task 2)
- No new tests — covered by smoke test suite

- [ ] **Step 1: Add setting to DEFAULT_SETTINGS in selectors.js**

In `extension-main/content/cleaner/selectors.js`, in the `DEFAULT_SETTINGS` object, after the `theme` entry, add:

```js
  // Smart Revision — spaced repetition for solved problems
  "revision-tracker": true,
```

- [ ] **Step 2: Add init call in content.js window.load handler**

In `extension-main/content/content.js`, inside `window.addEventListener("load", async () => { ... })`, after the `initSpotlightSearch` call, add:

```js
  // Initialize Smart Revision tracker on dashboard pages
  setTimeout(() => {
    if (
      currentSettings &&
      currentSettings["revision-tracker"] &&
      typeof initRevisionTracker === "function"
    ) {
      initRevisionTracker();
    }
  }, 2500);
```

- [ ] **Step 3: Add toggle handler in content.js**

In `extension-main/content/content.js`, inside the `toggleSetting` message handler, before the final `else { updateVisibilityForKey(...) }`, add:

```js
    } else if (key === "revision-tracker") {
      if (value) {
        if (typeof initRevisionTracker === "function") initRevisionTracker();
      } else {
        const panel = document.querySelector("[data-revision-injected]");
        if (panel) panel.remove();
      }
```

- [ ] **Step 4: Add URL-change hook in content.js**

In `extension-main/content/content.js`, inside the `handleUrlChange` reassignment block at the bottom, after the `initProblemPicker` setTimeout, add:

```js
  // Re-render revision panel on SPA navigation
  setTimeout(() => {
    if (
      currentSettings &&
      currentSettings["revision-tracker"] &&
      typeof initRevisionTracker === "function"
    ) {
      initRevisionTracker();
    }
  }, 2500);
```

- [ ] **Step 5: Add JS + CSS to manifest.json**

In `extension-main/manifest.json`, in the second `content_scripts` entry:

In the `"js"` array, after `"content/features/themeManager.js"` and before `"content/content.js"`, add:
```json
"content/features/revisionTracker.js",
```

In the `"css"` array (currently only has `liveStreamRecorder.css`), add:
```json
"content/features/revisionPanel.css"
```

The css array should look like:
```json
"css": [
  "content/features/liveStreamRecorder/liveStreamRecorder.css",
  "content/features/revisionPanel.css"
]
```

- [ ] **Step 6: Run full test suite**

```bash
cd tests && node --test
```
Expected: all existing tests pass + all revision tests pass, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add extension-main/content/cleaner/selectors.js \
        extension-main/content/content.js \
        extension-main/manifest.json
git commit -S -m "feat(revision): wire initRevisionTracker into content script and manifest"
```

---

### Task 5: Popup Toggle

**Files:**
- Modify: `extension-main/popup.html`
- Modify: `extension-main/popup.js`

**Interfaces:**
- Consumes: `"revision-tracker"` setting key (Task 4)
- No new tests — covered by existing popup wiring pattern

- [ ] **Step 1: Add toggle to popup.html**

In `extension-main/popup.html`, inside the Enhancements `<section>` `<div class="toggle-list">`, after the calendar sync toggle block, add:

```html
            <!-- Smart Revision toggle -->
            <label class="toggle-item highlight">
              <div class="toggle-info">
                <span class="toggle-title">📚 Smart Revision</span>
                <span class="toggle-desc">
                  Surface solved problems for spaced revision — 1, 3, 7, 14, 30 day intervals.
                </span>
              </div>
              <div class="toggle-switch">
                <input type="checkbox" id="toggle-revision-tracker" checked />
                <span class="slider"></span>
              </div>
            </label>
```

- [ ] **Step 2: Add entry to TOGGLE_MAP in popup.js**

In `extension-main/popup.js`, in the `TOGGLE_MAP` object, after `"toggle-spotlight-search": "spotlight-search"`, add:

```js
  "toggle-revision-tracker": "revision-tracker",
```

- [ ] **Step 3: Run full test suite**

```bash
cd tests && node --test
```
Expected: all tests pass, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add extension-main/popup.html extension-main/popup.js
git commit -S -m "feat(revision): add Smart Revision toggle to popup"
```

---

### Task 6: Push + PR

- [ ] **Step 1: Create feature branch (from latest upstream main)**

```bash
git checkout upstream/main
git checkout -b feature/smart-revision
git cherry-pick <task1-sha> <task2-sha> <task3-sha> <task4-sha> <task5-sha>
```

If already on feature branch from the start, just verify:
```bash
git log --oneline upstream/main..HEAD
```
Expected: 5 commits listed.

- [ ] **Step 2: Run full suite one last time**

```bash
cd tests && node --test
```
Expected: all pass.

- [ ] **Step 3: Push**

```bash
git push origin feature/smart-revision
```

- [ ] **Step 4: Raise PR**

```bash
gh pr create \
  --repo Ritesh381/Scaler-extension \
  --head OfficialAbhinavSingh:feature/smart-revision \
  --base main \
  --title "feat: Smart Revision — spaced repetition for solved Scaler problems" \
  --body "$(cat <<'EOF'
## What this adds

A **Smart Revision** panel injected into the Scaler dashboard that tracks every problem the student solves and surfaces it for revision on a spaced schedule: **1 → 3 → 7 → 14 → 30 days**. After the final interval the problem is considered retained and removed from the queue.

## How it works

1. On each dashboard page load, fetches `/academy/mentee/problems-data` (the same endpoint used by the existing Problem Picker feature) — result is cached for the session so no duplicate requests are made
2. Diffs the response against a `chrome.storage.local` log to detect newly solved problems and schedules them
3. Injects a collapsible panel showing today's due problems; clicking **Revisit** opens the problem in a new tab and advances the interval stage
4. A **Smart Revision** toggle in the popup lets users turn the feature off (default: on)

## Performance

- 1 fetch per page load (session-cached), 0 polling, 0 `setInterval`, 0 `MutationObserver`
- ~15 DOM nodes, ~200 KB storage for 1000 problems
- All failure paths (API error, storage error, not logged in) are silent — the feature never breaks the Scaler page

## Dark mode

Panel respects all existing dark/theme classes via `html.scaler-theme-active` selectors in `revisionPanel.css`.

## Tests

- 18 new unit + integration tests; all 73+ existing tests continue to pass
- `node --test` from `tests/` directory
EOF
)"
```
