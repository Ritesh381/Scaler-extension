// ============================================================
// features/bulkDownload/bulkDownload.js
// Bulk lecture download from a subject's class list
// (/academy/mentee-dashboard/core-curriculum/m/{id}/classes): pick a range of
// lectures and what to save — transcripts, video, audio — and hand the job to
// the bulk download page (bulkDownloadPage.html), which does the work in its
// own tab.
//
// Rows are read from visible text ("11 AUG | 03:45 PM", a "Lecture" progress
// cell), not Scaler's generated class names.
// ============================================================

const BULK_BAR_ID = "scaler-bulk-download-bar";
const BULK_MODAL_ID = "scaler-bulk-download-modal";
// How long to wait for the class list to render before giving up.
const BULK_OBSERVER_CAP_MS = 30000;
const BULK_OBSERVER_DEBOUNCE_MS = 400;
// The stamp every class row starts with: "11 AUG | 03:45 PM".
const BULK_STAMP_RE = /^(\d{1,2})\s+([A-Za-z]{3})\s*\|\s*(\d{1,2}):(\d{2})\s*([AP]M)/i;
// The same stamp anywhere in a row's text (a row may lead with icon text).
const BULK_STAMP_ANYWHERE_RE = /(\d{1,2})\s+([A-Za-z]{3})\s*\|\s*(\d{1,2}):(\d{2})\s*([AP]M)/i;
// How far a row may widen from its stamp; only matters when a page holds a
// single stamp, where "widest element with one stamp" has no natural stop.
const BULK_ROW_MAX_WIDEN = 6;
const BULK_STAMP_GLOBAL_RE = /\d{1,2}\s+[A-Za-z]{3}\s*\|\s*\d{1,2}:\d{2}\s*[AP]M/gi;
// Row texts that aren't the lecture's title: pieces of the stamp and the
// progress cells ("Lecture", "0.0%", "Assignment", "5 / 5", "-").
const BULK_NOT_TITLE_RE =
  /^(?:lecture|assignment|additional problems?|view details|score\b.*|[\d.]+\s*%|\d+\s*\/\s*\d+|-|\||\d{1,2}\s+[A-Za-z]{3}|\d{1,2}:\d{2}\s*[AP]M|\d{1,2}\s+[A-Za-z]{3}\s*\|\s*\d{1,2}:\d{2}\s*[AP]M)$/i;
const BULK_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

let _bulkCapTimer = null;
let _bulkDebounceTimer = null;
let _bulkModalAbort = null; // AbortController for the open modal's listeners

function isClassListPage(path = location.pathname) {
  return /\/core-curriculum\/.*\/classes/.test(path);
}

function bulkText(el) {
  return (el.textContent || "").replace(/\s+/g, " ").trim();
}

function bulkCountStamps(el) {
  return (bulkText(el).match(BULK_STAMP_GLOBAL_RE) || []).length;
}

/**
 * Describe one class row: its stamp, title, class id (from a /class/{id}
 * link, when the row has one) and whether it's a lecture.
 */
function describeClassRow(el) {
  const texts = textNodesMatching(el, (t) => t.length > 0)
    .filter(
      (n) =>
        n.parentElement.localName !== "i" &&
        !/icon/i.test(n.parentElement.getAttribute("class") || ""),
    )
    .map((n) => n.nodeValue.trim().replace(/\s+/g, " "));
  const title = texts.find((t) => !BULK_NOT_TITLE_RE.test(t)) || "";
  const link = el.closest('a[href*="/class/"]') || el.querySelector('a[href*="/class/"]');
  // Rebuilt from its parts: split across elements, the raw text can lose
  // its spaces ("11 AUG|03:45 PM").
  const m = bulkText(el).match(BULK_STAMP_ANYWHERE_RE);
  if (!m) return { el, stamp: "", title, classId: null, isLecture: false };
  return {
    el,
    stamp: `${m[1]} ${m[2].toUpperCase()} | ${m[3]}:${m[4]} ${m[5].toUpperCase()}`,
    title,
    classId: link ? extractClassId(link.getAttribute("href")) : null,
    // Lectures (and labs) carry a "Lecture" progress cell; contests don't.
    isLecture: texts.some((t) => t !== title && /^lecture\b/i.test(t)),
  };
}

