// ============================================================
// calendarSync.test.js
// Google Calendar sync (background/calendarSync.js) against a fake Calendar
// API: the OAuth scope it asks for, the "Scaler classes" calendar it keeps,
// and how lessons are added, updated and left alone.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { loadFeature, readFeature, EXTENSION_ROOT } = require("./helpers/harness");

const MANIFEST = JSON.parse(fs.readFileSync(path.join(EXTENSION_ROOT, "manifest.json"), "utf8"));
const APP_CREATED = "https://www.googleapis.com/auth/calendar.app.created";
const API = "https://www.googleapis.com/calendar/v3";

// Scopes Google classes as sensitive or restricted. An unverified app asking
// for any of them is shown "This app is blocked" (issue #29).
const BLOCKED_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/calendar.events.owned",
];

const lesson = (id, title, start, end, extra = {}) => ({
  sbat_id: id,
  title,
  event_type: "lesson",
  date: start,
  end_time: end,
  instructors_name: "A. Teacher",
  super_batch_name: "SST 2028",
  ...extra,
});

const LESSONS = [
  lesson(594121, "TCP vs UDP vs Custom Protocols #1", "2026-11-18T04:00:00.000Z", "2026-11-18T06:00:00.000Z"),
  lesson(594122, "IO Models", "2026-11-19T04:00:00.000Z", "2026-11-19T06:00:00.000Z"),
];

/** An in-memory Google Calendar for one account, plus a request log. */
function fakeGoogle({ lessons = LESSONS, foreignCalendars = [] } = {}) {
  const g = { calendars: new Map(), log: [], lessons, nextId: 1, failInsert: null };
  const json = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  g.fetch = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    g.log.push(`${method} ${url}`);
    if (url.startsWith("https://www.scaler.com/academy/mentee/events/")) {
      return json(200, { pastEvents: [], futureEvents: g.lessons });
    }
    const u = new URL(url);
    const parts = u.pathname.replace("/calendar/v3/", "").split("/").map(decodeURIComponent);
    if (parts[1] === "primary") return json(500, { error: "the user's own calendar must not be touched" });
    if (parts[0] !== "calendars") return json(400, {});
    if (parts.length === 1 && method === "POST") {
      const id = `cal${g.nextId++}@group.calendar.google.com`;
      g.calendars.set(id, { meta: JSON.parse(init.body), events: new Map() });
      return json(200, { id, ...JSON.parse(init.body) });
    }
    const cal = g.calendars.get(parts[1]);
    if (!cal) return json(foreignCalendars.includes(parts[1]) ? 403 : 404, { error: "notFound" });
    if (parts.length === 2) return json(200, { id: parts[1], ...cal.meta });
    if (parts.length === 3 && method === "POST") {
      const ev = JSON.parse(init.body);
      if (g.failInsert) return json(g.failInsert, { error: "rejected" });
      if (cal.events.has(ev.id)) return json(409, { error: "duplicate" });
      cal.events.set(ev.id, { ...ev, status: "confirmed" });
      return json(200, ev);
    }
    const ev = cal.events.get(parts[3]);
    if (!ev) return json(404, { error: "notFound" });
    if (method === "GET") return json(200, ev);
    if (method === "PATCH") {
      Object.assign(ev, JSON.parse(init.body));
      return json(200, ev);
    }
    return json(400, {});
  };
  g.events = () => [...g.calendars.values()].flatMap((c) => [...c.events.values()]);
  return g;
}

