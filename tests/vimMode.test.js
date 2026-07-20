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
