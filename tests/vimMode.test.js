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
  assert.match(popup, /"vim-paste":\s*false/, "vim-paste missing in popup.js");
  assert.match(selectors, /"vim-paste":\s*false/, "vim-paste missing in selectors.js");
});

test("vim-mode toggle is wired in TOGGLE_MAP", () => {
  const popup = read("popup.js");
  assert.match(popup, /"toggle-vim-mode":\s*"vim-mode"/);
  assert.match(popup, /"toggle-vim-paste":\s*"vim-paste"/);
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

test("re-enabling vim re-posts enable with the paste flag", () => {
  const { window } = loadFeature("content/features/vimMode/vimMode.js", {
    globals: {
      isExtensionValid: () => true,
      currentSettings: { "vim-mode": true, "vim-paste": true },
    },
  });
  window.chrome.runtime.getURL = (p) => p;
  const posted = [];
  window.postMessage = (data) => posted.push(data);
  window.dispatchEvent(
    new window.MessageEvent("message", {
      source: window,
      data: { source: "scalerpp-vim-capture", type: "monaco-ready" },
    }),
  );
  window.setVimEnabled(true);
  window.setVimEnabled(false);
  posted.length = 0;
  // Bridge is already injected now; turning vim back on must still reach it.
  window.setVimEnabled(true);
  assert.deepEqual(
    posted.filter((d) => d.source === "scalerpp-vim").map((d) => ({ ...d })),
    [{ source: "scalerpp-vim", type: "enable", paste: true }],
  );
});