function fakeChrome({ syncStore = {}, webRedirect = null } = {}) {
  const sync = { ...syncStore };
  const listeners = { onInstalled: [], onStartup: [], onAlarm: [], onMessage: [] };
  const on = (list) => ({ addListener: (fn) => list.push(fn) });
  const chrome = {
    runtime: {
      id: "ext",
      lastError: null,
      getManifest: () => MANIFEST,
      onInstalled: on(listeners.onInstalled),
      onStartup: on(listeners.onStartup),
      onMessage: on(listeners.onMessage),
    },
    storage: {
      sync: {
        get: async (key) => (key in sync ? { [key]: sync[key] } : {}),
        set: async (obj) => Object.assign(sync, obj),
      },
    },
    alarms: { create() {}, clear(_, cb) { if (cb) cb(true); }, get: async () => null, onAlarm: on(listeners.onAlarm) },
    identity: {
      getAuthToken: (opts, cb) => cb("chrome-token"),
      removeCachedAuthToken: (_, cb) => cb(),
      getRedirectURL: () => "https://ext.chromiumapp.org/",
      launchWebAuthFlow: (opts, cb) => {
        chrome.__webAuthUrl = opts.url;
        cb(webRedirect);
      },
    },
    __sync: sync,
    __listeners: listeners,
  };
  return chrome;
}

function load({ google = fakeGoogle(), chrome = fakeChrome() } = {}) {
  const { window } = loadFeature([], { chrome, fetch: google.fetch });
  window.eval(readFeature("background/fetchTimeout.js"));
  window.eval(readFeature("background/calendarSync.js"));
  return { window, google, chrome };
}

const quiet = async (fn) => {
  const { log, warn, error } = console;
  console.log = console.warn = console.error = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, { log, warn, error });
  }
};

test("asks Google only for calendar.app.created, the scope that isn't blocked", async () => {
  assert.deepEqual(MANIFEST.oauth2.scopes, [APP_CREATED], "manifest scopes (getAuthToken)");
  for (const scope of BLOCKED_SCOPES) {
    assert.ok(!MANIFEST.oauth2.scopes.includes(scope), `${scope} would bring the block back`);
  }

  // The web flow (Brave, Arc, no signed-in profile) asks for the same scope,
  // and lets the user pick an account.
  const chrome = fakeChrome();
  chrome.identity.getAuthToken = undefined;
  chrome.runtime.lastError = null;
  const { window } = load({ chrome });
  chrome.identity.launchWebAuthFlow = (opts, cb) => {
    chrome.__webAuthUrl = opts.url;
    cb("https://ext.chromiumapp.org/#access_token=web-token&token_type=Bearer");
  };
  await quiet(() => window.performSync(true));
  const auth = new URL(chrome.__webAuthUrl);
  assert.equal(auth.searchParams.get("scope"), APP_CREATED);
  assert.equal(auth.searchParams.get("prompt"), "select_account");
});

test("first sync creates the Scaler classes calendar and adds each lesson there, never to primary", async () => {
  const { window, google, chrome } = load();
  const result = await quiet(() => window.performSync(true));

  assert.equal(google.calendars.size, 1, "one calendar created");
  const [[calId, cal]] = [...google.calendars];
  assert.equal(cal.meta.summary, "Scaler classes");
  assert.deepEqual([...chrome.__sync.scaler_calendar_ids], [calId], "its id is remembered");
  assert.deepEqual(
    google.events().map((e) => [e.id, e.summary, e.start.dateTime]),
    [
      ["scalerpp594121", "TCP vs UDP vs Custom Protocols #1", "2026-11-18T04:00:00.000Z"],
      ["scalerpp594122", "IO Models", "2026-11-19T04:00:00.000Z"],
    ],
  );
  assert.deepEqual({ ...result }, { added: 2, updated: 0, skipped: 0 });
  assert.ok(!google.log.some((l) => l.includes("/primary")), "the primary calendar is never touched");
});

test("a second sync reuses the calendar, skips unchanged lessons and updates a rescheduled one", async () => {
  const { window, google } = load();
  await quiet(() => window.performSync(true));
  google.lessons = [
    LESSONS[0],
    { ...LESSONS[1], date: "2026-11-19T05:00:00.000Z", end_time: "2026-11-19T07:00:00.000Z" },
  ];
  google.log.length = 0;
  const result = await quiet(() => window.performSync(false));

  assert.equal(google.calendars.size, 1, "no second calendar");
  assert.deepEqual({ ...result }, { added: 0, updated: 1, skipped: 1 });
  const moved = google.events().find((e) => e.id === "scalerpp594122");
  assert.equal(moved.start.dateTime, "2026-11-19T05:00:00.000Z", "moved in place, not duplicated");
  assert.equal(google.events().length, 2);
});

