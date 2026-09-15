const test = require("node:test");
const assert = require("node:assert/strict");

const {
  loadFeature,
  makeChrome,
  makeFetch,
  tick,
} = require("./helpers/harness");

test("a current cached profile causes no backend request", () => {
  const sent = [];
  const chrome = makeChrome({
    syncStore: {
      scaler_sync_version: 11,
      scaler_user: { email: "cached@example.com" },
    },
    sendMessage: (message) => sent.push(message),
  });
  const { window } = loadFeature("content/features/usernameTracker.js", {
    chrome,
  });

  window.initUsernameTracker();

  assert.deepEqual(sent, []);
});

test("a missing cached profile re-syncs without sending an activity ping", async () => {
  const sent = [];
  const chrome = makeChrome({
    syncStore: { scaler_sync_version: 11 },
    sendMessage: (message, callback) => {
      sent.push(message);
      if (typeof callback === "function") callback({ success: true });
    },
  });
  const fetch = makeFetch((url) => {
    if (url.endsWith("/analytics/")) {
      return {
        data: {
          attributes: {
            id: 42,
            name: "Cached User",
            gender: "male",
            email: "cached@example.com",
            orgyear: 2026,
            cohort: "2026",
          },
        },
      };
    }
    if (url.includes("performance-stats")) {
      return { performance: { cgrScore: 9001 } };
    }
    return { user_data: { current_user: {}, role: "mentee" } };
  });
  const { window } = loadFeature("content/features/usernameTracker.js", {
    chrome,
    fetch,
  });

  window.initUsernameTracker();
  await tick();

  assert.equal(sent.length, 1);
  assert.equal(sent[0].action, "syncUserProfile");
  assert.equal(chrome.__sync.scaler_user.email, "cached@example.com");
  assert.equal(sent.some((message) => message.action === "pingUser"), false);
});
