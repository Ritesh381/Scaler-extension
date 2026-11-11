const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

function load() {
  return loadFeature("content/utils/stringUtils.js").window;
}

test("escapeRegex escapes regex metacharacters", () => {
  const { escapeRegex } = load();
  assert.equal(escapeRegex("a.b*c"), "a\\.b\\*c");
  assert.equal(escapeRegex("(x+y)"), "\\(x\\+y\\)");
  assert.equal(escapeRegex("plain"), "plain");
});

test("tokenize lowercases, strips punctuation and drops stop words", () => {
  const { tokenize } = load();
  const tokens = tokenize("Implement the Maximum Subarray Problem!");
  // 'implement', 'the', 'maximum', 'problem' are stop words → removed.
  // Array.from() rebases the jsdom-realm array onto Node's Array prototype
  // so deepStrictEqual doesn't reject identical contents across realms.
  assert.deepEqual(Array.from(tokens), ["subarray"]);
});

test("tokenize keeps short words only when filterShort=false", () => {
  const { tokenize } = load();
  // x/y/zz are not stop words, so this isolates the short-word filter.
  assert.deepEqual(Array.from(tokenize("x y zz", false)), ["x", "y", "zz"]);
  assert.deepEqual(Array.from(tokenize("x y zz", true)), ["zz"]);
});

test("isTitleSimilar matches semantically equivalent titles", () => {
  const { isTitleSimilar } = load();
  assert.equal(
    isTitleSimilar("Binary Tree Inorder Traversal", "Inorder Traversal of Binary Tree"),
    true,
  );
});

test("isTitleSimilar matches via prefix (pow/power)", () => {
  const { isTitleSimilar } = load();
  assert.equal(isTitleSimilar("Power of Two", "Pow of Twoo"), true);
});

test("isTitleSimilar rejects unrelated titles", () => {
  const { isTitleSimilar } = load();
  assert.equal(
    isTitleSimilar("Reverse Linked List", "Sudoku Solver Backtracking"),
    false,
  );
});

test("isTitleSimilar returns false when a title tokenizes to nothing", () => {
  const { isTitleSimilar } = load();
  // both reduce to empty after stop-word + short filtering paths
  assert.equal(isTitleSimilar("", ""), false);
});

test("normalizeTitleForCache strips everything but alphanumerics", () => {
  const { normalizeTitleForCache } = load();
  assert.equal(normalizeTitleForCache("Two Sum - II (Easy)!"), "twosumiieasy");
  assert.equal(normalizeTitleForCache("A_B.C"), "abc");
});

test("extractClassId reads the id from absolute and relative class URLs", () => {
  const { window } = loadFeature("content/utils/stringUtils.js");
  assert.equal(window.extractClassId("https://www.scaler.com/academy/mentee-dashboard/class/12345/session"), "12345");
  assert.equal(window.extractClassId("/academy/mentee-dashboard/class/678/assignment/problems/1"), "678");
  assert.equal(window.extractClassId("/academy/mentee-dashboard/todos"), null);
  assert.equal(window.extractClassId(undefined), null);
});
