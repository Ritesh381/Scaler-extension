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
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, true], "everything selected to start");

  const from = modal.querySelector(".sbd-from");
  from.value = "1";
  from.dispatchEvent(new window.Event("change"));
  assert.deepEqual(boxes.map((b) => b.checked), [false, true, true], "range 2–3");

  modal.querySelector(".sbd-none").click();
  boxes[0].click(); // check 1
  boxes[2].dispatchEvent(new window.MouseEvent("click", { shiftKey: true, bubbles: true }));
  assert.deepEqual(boxes.map((b) => b.checked), [true, true, true], "shift-click fills the range");
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
      [1, "101", "https://www.scaler.com/academy/mentee-dashboard/class/101/session"],
      [3, "103", "https://www.scaler.com/academy/mentee-dashboard/class/103/session"],
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