/**
 * The class list's lecture rows, in page order, numbered from 1.
 *
 * A row is the widest element holding exactly one "11 AUG | 03:45 PM" stamp:
 * start from each date text, climb until the element's text begins with a
 * full stamp, then widen while the parent still holds only that one stamp.
 * @returns {{index, el, stamp, title, classId, isLecture}[]}
 */
function findLectureRows(root = document) {
  const scope = root.body || root;
  const rows = [];
  const seen = new Set();
  for (const node of textNodesMatching(scope, (t) => /^\d{1,2}\s+[A-Za-z]{3}\b/.test(t))) {
    let el = node.parentElement;
    for (let depth = 0; el && depth < 4 && !BULK_STAMP_RE.test(bulkText(el)); depth++) {
      el = el.parentElement;
    }
    if (!el || !BULK_STAMP_RE.test(bulkText(el))) continue;
    for (
      let widen = 0;
      widen < BULK_ROW_MAX_WIDEN &&
      el.parentElement &&
      el.parentElement !== scope &&
      !el.parentElement.matches("main, [role='main']") &&
      bulkCountStamps(el.parentElement) === 1;
      widen++
    ) {
      el = el.parentElement;
    }
    if (seen.has(el)) continue;
    seen.add(el);
    rows.push(describeClassRow(el));
  }
  return rows.filter((r) => r.isLecture).map((r, i) => ({ ...r, index: i + 1 }));
}

/**
 * The date a row's stamp stands for. Rows carry no year: take this year,
 * unless that lands more than 60 days in the future — then it was last year.
 */
function bulkStampToDate(stamp, now = new Date()) {
  const m = String(stamp).match(BULK_STAMP_RE);
  if (!m) return null;
  const month = BULK_MONTHS.indexOf(m[2].toLowerCase());
  if (month < 0) return null;
  let hour = parseInt(m[3], 10) % 12;
  if (m[5].toUpperCase() === "PM") hour += 12;
  const at = (year) => new Date(year, month, parseInt(m[1], 10), hour, parseInt(m[4], 10));
  const date = at(now.getFullYear());
  return date - now > 60 * 86400000 ? at(now.getFullYear() - 1) : date;
}

/**
 * Rows without a /class/ link get their class id from the dashboard's own
 * events feed (the one lectureInfo.js reads) for the rows' date range,
 * matched by title. Mutates `lectures`; ids that can't be matched stay null.
 */
async function resolveMissingClassIds(lectures) {
  const missing = lectures.filter((l) => !l.classId);
  if (!missing.length) return;
  const dates = missing.map((l) => bulkStampToDate(l.stamp)).filter(Boolean);
  if (!dates.length) return;
  const day = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const start = new Date(Math.min(...dates) - 86400000);
  const end = new Date(Math.max(...dates) + 86400000);
  try {
    const res = await fetch(
      `${location.origin}/academy/mentee/events/?start_date=${day(start)}&end_date=${day(end)}`,
      { credentials: "include" },
    );
    if (!res.ok) return;
    const json = await res.json();
    const events = [...(json.pastEvents || []), ...(json.futureEvents || [])].filter((e) => e && e.sbat_id);
    const norm = (t) => String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    for (const lecture of missing) {
      const match = events.filter((e) => norm(e.title) === norm(lecture.title));
      if (match.length === 1) lecture.classId = String(match[0].sbat_id);
    }
  } catch (_) {
    /* rows stay without an id and are shown as unavailable */
  }
}

/**
 * The subject's name from the class list header ("SUBJECT - 1 … SST DevOps &
 * Cloud [SWE]"), or "".
 */
function findSubjectName(root = document) {
  const labels = textNodesMatching(root.body || root, (t) => /^subject\s*-\s*\d+$/i.test(t));
  // The left column lists every subject; the header above the class list is
  // the last label on the page.
  const label = labels[labels.length - 1];
  if (!label) return "";
  let box = label.parentElement;
  for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
    const name = textNodesMatching(box, (t) => t.length > 3 && !/^subject\s*-\s*\d+$/i.test(t) && !/^\d+\s*weeks?$/i.test(t))[0];
    if (name) return name.nodeValue.trim();
  }
  return "";
}

// ── UI ─────────────────────────────────────────────────────────────────────

