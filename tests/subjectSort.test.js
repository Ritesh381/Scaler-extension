// ============================================================
// subjectSort.test.js
// Sorting the curriculum's subject list, and the observer lifecycle: it
// must stop off the page and never loop when restoring.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, readFeature, tick } = require("./helpers/harness");

/** Load scripts as one bundle: they share top-level const/let, as on the page. */
function loadBundle(files, opts) {
  const { window } = loadFeature([], opts);
  // Tests flip settings through this: `currentSettings` is bundle-scoped.
  window.eval(
    files.map((f) => readFeature(f)).join("\n;\n") +
      "\n;window.__setSetting = (k, v) => { currentSettings[k] = v; };",
  );
  return { window };
}


const FILES = ["content/cleaner/selectors.js", "content/core/settings.js", "content/features/subjectSort.js"];
const subject = (n, name) =>
  `<div class="m-b-20"><div class="ZV1LrApmcV6Ae3HM7BSTK">Subject - ${n}</div><div class="_29EfoWpTY6mSoc0URgsgPl">${name}</div></div>`;
const PAGE = `<!DOCTYPE html><html><body><div class="m-l-20 m-r-20 m-t-20">
  ${subject(1, "Revision Sessions")}${subject(2, "SST Data Engineering")}${subject(3, "SST NLP")}
</div></body></html>`;
const URL_CURRICULUM = "https://www.scaler.com/academy/mentee-dashboard/core-curriculum/m/1/classes";

const names = (window) =>
  Array.from(window.document.querySelectorAll("._29EfoWpTY6mSoc0URgsgPl"), (n) => n.textContent);

test("sorts core subjects first and keeps watching only on the curriculum page", () => {
  const { window } = loadBundle(FILES, { html: PAGE, url: URL_CURRICULUM });
  window.initSubjectSort();
  assert.deepEqual(names(window), ["SST Data Engineering", "SST NLP", "Revision Sessions"]);
  assert.ok(window._subjectSortObserver, "observer running on the curriculum page");

  window.history.pushState({}, "", "/academy/mentee-dashboard/todos");
  window.initSubjectSort();
  assert.equal(window._subjectSortObserver, null, "observer stopped off the page");
});

test("turning it off restores numbers once, with no observer loop", async () => {
  const { window } = loadBundle(FILES, { html: PAGE, url: URL_CURRICULUM });
  window.initSubjectSort();
  await tick(600); // let the module's startup init run first
  const numEl = window.document.querySelector(".ZV1LrApmcV6Ae3HM7BSTK");
  assert.ok(numEl.hasAttribute("data-original-text"));

  // Count mutations after turning it off: a loop would keep producing them.
  let mutations = 0;
  new window.MutationObserver((r) => (mutations += r.length)).observe(window.document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  window.__setSetting("subject-sort", false);
  window.initSubjectSort();
  await tick(400);
  const settled = mutations;
  await tick(400);

  assert.equal(window._subjectSortObserver, null, "observer stopped");
  assert.equal(mutations, settled, "no further mutations: nothing is looping");
  assert.ok(!window.document.querySelector("[data-original-text]"), "markers cleared");
  assert.ok(!window.document.querySelector(".subject-sort-tag"), "tags gone");
});

test("a re-render of the list is sorted again by the observer", async () => {
  const { window } = loadBundle(FILES, { html: PAGE, url: URL_CURRICULUM });
  window.initSubjectSort();
  const container = window.document.querySelector(".m-l-20.m-r-20.m-t-20");
  container.insertAdjacentHTML("afterbegin", subject(4, "Interview Prep"));
  container.insertAdjacentHTML("beforeend", subject(5, "SST Marketing"));
  await tick(300);
  // Each group keeps page order; the new "Interview Prep" was inserted first.
  assert.deepEqual(names(window), [
    "SST Data Engineering",
    "SST NLP",
    "SST Marketing",
    "Interview Prep",
    "Revision Sessions",
  ]);
});
