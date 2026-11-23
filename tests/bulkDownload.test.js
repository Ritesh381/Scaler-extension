// ============================================================
// bulkDownload.test.js
// The subject class-list side of bulk download: reading lecture rows,
// the "Bulk download" bar, the picker, and teardown.
// The fixture follows the class list page (core-curriculum/m/{id}/classes).
// ============================================================

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature, makeChrome, makeFetch } = require("./helpers/harness");

const FILES = [
  "content/utils/domUtils.js",
  "content/utils/stringUtils.js",
  "content/features/bulkDownload/bulkDownload.js",
];
const PAGE_URL = "https://www.scaler.com/academy/mentee-dashboard/core-curriculum/m/440/classes";

const row = ({ id, when, title, link = true, split = true }) => {
  const stamp = split
    ? `<span>${when.split("|")[0].trim()}</span><span>|</span><span>${when.split("|")[1].trim()}</span>`
    : `<span>${when}</span>`;
  const cells = `
      <div class="when">${stamp}</div>
      <div class="title">${title}</div>
      <div class="stat"><div>Lecture</div><div>0.0%</div></div>
      <div class="stat"><div>Assignment</div><div>5 / 5</div></div>
      <div class="stat"><div>Additional Problem</div><div>-</div></div>
      <i class="cr-icon-chevron">chevron_right</i>`;
  return link
    ? `<a class="row" href="/academy/mentee-dashboard/class/${id}/session">${cells}</a>`
    : `<div class="row">${cells}</div>`;
};

const PAGE = (rows) => `<!DOCTYPE html><html><body>
  <aside>
    <div><div>SUBJECT - 1</div><div>SST DevOps &amp; Cloud [SWE]</div></div>
    <div><div>SUBJECT - 2</div><div>SST Forward Deployment Engineer</div></div>
  </aside>
  <main>
    <header><div><span>SUBJECT - 1</span><span>4 weeks</span></div><h2>SST DevOps &amp; Cloud [SWE]</h2></header>
    <div class="list">
      ${rows.join("\n")}
      <div class="row contest">
        <div class="when">19 OCT | 06:30 PM</div>
        <div class="title"><i class="cr-icon-trophy"></i> DevOps End Term - 2028</div>
        <div>Score - 92/100</div>
        <a href="/academy/mentee-dashboard/class/999/contest">View Details</a>
      </div>
    </div>
  </main>
</body></html>`;

const ROWS = [
  row({ id: 101, when: "11 AUG | 03:45 PM", title: "Introduction to DevOps &amp; Microservices" }),
  row({ id: 102, when: "13 AUG | 09:35 AM", title: "Linux Fundamentals" }),
  row({ id: 103, when: "13 AUG | 11:30 AM", title: "DevOps Lab 1", split: false }),
];

