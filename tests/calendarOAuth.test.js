const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

function makeCalendarChrome(identity) {
  const listeners = {};

  return {
    runtime: {
      id: "test-extension-id",
      lastError: null,
      onInstalled: {
        addListener: (fn) => {
          listeners.installed = fn;
        },
      },
      onStartup: {
        addListener: (fn) => {
          listeners.startup = fn;
        },
      },
      onMessage: {
        addListener: (fn) => {
          listeners.message = fn;
        },
      },
      getManifest: () => ({
        oauth2: {
          client_id: "test-client",
        },
      }),
    },

    storage: {
      sync: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },

    alarms: {
      get: async () => null,
      onAlarm: {
        addListener: (fn) => {
          listeners.alarm = fn;
        },
      },
      create: () => {},
      clear: (_name, callback) => callback(true),
    },

    identity,
  };
}

test("calendar OAuth uses Firefox Promise API", async () => {
  let receivedOptions;

  const identity = {
    getRedirectURL: () => "https://test-extension.mozilla.org/callback",

    launchWebAuthFlow: async (options) => {
      receivedOptions = options;

      return (
        "https://test-extension.mozilla.org/callback" +
        "#access_token=firefox-token"
      );
    },
  };

  const browser = { identity };
  const chrome = makeCalendarChrome({});

  const { window } = loadFeature("background/calendarSync.js", {
    chrome,
    globals: { browser },
  });

  const token = await window._getWebToken();

  assert.equal(token, "firefox-token");
  assert.equal(receivedOptions.interactive, true);
  assert.match(
    receivedOptions.url,
    /redirect_uri=https%3A%2F%2Ftest-extension\.mozilla\.org%2Fcallback/,
  );
});

test("calendar OAuth preserves Chrome callback API", async () => {
  let receivedOptions;

  const identity = {
    getRedirectURL: () => "https://test-extension.chromiumapp.org/callback",

    launchWebAuthFlow: (options, callback) => {
      receivedOptions = options;

      callback(
        "https://test-extension.chromiumapp.org/callback" +
          "#access_token=chrome-token",
      );
    },
  };

  const chrome = makeCalendarChrome(identity);

  const { window } = loadFeature("background/calendarSync.js", {
    chrome,
  });

  const token = await window._getWebToken();

  assert.equal(token, "chrome-token");
  assert.equal(receivedOptions.interactive, true);
  assert.match(
    receivedOptions.url,
    /redirect_uri=https%3A%2F%2Ftest-extension\.chromiumapp\.org%2Fcallback/,
  );
});
