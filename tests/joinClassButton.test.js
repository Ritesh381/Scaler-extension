const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

// Freeze window.Date to a fixed local instant. The feature reads `new Date()`
// at call time, so overriding after load is enough.
function freezeDate(window, y, mo, d, h, mi) {
  const RealDate = window.Date;
  const fixedTs = new RealDate(y, mo, d, h, mi, 0, 0).getTime();
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixedTs);
      else super(...args);
    }
    static now() {
      return fixedTs;
    }
  }
  window.Date = FakeDate;
}

test("parseClassTime converts 12-hour strings to today's time", () => {
  const { window } = loadFeature("content/features/joinClassButton.js");
  freezeDate(window, 2026, 5, 11, 14, 0); // 2026-06-11 14:00 local

  const t1 = window.parseClassTime("02:30 PM");
  assert.equal(t1.getHours(), 14);
  assert.equal(t1.getMinutes(), 30);

  const t2 = window.parseClassTime("12:00 AM");
  assert.equal(t2.getHours(), 0);

  const t3 = window.parseClassTime("12:30 PM");
  assert.equal(t3.getHours(), 12);

  const t4 = window.parseClassTime("11:45 PM");
  assert.equal(t4.getHours(), 23);
  assert.equal(t4.getMinutes(), 45);
});

test("parseClassTime returns null on bad input", () => {
  const { window } = loadFeature("content/features/joinClassButton.js");
  assert.equal(window.parseClassTime(""), null);
  assert.equal(window.parseClassTime("not a time"), null);
  assert.equal(window.parseClassTime("14:30"), null); // missing AM/PM
  assert.equal(window.parseClassTime("2:5 PM"), null); // minutes need two digits
});

test("isClassLiveNow: true inside window, false before/after", () => {
  const { window } = loadFeature("content/features/joinClassButton.js");
  freezeDate(window, 2026, 5, 11, 14, 0); // now = 14:00

  assert.equal(window.isClassLiveNow("01:00 PM", "04:00 PM"), true);
  assert.equal(window.isClassLiveNow("03:00 PM", "04:00 PM"), false); // not started
  assert.equal(window.isClassLiveNow("12:00 PM", "01:00 PM"), false); // ended
  assert.equal(window.isClassLiveNow("bad", "04:00 PM"), false);
});

test("getActiveDashboardDate parses the active tab", () => {
  const { window } = loadFeature("content/features/joinClassButton.js", {
    html: `<!DOCTYPE html><html><body>
      <div class="tabs__header">
        <div class="tabs__tab">10 Jun</div>
        <div class="tabs__tab tabs__tab--active">11 Jun</div>
      </div>
    </body></html>`,
  });
  freezeDate(window, 2026, 5, 11, 14, 0);

  const d = window.getActiveDashboardDate();
  assert.equal(d.getDate(), 11);
  assert.equal(d.getMonth(), 5); // June
  assert.equal(window.isActiveDateToday(), true);
});

test("isActiveDateToday is false when the active tab is another day", () => {
  const { window } = loadFeature("content/features/joinClassButton.js", {
    html: `<!DOCTYPE html><html><body>
      <div class="tabs__header">
        <div class="tabs__tab tabs__tab--active">10 Jun</div>
      </div>
    </body></html>`,
  });
  freezeDate(window, 2026, 5, 11, 14, 0);
  assert.equal(window.isActiveDateToday(), false);
});

test("extractClassTimes pulls start/end, ignoring the separator span", () => {
  const { window } = loadFeature("content/features/joinClassButton.js", {
    html: `<!DOCTYPE html><html><body>
      <div class="card">
        <div class="_1EQZYaGMSYVhKTiIKY-qXP">
          <div>
            <span>02:30 PM</span>
            <span class="m-l-5 m-r-5">-</span>
            <span>04:30 PM</span>
          </div>
          <span class="_3cg2nc-UIVR1CzIB7nNQ8Z">View Details</span>
        </div>
      </div>
    </body></html>`,
  });

  const card = window.document.querySelector(".card");
  // Spread rebases the jsdom-realm object onto Node's Object prototype.
  assert.deepEqual({ ...window.extractClassTimes(card) }, {
    start: "02:30 PM",
    end: "04:30 PM",
  });
});

test("extractClassTimes returns null when the time wrapper is absent", () => {
  const { window } = loadFeature("content/features/joinClassButton.js", {
    html: `<!DOCTYPE html><html><body><div class="card"></div></body></html>`,
  });
  const card = window.document.querySelector(".card");
  assert.equal(window.extractClassTimes(card), null);
});

test("observer re-roots when the SPA replaces the dashboard, and stops off the dashboard", () => {
  const { window } = loadFeature("content/features/joinClassButton.js", {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: `<!DOCTYPE html><html><body><div id="app"><div class="mentee-dashboard__content"></div></div></body></html>`,
    globals: { currentSettings: {} },
  });
  window.initJoinSessionButtons();
  const first = window._joinSessionObserverRoot;
  assert.ok(first, "watching the dashboard");

  // Same root: re-init keeps the observer.
  const observer = window._joinSessionObserver;
  window.initJoinSessionButtons();
  assert.equal(window._joinSessionObserver, observer);

  // The SPA swaps in a new dashboard container: the old one is detached.
  const app = window.document.getElementById("app");
  app.innerHTML = '<div class="mentee-dashboard__content"></div>';
  window.initJoinSessionButtons();
  assert.notEqual(window._joinSessionObserverRoot, first, "re-rooted");
  assert.ok(window._joinSessionObserverRoot.isConnected);

  window.history.pushState({}, "", "/topics");
  window.initJoinSessionButtons();
  assert.equal(window._joinSessionObserver, null, "stopped off the dashboard");
});