function load(rows = ROWS, opts = {}) {
  const sent = [];
  const chrome = makeChrome({ sendMessage: (msg, cb) => { sent.push(msg); if (cb) cb({}); } });
  const { window } = loadFeature(FILES, { html: PAGE(rows), url: PAGE_URL, chrome, ...opts });
  return { window, sent };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test("findLectureRows reads lectures in order and skips the contest row", () => {
  const { window } = load();
  const rows = window.findLectureRows(window.document);
  assert.deepEqual(
    plain(rows.map(({ index, stamp, title, classId }) => ({ index, stamp, title, classId }))),
    [
      { index: 1, stamp: "11 AUG | 03:45 PM", title: "Introduction to DevOps & Microservices", classId: "101" },
      { index: 2, stamp: "13 AUG | 09:35 AM", title: "Linux Fundamentals", classId: "102" },
      { index: 3, stamp: "13 AUG | 11:30 AM", title: "DevOps Lab 1", classId: "103" },
    ],
  );
});

test("findSubjectName takes the header above the list, not the subjects column", () => {
  const { window } = load();
  assert.equal(window.findSubjectName(window.document), "SST DevOps & Cloud [SWE]");
});

test("rows without a /class/ link get their id from the events feed, matched by title", async () => {
  const rows = [
    row({ id: 0, when: "18 AUG | 03:45 PM", title: "Shell Scripting", link: false }),
    row({ id: 0, when: "18 AUG | 05:45 PM", title: "Unknown Session", link: false }),
  ];
  let asked = "";
  const fetch = makeFetch((url) => {
    asked = url;
    return { json: { pastEvents: [{ sbat_id: 555, title: "Shell  scripting" }], futureEvents: [] } };
  });
  const { window } = load(rows, { fetch });
  const lectures = window.findLectureRows(window.document);
  assert.equal(lectures[0].classId, null);
  await window.resolveMissingClassIds(lectures);
  assert.equal(lectures[0].classId, "555", "matched ignoring case and spacing");
  assert.equal(lectures[1].classId, null, "no match stays unavailable");
  assert.match(asked, /\/academy\/mentee\/events\/\?start_date=\d{4}-08-17&end_date=\d{4}-08-19/);
});

test("bulkStampToDate infers the year: never more than 60 days ahead", () => {
  const { window } = load();
  const now = new Date(2027, 0, 10); // 10 Jan 2027
  const dec = window.bulkStampToDate("20 DEC | 06:30 PM", now);
  assert.equal(dec.getFullYear(), 2026, "December seen in January is last year's");
  assert.equal(dec.getHours(), 18);
  assert.equal(window.bulkStampToDate("05 FEB | 09:00 AM", now).getFullYear(), 2027);
  assert.equal(window.bulkStampToDate("nonsense", now), null);
});

test("the bar is added once, above the list", () => {
  const { window } = load();
  window.initBulkDownload();
  window.initBulkDownload(); // re-init on navigation is idempotent
  const bars = window.document.querySelectorAll("#scaler-bulk-download-bar");
  assert.equal(bars.length, 1);
  assert.equal(bars[0].nextElementSibling.className, "list");
  assert.ok(!window._bulkDownloadObserver, "nothing left watching once the bar is in");
});

test("off the class list the feature adds nothing and keeps nothing running", () => {
  const { window } = load(ROWS, { url: "https://www.scaler.com/academy/mentee-dashboard/todos" });
  window.initBulkDownload();
  assert.equal(window.document.getElementById("scaler-bulk-download-bar"), null);
  assert.ok(!window._bulkDownloadObserver);
});

test("the picker: From/To range, shift-click, then Start sends the chosen lectures", () => {
  const { window, sent } = load();
  const doc = window.document;
  window.openBulkModal(window.findLectureRows(doc), "SST DevOps & Cloud [SWE]");
  const modal = doc.getElementById("scaler-bulk-download-modal");
  const boxes = Array.from(modal.querySelectorAll(".sbd-list input"));
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, false], "everything but the lab selected to start");

  const from = modal.querySelector(".sbd-from");
  from.value = "1";
  from.dispatchEvent(new window.Event("change"));
  assert.deepEqual(boxes.map((b) => b.checked), [false, true, false], "range 2–3, lab left out");

  modal.querySelector(".sbd-none").click();
  boxes[0].click(); // check 1
  boxes[1].dispatchEvent(new window.MouseEvent("click", { shiftKey: true, bubbles: true }));
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, false], "shift-click fills the range");
  boxes[2].click(); // tick the lab by hand — always allowed
  boxes[1].click(); // uncheck 2

  modal.querySelector('.sbd-type[value="video"]').checked = true;
  modal.querySelector(".sbd-gen").checked = true;
  modal.querySelector(".sbd-start").click();

  const msg = sent.find((m) => m.type === "START_BULK_DOWNLOAD");
  assert.ok(msg, "job sent");
  assert.deepEqual(plain(msg.job.types), { transcript: true, video: true, audio: false });
  assert.equal(msg.job.generateMissing, true);
  assert.equal(msg.job.subject, "SST DevOps & Cloud [SWE]");
  assert.deepEqual(
    plain(msg.job.lectures.map((l) => [l.index, l.classId, l.url])),
    [
      [1, "101", "https://www.scaler.com/academy/mentee-dashboard/class/101/session?joinSession=1"],
      [3, "103", "https://www.scaler.com/academy/mentee-dashboard/class/103/session?joinSession=1"],
    ],
  );
  assert.equal(doc.getElementById("scaler-bulk-download-modal"), null, "picker closes on start");
});