/**
 * Put the "Bulk download" bar above the class list. Returns true once the bar
 * is on the page (already there, or just added).
 */
function injectBulkBar() {
  if (document.getElementById(BULK_BAR_ID)) return true;
  const rows = findLectureRows();
  if (!rows.length) return false;
  const list = rows[0].el.parentElement;
  if (!list || !list.parentElement) return false;

  const bar = document.createElement("div");
  bar.id = BULK_BAR_ID;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "sbd-bar-btn";
  button.textContent = "⬇ Bulk download lectures";
  const hint = document.createElement("span");
  hint.className = "sbd-bar-hint";
  hint.textContent = "Transcripts, video or audio for a range of lectures";
  bar.append(button, hint);
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const lectures = findLectureRows();
      await resolveMissingClassIds(lectures);
      openBulkModal(lectures, findSubjectName());
    } finally {
      button.disabled = false;
    }
  });
  list.parentElement.insertBefore(bar, list);
  return true;
}

function closeBulkModal() {
  if (_bulkModalAbort) {
    _bulkModalAbort.abort();
    _bulkModalAbort = null;
  }
  document.getElementById(BULK_MODAL_ID)?.remove();
}

/**
 * The picker: lectures with checkboxes, a From/To range (shift-click works
 * too), what to save, and whether to transcribe lectures nobody has yet.
 */
function openBulkModal(lectures, subject) {
  closeBulkModal();
  _bulkModalAbort = new AbortController();
  const { signal } = _bulkModalAbort;

  const overlay = document.createElement("div");
  overlay.id = BULK_MODAL_ID;
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Bulk download lectures");
  overlay.innerHTML = `
    <div class="sbd-panel">
      <div class="sbd-head">
        <div>
          <h2>Bulk download</h2>
          <div class="sbd-subject"></div>
        </div>
        <button type="button" class="sbd-close" aria-label="Close">×</button>
      </div>
      <div class="sbd-range">
        <label>From <select class="sbd-from"></select></label>
        <label>To <select class="sbd-to"></select></label>
        <button type="button" class="sbd-link sbd-all">All</button>
        <button type="button" class="sbd-link sbd-none">None</button>
      </div>
      <ul class="sbd-list"></ul>
      <div class="sbd-types">
        <label><input type="checkbox" class="sbd-type" value="transcript" checked> Transcripts</label>
        <label><input type="checkbox" class="sbd-type" value="video"> Video</label>
        <label><input type="checkbox" class="sbd-type" value="audio"> Audio</label>
      </div>
      <label class="sbd-generate">
        <input type="checkbox" class="sbd-gen">
        <span>Also transcribe lectures nobody has transcribed yet, with my saved API key
        (uses your credits; one lecture at a time)</span>
      </label>
      <div class="sbd-foot">
        <span class="sbd-count"></span>
        <button type="button" class="sbd-btn sbd-cancel">Cancel</button>
        <button type="button" class="sbd-btn sbd-primary sbd-start">Start</button>
      </div>
    </div>`;

  const $ = (sel) => overlay.querySelector(sel);
  $(".sbd-subject").textContent = subject || "This subject";
  const list = $(".sbd-list");
  const from = $(".sbd-from");
  const to = $(".sbd-to");
  const boxes = [];

  lectures.forEach((lecture, i) => {
    const li = document.createElement("li");
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!lecture.classId;
    box.disabled = !lecture.classId;
    const stamp = document.createElement("span");
    stamp.className = "sbd-stamp";
    stamp.textContent = lecture.stamp;
    const title = document.createElement("span");
    title.className = "sbd-title";
    title.textContent = lecture.title || `Lecture ${lecture.index}`;
    label.append(box, stamp, title);
    if (!lecture.classId) {
      const note = document.createElement("span");
      note.className = "sbd-note";
      note.textContent = "link not found";
      label.append(note);
    }
    li.append(label);
    list.append(li);
    boxes.push(box);

    for (const select of [from, to]) {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `${lecture.index}. ${lecture.stamp.split("|")[0].trim()} — ${lecture.title}`;
      select.append(opt);
    }
  });
  to.value = String(Math.max(0, lectures.length - 1));

  const updateCount = () => {
    const n = boxes.filter((b) => b.checked).length;
    $(".sbd-count").textContent = `${n} lecture${n === 1 ? "" : "s"} selected`;
  };
  const selectRange = (a, b, checked = true) => {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    boxes.forEach((box, i) => {
      if (!box.disabled) box.checked = i >= lo && i <= hi ? checked : box.checked;
    });
    updateCount();
  };
  const applyFromTo = () => {
    boxes.forEach((box) => {
      if (!box.disabled) box.checked = false;
    });
    selectRange(parseInt(from.value, 10), parseInt(to.value, 10));
  };
  from.addEventListener("change", applyFromTo, { signal });
  to.addEventListener("change", applyFromTo, { signal });

  let lastClicked = null;
  boxes.forEach((box, i) => {
    box.addEventListener(
      "click",
      (e) => {
        if (e.shiftKey && lastClicked !== null) selectRange(lastClicked, i, box.checked);
        lastClicked = i;
        updateCount();
      },
      { signal },
    );
  });
  $(".sbd-all").addEventListener("click", () => selectRange(0, boxes.length - 1, true), { signal });
  $(".sbd-none").addEventListener("click", () => selectRange(0, boxes.length - 1, false), { signal });

  $(".sbd-close").addEventListener("click", closeBulkModal, { signal });
  $(".sbd-cancel").addEventListener("click", closeBulkModal, { signal });
  overlay.addEventListener(
    "click",
    (e) => {
      if (e.target === overlay) closeBulkModal();
    },
    { signal },
  );
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closeBulkModal();
    },
    { signal },
  );

  $(".sbd-start").addEventListener(
    "click",
    () => {
      const types = Object.fromEntries(
        Array.from(overlay.querySelectorAll(".sbd-type"), (b) => [b.value, b.checked]),
      );
      const chosen = lectures.filter((_, i) => boxes[i].checked);
      if (!chosen.length || !Object.values(types).some(Boolean)) {
        $(".sbd-count").textContent = "Pick at least one lecture and one thing to download.";
        return;
      }
      chrome.runtime.sendMessage(
        {
          type: "START_BULK_DOWNLOAD",
          job: {
            subject: subject || "",
            types,
            generateMissing: $(".sbd-gen").checked,
            lectures: chosen.map((l) => ({
              index: l.index,
              classId: l.classId,
              title: l.title,
              stamp: l.stamp,
              url: `${location.origin}/academy/mentee-dashboard/class/${l.classId}/session`,
            })),
          },
        },
        () => void chrome.runtime.lastError,
      );
      closeBulkModal();
    },
    { signal },
  );

  updateCount();
  document.body.appendChild(overlay);
  $(".sbd-start").focus();
}

