// ============================================================
// contestLeaderboard.test.js
// The alias lookup is cached (failures included) so a ticking contest
// page can't turn into a request every few hundred ms.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, readFeature, makeFetch, tick } = require("./helpers/harness");

/** Load scripts as one bundle: they share top-level const/let, as on the page. */
function loadBundle(files, opts) {
  const { window } = loadFeature([], opts);
  window.eval(files.map((f) => readFeature(f)).join("\n;\n"));
  return { window };
}


const FILES = ["content/cleaner/selectors.js", "content/core/settings.js", "content/features/contestLeaderboard.js"];
const PAGE = `<!DOCTYPE html><html><body><div class="classroom-contest">
  <div class="cr-stats cr-stats--first"><i class="cr-icon-trophy"></i><div class="cr-stats__bottom">View Leaderboard</div></div>
  <div id="timer">0</div>
</div></body></html>`;
const URL_CONTEST = "https://www.scaler.com/academy/mentee-dashboard/class/555/contest";

function load(respond) {
  const calls = [];
  const fetch = makeFetch((url) => {
    calls.push(url);
    return respond(url);
  });
  const { window } = loadBundle(FILES, { html: PAGE, url: URL_CONTEST, fetch });
  return { window, calls };
}

async function tickTimer(window, times) {
  const timer = window.document.getElementById("timer");
  for (let i = 0; i < times; i++) {
    timer.textContent = String(i);
    timer.appendChild(window.document.createElement("span"));
    await tick(350);
  }
}

test("a failing alias lookup is not retried on every DOM change", async () => {
  const { window, calls } = load(() => ({ ok: false, status: 404 }));
  window.initContestLeaderboard();
  await tickTimer(window, 6);
  assert.equal(calls.length, 1, "one try, then wait out the retry delay");
});

test("a found alias is fetched once and the link injected", async () => {
  const { window, calls } = load(() => ({ json: { data: { attributes: { current_contest: { alias: "dsa-1" } } } } }));
  window.initContestLeaderboard();
  await tick(50);
  const link = window.document.querySelector("a.cr-stats__bottom");
  assert.ok(link, "link injected");
  assert.equal(link.getAttribute("href"), "/contest/dsa-1/scoreboard");
  await tickTimer(window, 3);
  assert.equal(calls.length, 1);
});

test("leaving the contest page stops the observer", () => {
  const { window } = load(() => ({ ok: false, status: 404 }));
  window.initContestLeaderboard();
  assert.ok(window._leaderboardObserver);
  window.history.pushState({}, "", "/academy/mentee-dashboard/todos");
  window.initContestLeaderboard();
  assert.equal(window._leaderboardObserver, null);
});