test("Start refuses an empty selection", () => {
  const { window, sent } = load();
  window.openBulkModal(window.findLectureRows(window.document), "");
  const modal = window.document.getElementById("scaler-bulk-download-modal");
  modal.querySelector(".sbd-none").click();
  modal.querySelector(".sbd-start").click();
  assert.equal(sent.length, 0);
  assert.match(modal.querySelector(".sbd-count").textContent, /Pick at least one lecture/);
});

test("Escape closes the picker and its document listener goes with it", () => {
  const { window } = load();
  const doc = window.document;
  window.openBulkModal(window.findLectureRows(doc), "");
  doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
  assert.equal(doc.getElementById("scaler-bulk-download-modal"), null);

  // A second Escape after reopening must not hit a stale listener.
  window.openBulkModal(window.findLectureRows(doc), "");
  window.closeBulkModal();
  assert.doesNotThrow(() => doc.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" })));
});

test("teardown removes the bar and an open picker", () => {
  const { window } = load();
  window.initBulkDownload();
  window.openBulkModal(window.findLectureRows(window.document), "");
  window.teardownBulkDownload();
  assert.equal(window.document.getElementById("scaler-bulk-download-bar"), null);
  assert.equal(window.document.getElementById("scaler-bulk-download-modal"), null);
});

test("a list that renders after navigation gets the bar, then the observer stops", async () => {
  const { window } = load([]);
  // The empty page still has the contest row, which is not a lecture.
  window.initBulkDownload();
  assert.ok(window._bulkDownloadObserver, "waiting for the list");
  window.document.querySelector(".list").insertAdjacentHTML("afterbegin", ROWS[0]);
  await new Promise((r) => setTimeout(r, 500)); // debounce is 400 ms
  assert.ok(window.document.getElementById("scaler-bulk-download-bar"), "bar added");
  assert.equal(window._bulkDownloadObserver, null, "observer disconnected");
});

test("a page whose only stamp is a contest yields no lectures (and doesn't throw)", () => {
  const { window } = load([]);
  assert.deepEqual(plain(window.findLectureRows(window.document)), []);
});

test("a row that leads with icon text is still read whole", () => {
  const iconRow = `<a class="row" href="/academy/mentee-dashboard/class/104/session">
      <i class="material-icons">event</i>
      <div class="when"><span>18 AUG</span><span>|</span><span>05:45 PM</span></div>
      <div class="title">DevOps Lab 2</div>
      <div class="stat"><div>Lecture</div><div>0.0%</div></div>
    </a>`;
  const { window } = load([ROWS[0], iconRow]);
  const rows = window.findLectureRows(window.document);
  assert.deepEqual(plain(rows.map((r) => [r.stamp, r.title, r.classId])), [
    ["11 AUG | 03:45 PM", "Introduction to DevOps & Microservices", "101"],
    ["18 AUG | 05:45 PM", "DevOps Lab 2", "104"],
  ]);
});

// ── Scaler's real markup (tests/fixtures/scaler-class-row.html) ──────────────

test("real Scaler class-list rows: mixed-case stamp, CSS-free pipe span, title link", () => {
  const raw = require("fs")
    .readFileSync(require("path").join(__dirname, "fixtures/scaler-class-row.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/, "")
    .trim();
  // Two rows, as on the page: the second with another id/title/time.
  const second = raw.replace(/567320/g, "567321").replace("Linux Fundamentals", "DevOps Lab 1").replace("09:35 AM", "11:30 AM");
  const { window } = load([raw, second]);
  const rows = window.findLectureRows(window.document);
  assert.deepEqual(plain(rows.map((r) => [r.index, r.stamp, r.title, r.classId])), [
    [1, "13 AUG | 09:35 AM", "Linux Fundamentals", "567320"],
    [2, "13 AUG | 11:30 AM", "DevOps Lab 1", "567321"],
  ]);
  window.initBulkDownload();
  assert.ok(window.document.getElementById("scaler-bulk-download-bar"), "bar injected above the real rows");
});

test("rows dated Yesterday / Today / Tomorrow are read, with their real date", () => {
  const raw = require("fs")
    .readFileSync(require("path").join(__dirname, "fixtures/scaler-class-row.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/, "")
    .trim();
  // Scaler replaces the date of a class within a day of now with a word.
  const relative = (word, id, title) =>
    raw.replace("13 Aug", word).replace(/567320/g, id).replace("Linux Fundamentals", title);
  const { window } = load([
    raw,
    relative("Yesterday", "601", "TCP vs UDP vs Custom Protocols #2"),
    relative("TODAY", "602", "Packet Capture, Analysis &amp; Parsing"),
    relative("Tomorrow", "603", "IO Models"),
  ]);
  const now = new Date(2026, 10, 17, 12, 0); // 17 Nov 2026, noon
  const rows = window.findLectureRows(window.document, now);
  assert.deepEqual(plain(rows.map((r) => [r.index, r.stamp, r.title, r.classId])), [
    [1, "13 AUG | 09:35 AM", "Linux Fundamentals", "567320"],
    [2, "16 NOV | 09:35 AM", "TCP vs UDP vs Custom Protocols #2", "601"],
    [3, "17 NOV | 09:35 AM", "Packet Capture, Analysis & Parsing", "602"],
    [4, "18 NOV | 09:35 AM", "IO Models", "603"],
  ]);
});

test("a relative day crosses month and year ends", () => {
  const { window } = load();
  const stampOf = (word, now) => {
    const el = window.document.createElement("div");
    el.innerHTML = `<div>${word}<span>|</span>09:30 AM</div><a href="/academy/mentee-dashboard/class/7">T</a><div>Lecture</div>`;
    return window.describeClassRow(el, now).stamp;
  };
  assert.equal(stampOf("Yesterday", new Date(2026, 11, 1, 8, 0)), "30 NOV | 09:30 AM");
  assert.equal(stampOf("Tomorrow", new Date(2026, 11, 31, 8, 0)), "1 JAN | 09:30 AM");
  const jan1 = window.bulkStampToDate("Yesterday | 09:30 AM", new Date(2027, 0, 1, 8, 0));
  assert.deepEqual([jan1.getFullYear(), jan1.getMonth(), jan1.getDate(), jan1.getHours()], [2026, 11, 31, 9]);
});

test("the bar appears on a list whose only rows are relative days", () => {
  const raw = require("fs")
    .readFileSync(require("path").join(__dirname, "fixtures/scaler-class-row.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/, "")
    .trim();
  const { window } = load([raw.replace("13 Aug", "Today"), raw.replace("13 Aug", "Tomorrow").replace(/567320/g, "9")]);
  window.initBulkDownload();
  assert.ok(window.document.getElementById("scaler-bulk-download-bar"));
  assert.equal(window.findLectureRows(window.document).length, 2, "each row is its own row, not one merged block");
});

test("a subject with a single class: the bar goes above the list, not into the page layout", () => {
  const raw = require("fs")
    .readFileSync(require("path").join(__dirname, "fixtures/scaler-class-row.html"), "utf8")
    .replace(/<!--[\s\S]*?-->/, "")
    .trim();
  // Scaler's layout has no <main>: sidebar and content are sibling divs, so
  // with one stamp on the page nothing stopped the row from widening upward.
  const html = `<!DOCTYPE html><html><body><div id="layout">
    <div id="sidebar">
      <div><div>SUBJECT - 1</div><div>SST Building Mobile Applications</div></div>
      <div><div>SUBJECT - 2</div><div>SST Data Engineering [SWE]</div></div>
    </div>
    <div id="content">
      <div id="header"><div><span>SUBJECT - 2</span><span>4 weeks</span></div><div>SST Data Engineering [SWE]</div><div>Classes 1/1</div></div>
      <div id="list-wrap"><div id="list">${raw}</div></div>
    </div>
  </div></body></html>`;
  const { window } = loadFeature(FILES, { html, url: PAGE_URL, chrome: makeChrome() });
  const rows = window.findLectureRows(window.document);
  assert.deepEqual(plain(rows.map((r) => [r.stamp, r.title, r.classId])), [
    ["13 AUG | 09:35 AM", "Linux Fundamentals", "567320"],
  ]);
  assert.equal(rows[0].el.parentElement.id, "list", "the row stops at the row, not the page");
  window.initBulkDownload();
  const bar = window.document.getElementById("scaler-bulk-download-bar");
  assert.ok(bar, "bar injected");
  assert.equal(bar.parentElement.id, "list-wrap", "bar sits right above the class list");
  assert.equal(window.findSubjectName(window.document), "SST Data Engineering [SWE]");
});

test("lab classes are unticked and tagged; ranges skip them unless Include labs is ticked", () => {
  const { window } = load();
  window.openBulkModal(window.findLectureRows(window.document), "");
  const modal = window.document.getElementById("scaler-bulk-download-modal");
  const boxes = Array.from(modal.querySelectorAll(".sbd-list input"));
  const labRow = boxes[2].closest("label");
  assert.match(labRow.textContent, /DevOps Lab 1/);
  assert.ok(labRow.querySelector(".sbd-lab"), "tagged as a lab");

  modal.querySelector(".sbd-all").click();
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, false], "All leaves the lab out");

  const include = modal.querySelector(".sbd-include-labs");
  include.checked = true;
  include.dispatchEvent(new window.Event("change"));
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, true], "Include labs ticks labs in the range");
  include.checked = false;
  include.dispatchEvent(new window.Event("change"));
  assert.equal(boxes[2].checked, false, "and unticks them again");
});

test("isLabClass matches the word lab, not words containing it", () => {
  const { window } = load();
  assert.equal(window.isLabClass("DevOps Lab 1"), true);
  assert.equal(window.isLabClass("lab: networking"), true);
  assert.equal(window.isLabClass("Collaboration & Labelling"), false);
  assert.equal(window.isLabClass("Introduction to DevOps"), false);
});

// ── Classes that haven't finished ────────────────────────────────────────────
// A class list also holds the class running now and the ones still to come.
// None has a recording, so the picker must not offer them.

const AT = new Date(2026, 7, 13, 10, 0); // 13 Aug 2026, 10:00 — 25 min into row 102
const iso = (h, m = 0) => new Date(2026, 7, 13, h, m).toISOString();
const FEED = {
  pastEvents: [
    { sbat_id: 101, title: "Introduction", date: "2026-08-11T10:15:00.000Z", end_time: "2026-08-11T12:45:00.000Z" },
    { sbat_id: 102, title: "Linux Fundamentals", date: iso(9, 35), end_time: iso(12, 5) },
  ],
  futureEvents: [{ sbat_id: 103, title: "DevOps Lab 1", date: iso(11, 30), end_time: iso(13, 30) }],
};

test("classes still running or still to come are marked from the events feed", async () => {
  let asked = "";
  const fetch = makeFetch((url) => {
    asked = url;
    return { json: FEED };
  });
  const { window } = load(ROWS, { fetch });
  const lectures = window.findLectureRows(window.document);
  await window.markUnfinishedClasses(lectures, AT);

  assert.deepEqual(plain(lectures.map((l) => [l.classId, l.pending || "", !!l.pendingSure])), [
    ["101", "", false],
    ["102", "live", true],
    ["103", "upcoming", true],
  ]);
  assert.match(asked, /\/academy\/mentee\/events\/\?start_date=2026-08-12&end_date=2027-08-1\d$/, "from yesterday, a year ahead");
});

test("a class the feed shows as ended is finished, even minutes after its start time", async () => {
  const ended = { ...FEED, pastEvents: [FEED.pastEvents[0], { ...FEED.pastEvents[1], end_time: iso(9, 55) }] };
  const { window } = load(ROWS, { fetch: makeFetch(() => ({ json: ended })) });
  const lectures = window.findLectureRows(window.document);
  await window.markUnfinishedClasses(lectures, AT);
  assert.equal(lectures[1].pending || "", "", "ended early: its recording can be asked for");
});

test("without the events feed, a class's own date decides, and the verdict is not binding", async () => {
  const { window } = load(ROWS, { fetch: makeFetch(() => ({ status: 500 })) });
  const lectures = window.findLectureRows(window.document);
  await window.markUnfinishedClasses(lectures, AT);
  assert.deepEqual(plain(lectures.map((l) => [l.pending || "", !!l.pendingSure])), [
    ["", false],
    ["live", false], // started 25 minutes ago; no end time to go by
    ["upcoming", false],
  ]);
});

test("the picker leaves unfinished classes out of the selection and the From/To range", async () => {
  const more = [...ROWS, row({ id: 104, when: "14 AUG | 09:35 AM", title: "Shell Scripting" })];
  const feed = { ...FEED, futureEvents: [...FEED.futureEvents, { sbat_id: 104, date: "2026-08-14T04:05:00.000Z" }] };
  const { window, sent } = load(more, { fetch: makeFetch(() => ({ json: feed })) });
  const doc = window.document;
  const lectures = window.findLectureRows(doc);
  await window.markUnfinishedClasses(lectures, AT);
  window.openBulkModal(lectures, "");
  const modal = doc.getElementById("scaler-bulk-download-modal");
  const boxes = Array.from(modal.querySelectorAll(".sbd-list input"));

  assert.deepEqual(boxes.map((b) => b.checked), [true, false, false, false], "only the finished class is ticked");
  assert.deepEqual(boxes.map((b) => b.disabled), [false, true, true, true], "the rest can't be ticked");
  assert.deepEqual(
    Array.from(modal.querySelectorAll(".sbd-pending-tag"), (n) => n.textContent),
    ["in progress", "not held yet", "not held yet"],
  );
  const to = modal.querySelector(".sbd-to");
  assert.deepEqual(Array.from(to.options, (o) => o.value), ["0"], "To offers finished classes only");
  assert.equal(to.value, "0", "and ends at the latest finished class");
  assert.match(modal.querySelector(".sbd-pending-note").textContent, /3 classes haven't finished/);

  modal.querySelector(".sbd-all").click();
  assert.deepEqual(boxes.map((b) => b.checked), [true, false, false, false], "All skips them");
  modal.querySelector(".sbd-start").click();
  const msg = sent.find((m) => m.type === "START_BULK_DOWNLOAD");
  assert.deepEqual(plain(msg.job.lectures.map((l) => l.classId)), ["101"]);
});

test("a date-only verdict can be overridden by hand", async () => {
  const { window } = load(ROWS, { fetch: makeFetch(() => ({ status: 500 })) });
  const doc = window.document;
  const lectures = window.findLectureRows(doc);
  await window.markUnfinishedClasses(lectures, AT);
  window.openBulkModal(lectures, "");
  const boxes = Array.from(doc.querySelectorAll("#scaler-bulk-download-modal .sbd-list input"));
  assert.deepEqual(boxes.map((b) => [b.checked, b.disabled]), [[true, false], [false, false], [false, false]]);
  boxes[1].click();
  assert.equal(boxes[1].checked, true, "the feed couldn't confirm it, so the user may");
});

test("the bar's button marks unfinished classes before it opens the picker", async () => {
  const { window } = load(ROWS, { fetch: makeFetch(() => ({ json: { pastEvents: [], futureEvents: [{ sbat_id: 103, date: "2999-01-01T00:00:00.000Z" }] } })) });
  const doc = window.document;
  window.initBulkDownload();
  doc.querySelector("#scaler-bulk-download-bar button").click();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const boxes = Array.from(doc.querySelectorAll("#scaler-bulk-download-modal .sbd-list input"));
  assert.deepEqual(boxes.map((b) => b.disabled), [false, false, true]);
});
