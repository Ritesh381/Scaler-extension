// ============================================================
// assignmentExportUi.test.js
// The export button's "click outside closes the menu" handler is shared,
// so re-creating the button on every problem doesn't pile up listeners.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

const PAGE = `<!DOCTYPE html><html><body><div id="host"><div class="cr-p-heading__text">Two Sum</div></div></body></html>`;

function load() {
  const { window } = loadFeature("content/features/assignmentExport/ui.js", { html: PAGE });
  let added = 0;
  let removed = 0;
  const doc = window.document;
  const realAdd = doc.addEventListener.bind(doc);
  const realRemove = doc.removeEventListener.bind(doc);
  doc.addEventListener = (type, ...rest) => {
    if (type === "click") added++;
    return realAdd(type, ...rest);
  };
  doc.removeEventListener = (type, ...rest) => {
    if (type === "click") removed++;
    return realRemove(type, ...rest);
  };
  return { window, counts: () => ({ added, removed }) };
}

test("re-creating the button for each problem adds one document listener in total", () => {
  const { window, counts } = load();
  for (let i = 0; i < 5; i++) {
    // SPA moves to another problem: the heading is re-rendered.
    window.document.getElementById("host").innerHTML = '<div class="cr-p-heading__text">Problem</div>';
    window.createExportButton(() => {}, () => {});
  }
  assert.equal(counts().added, 1);
});

test("clicking outside closes the open menu; teardown removes button and listener", () => {
  const { window, counts } = load();
  window.createExportButton(() => {}, () => {});
  const wrapper = window.document.querySelector("[data-assignment-export-injected]");
  const menu = wrapper.querySelector("[data-scaler-export-menu]");
  window.document.getElementById("scaler-export-btn").click();
  assert.equal(menu.style.display, "flex", "menu opens");

  window.document.body.click();
  assert.equal(menu.style.display, "none", "outside click closes it");

  window.teardownAssignmentExport();
  assert.equal(window.document.querySelector("[data-assignment-export-injected]"), null);
  assert.equal(counts().removed, 1);
});
