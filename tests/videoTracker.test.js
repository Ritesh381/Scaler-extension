// ============================================================
// videoTracker.test.js
// Service-worker side of multi-part lectures: capture tabs (opened inactive
// and muted, at most two at a time, cached briefly, always closed) and the
// `parts` hand-off to the processor pages.
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome } = require("./helpers/harness");

function loadTracker() {
  const chrome = makeChrome();
  const created = [];
  const removed = [];
  const updated = [];
  const onRemoved = [];
  let nextId = 100;
  chrome.runtime.getURL = (p) => `chrome-extension://ext/${p}`;
  chrome.tabs = {
    create: (opts, cb) => {
      const tab = { id: nextId++, ...opts };
      created.push(tab);
      if (cb) cb(tab);
    },
    update: (id, props, cb) => {
      updated.push([id, props]);
      if (cb) cb();
    },
    remove: (id, cb) => {
      removed.push(id);
      if (cb) cb();
      onRemoved.forEach((fn) => fn(id));
    },
    onRemoved: { addListener: (fn) => onRemoved.push(fn) },
    onUpdated: { addListener: () => {} },
  };
  loadFeature("background/videoTracker.js", { chrome });
  const listener = chrome.__messageListeners[0];
  const send = (request, tabId = 1) =>
    new Promise((resolve) => {
      if (listener(request, { tab: { id: tabId } }, resolve) !== true) {
        setTimeout(() => resolve(undefined), 0);
      }
    });
  const userClosesTab = (id) => onRemoved.forEach((fn) => fn(id));
  return { send, created, removed, updated, userClosesTab };
}

// Objects made inside the jsdom realm aren't deepEqual to ours; rebase them.
const plain = (x) => JSON.parse(JSON.stringify(x));

const PARTS = [
  { label: "Part 1", minutes: 15, url: "https://cdn.test/1/master.m3u8" },
  { label: "Part 2", minutes: 99, url: "https://cdn.test/2/master.m3u8" },
];
const capture = (key) => ({
  type: "CAPTURE_LECTURE_STREAMS",
  lectureUrl: `https://www.scaler.com/academy/mentee-dashboard/class/${key}/session`,
  lectureKey: key,
});

test("a capture opens an inactive, muted tab that alone is told to run the job", async () => {
  const t = loadTracker();
  const pending = t.send(capture("42"));

  assert.equal(t.created.length, 1);
  const tab = t.created[0];
  assert.equal(tab.active, false, "never steals focus");
  assert.match(tab.url, /\/class\/42\/session$/);
  assert.deepEqual(plain(t.updated), [[tab.id, { muted: true }]]);

  assert.deepEqual(plain(await t.send({ type: "IS_CAPTURE_TAB" }, tab.id)), { capture: true });
  assert.deepEqual(plain(await t.send({ type: "IS_CAPTURE_TAB" }, 1)), { capture: false });

  t.send({ type: "CAPTURE_RESULT", ok: true, parts: PARTS }, tab.id);
  const result = await pending;
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.parts), PARTS);
  assert.deepEqual(plain(t.removed), [tab.id], "capture tab closed once it reported");
});

test("a recent result is served from cache without another tab", async () => {
  const t = loadTracker();
  const first = t.send(capture("42"));
  t.send({ type: "CAPTURE_RESULT", ok: true, parts: PARTS }, t.created[0].id);
  await first;

  const again = await t.send(capture("42"));
  assert.deepEqual(plain(again.parts), PARTS);
  assert.equal(t.created.length, 1, "no second capture tab");
});

test("a capture tab closed early settles with an error", async () => {
  const t = loadTracker();
  const pending = t.send(capture("42"));
  t.userClosesTab(t.created[0].id);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /closed/);
});

test("at most two capture tabs run at once; the queue drains as they finish", async () => {
  const t = loadTracker();
  const jobs = ["1", "2", "3"].map((k) => t.send(capture(k)));
  assert.equal(t.created.length, 2, "third job waits");

  t.send({ type: "CAPTURE_RESULT", ok: false, error: "x" }, t.created[0].id);
  await jobs[0];
  assert.equal(t.created.length, 3, "third job started when a slot freed");

  t.send({ type: "CAPTURE_RESULT", ok: true, parts: [] }, t.created[1].id);
  t.send({ type: "CAPTURE_RESULT", ok: true, parts: [] }, t.created[2].id);
  await Promise.all(jobs);
});

test("INITIATE_DOWNLOAD forwards a multi-part lecture's parts to the processor page", async () => {
  const t = loadTracker();
  const parts = PARTS.map(({ label, url }) => ({ label, url }));
  await t.send({
    type: "INITIATE_DOWNLOAD",
    payload: { url: parts[0].url, type: "transcript", title: "L", lectureSlug: "s", classId: "42", parts },
  });
  const page = new URL(t.created[0].url);
  assert.match(page.pathname, /transcriptVersions\.html$/);
  assert.deepEqual(JSON.parse(page.searchParams.get("parts")), parts);
});

test("INITIATE_DOWNLOAD without parts keeps today's URL shape", async () => {
  const t = loadTracker();
  await t.send({
    type: "INITIATE_DOWNLOAD",
    payload: { url: "https://cdn.test/x.m3u8", type: "video", title: "L", lectureSlug: "s", classId: "42" },
  });
  assert.equal(new URL(t.created[0].url).searchParams.has("parts"), false);
});