// ── Lifecycle ──────────────────────────────────────────────────────────────

function stopBulkObserver() {
  if (window._bulkDownloadObserver) {
    window._bulkDownloadObserver.disconnect();
    window._bulkDownloadObserver = null;
  }
  clearTimeout(_bulkCapTimer);
  clearTimeout(_bulkDebounceTimer);
  _bulkCapTimer = null;
  _bulkDebounceTimer = null;
}

/**
 * Remove everything the feature added: observer, timers, bar, modal.
 */
function teardownBulkDownload() {
  stopBulkObserver();
  closeBulkModal();
  document.getElementById(BULK_BAR_ID)?.remove();
}

/**
 * Add the bar on a subject's class list. The list renders after navigation,
 * so a debounced observer waits for it — and stops as soon as the bar is in,
 * or after BULK_OBSERVER_CAP_MS. Safe to call on every navigation.
 */
function initBulkDownload() {
  teardownBulkDownload();
  if (typeof shouldHide === "function" && !shouldHide("bulk-download")) return;
  if (!isClassListPage() || !document.body) return;
  if (injectBulkBar()) return;

  window._bulkDownloadObserver = new MutationObserver(() => {
    clearTimeout(_bulkDebounceTimer);
    _bulkDebounceTimer = setTimeout(() => {
      if (injectBulkBar()) stopBulkObserver();
    }, BULK_OBSERVER_DEBOUNCE_MS);
  });
  window._bulkDownloadObserver.observe(document.body, { childList: true, subtree: true });
  _bulkCapTimer = setTimeout(stopBulkObserver, BULK_OBSERVER_CAP_MS);
}