test("a time Google echoes back in another offset still counts as unchanged", async () => {
  const { window, google } = load();
  await quiet(() => window.performSync(true));
  const ev = google.events()[0];
  ev.start = { dateTime: "2026-11-18T09:30:00+05:30", timeZone: "Asia/Kolkata" };
  ev.end = { dateTime: "2026-11-18T11:30:00+05:30", timeZone: "Asia/Kolkata" };
  const result = await quiet(() => window.performSync(true));
  assert.deepEqual({ ...result }, { added: 0, updated: 0, skipped: 2 });
});

test("an event the user deleted stays deleted", async () => {
  const { window, google } = load();
  await quiet(() => window.performSync(true));
  google.events()[0].status = "cancelled";
  const result = await quiet(() => window.performSync(true));
  assert.equal(google.events()[0].status, "cancelled");
  assert.deepEqual({ ...result }, { added: 0, updated: 0, skipped: 2 });
});

test("a deleted calendar, or another account's, is replaced by a new one", async () => {
  const google = fakeGoogle({ foreignCalendars: ["other@group.calendar.google.com"] });
  const chrome = fakeChrome({ syncStore: { scaler_calendar_ids: ["other@group.calendar.google.com", "gone@group.calendar.google.com"] } });
  const { window } = load({ google, chrome });
  await quiet(() => window.performSync(true));

  assert.equal(google.calendars.size, 1, "created one");
  const [calId] = google.calendars.keys();
  assert.deepEqual(
    [...chrome.__sync.scaler_calendar_ids],
    [calId, "other@group.calendar.google.com", "gone@group.calendar.google.com"],
    "the new one first; the other account's id is kept for that account",
  );
});

test("a lesson without a class id still gets a stable, valid event id", async () => {
  const google = fakeGoogle({ lessons: [lesson(undefined, "Mentor Q&A", "2026-11-20T04:00:00.000Z", "2026-11-20T05:00:00.000Z")] });
  const { window } = load({ google });
  await quiet(() => window.performSync(true));
  await quiet(() => window.performSync(true));
  const ids = google.events().map((e) => e.id);
  assert.equal(ids.length, 1, "synced twice, stored once");
  assert.match(ids[0], /^[0-9a-v]{5,1024}$/, "base32hex, as Google requires");
});

test("authorization refused on every write: the sync fails instead of reporting success", async () => {
  const google = fakeGoogle();
  google.failInsert = 403;
  const { window } = load({ google });
  await assert.rejects(quiet(() => window.performSync(true)), /rejected the authorization/);
});

test("a blocked or cancelled Google sign-in explains what to do", async () => {
  const chrome = fakeChrome({ webRedirect: "https://ext.chromiumapp.org/#error=access_denied" });
  chrome.identity.getAuthToken = (opts, cb) => {
    chrome.runtime.lastError = { message: "The user did not approve access." };
    cb(undefined);
    chrome.runtime.lastError = null;
  };
  const { window } = load({ chrome });
  await assert.rejects(
    quiet(() => window.performSync(true)),
    (err) => /access_denied/.test(err.message) && /personal Google account/.test(err.message),
  );
});

test("Sync Now reports how many classes it added or updated", async () => {
  const { chrome } = load();
  const [onMessage] = chrome.__listeners.onMessage;
  const response = await quiet(
    () => new Promise((resolve) => onMessage({ action: "SYNC_CALENDAR" }, {}, resolve)),
  );
  assert.deepEqual({ ...response }, { success: true, added: 2, updated: 0, skipped: 0 });
});
