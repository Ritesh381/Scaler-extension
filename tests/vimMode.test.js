const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const EXT = path.resolve(__dirname, "..", "extension-main");
const read = (p) => fs.readFileSync(path.join(EXT, p), "utf8");

test("vim-mode default is present and false in both DEFAULT_SETTINGS copies", () => {
  const popup = read("popup.js");
  const selectors = read("content/cleaner/selectors.js");
  assert.match(popup, /"vim-mode":\s*false/, "missing in popup.js");
  assert.match(selectors, /"vim-mode":\s*false/, "missing in selectors.js");
});

test("vim-mode toggle is wired in TOGGLE_MAP", () => {
  const popup = read("popup.js");
  assert.match(popup, /"toggle-vim-mode":\s*"vim-mode"/);
});

const { loadFeature } = require("./helpers/harness");

test("isVimCodingPage matches assignment problem URLs only", () => {
  const cases = [
    ["https://www.scaler.com/academy/mentee-dashboard/class/441741/assignment/problems/25137", true],
    // Real URLs carry a ?navref query string after the problem id.
    ["https://www.scaler.com/academy/mentee-dashboard/class/541729/assignment/problems/17087?navref=cl_tt_lst_nm", true],
    // Additional problems use the "homework" segment, not "homework_assignment".
    ["https://www.scaler.com/academy/mentee-dashboard/class/442882/homework/problems/11223", true],
    ["https://www.scaler.com/academy/mentee-dashboard/class/442882/homework/problems/11223?navref=cl_tt_nv", true],
    ["https://www.scaler.com/academy/mentee-dashboard/todos", false],
    ["https://www.scaler.com/academy/mentee-dashboard/class/441741/assignment/problems", false],
  ];
  const { window } = loadFeature("content/features/vimMode/vimMode.js", {});
  for (const [url, expected] of cases) {
    assert.equal(window.isVimCodingPage(url), expected, url);
  }
});
