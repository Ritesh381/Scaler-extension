const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadFeature } = require("./helpers/harness");

// classroomLogic leans on joinClassButton's time parsing rather than copying it,
// so both files load together — the same order manifest.json uses.
const FEATURES = [
  "content/features/joinClassButton.js",
  "content/features/classroomVote/classroomLogic.js",
];

const CARD_HTML = `
<div class="horizontal-scroll-view__items mentee-problems__container">
  <a class="me-cr-classroom-url mentee-card" data-cy="classroom-link"
     href="/academy/mentee-dashboard/class/575444" data-lecture-instructor-info-id="575444">
    <div class="mentee-card__header">
      <div class="scaler-lecture-instructor-info">
        <span class="scaler-lecture-instructor-tag" title="SST DevOps &amp; Cloud 2028 Batch A">DevOps Cloud Batch</span>
        <span class="scaler-lecture-instructor-tag" title="Instructor">Nensi Ravaliya</span>
      </div>
    </div>
    <div class="mentee-card__content m-t-10 m-b-10">
      <div class="_1w9PC_5JhjMvKbYuHOnWub">
        <p class="A5n8g0uf9DprHw5f_gwFE">Kubernetes Pods, ReplicaSets &amp; Deployments</p>
      </div>
      <div class="_2GsNsJLDK4elcdmjka5HmF">Live Class</div>
      <div class="_1EQZYaGMSYVhKTiIKY-qXP">
        <div><span>02:00 PM</span><span class="m-l-5 m-r-5">-</span><span>04:00 PM</span></div>
        <span class="_3cg2nc-UIVR1CzIB7nNQ8Z">View Details</span>
      </div>
    </div>
  </a>
</div>`;

function withCard() {
  const { window } = loadFeature(FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: `<!DOCTYPE html><html><body>${CARD_HTML}</body></html>`,
  });
  const card = window.document.querySelector("a.me-cr-classroom-url");
  return { window, card };
}

const HOUR = 60 * 60 * 1000;

// ── the room list ─────────────────────────────────────────────────────────────

test("all seven rooms plus online are offered", () => {
  const { window } = loadFeature(FEATURES);
  // Rebased out of the jsdom realm — a jsdom Array fails deepEqual's prototype
  // check even when every value matches (see tests/README.md).
  assert.deepEqual(Array.from(window.CLASSROOM_ROOMS), [
    "0C",
    "1A",
    "1B",
    "2A",
    "2B1",
    "2B2",
    "2C",
    "online",
  ]);
});

// ── voting window ─────────────────────────────────────────────────────────────

test("voting is open from 24 hours before the class until it ends", () => {
  const { window } = loadFeature(FEATURES);
  const start = Date.parse("2026-09-02T14:00:00Z");
  const end = start + 2 * HOUR;

  assert.equal(window.isClassroomVoteOpen(start - 24 * HOUR, start, end), true);
  assert.equal(window.isClassroomVoteOpen(start - 24 * HOUR - 1000, start, end), false);
  assert.equal(window.isClassroomVoteOpen(start - HOUR, start, end), true);
  assert.equal(window.isClassroomVoteOpen(end, start, end), true);
  assert.equal(window.isClassroomVoteOpen(end + 1000, start, end), false);
});

// ── card metadata ─────────────────────────────────────────────────────────────

test("class metadata is read off a real dashboard card", () => {
  const { window, card } = withCard();
  const meta = window.buildClassroomMeta(card, new Date(2026, 8, 2));

  assert.equal(meta.classId, "575444");
  assert.equal(meta.classDate, "2026-09-02");
  assert.equal(meta.lectureTitle, "Kubernetes Pods, ReplicaSets & Deployments");
  assert.equal(meta.batch, "SST DevOps & Cloud 2028 Batch A");
  assert.equal(new Date(meta.startsAt).getHours(), 14);
  assert.equal(new Date(meta.endsAt).getHours(), 16);
});

test("the class id falls back to the href when lectureInfo has not stamped the card", () => {
  const { window, card } = withCard();
  card.removeAttribute("data-lecture-instructor-info-id");
  const meta = window.buildClassroomMeta(card, new Date(2026, 8, 2));
  assert.equal(meta.classId, "575444");
});

test("metadata is refused when the card has no parseable times", () => {
  const { window, card } = withCard();
  card.querySelector("._1EQZYaGMSYVhKTiIKY-qXP").remove();
  assert.equal(window.buildClassroomMeta(card, new Date(2026, 8, 2)), null);
});

test("metadata survives lectureInfo being switched off", () => {
  const { window, card } = withCard();
  card.querySelector(".scaler-lecture-instructor-info").remove();
  const meta = window.buildClassroomMeta(card, new Date(2026, 8, 2));
  assert.equal(meta.classId, "575444");
  assert.equal(meta.batch, null);
});

test("a class ending past midnight lands on the next day", () => {
  const { window, card } = withCard();
  const spans = card.querySelectorAll("._1EQZYaGMSYVhKTiIKY-qXP > div span");
  spans[0].textContent = "11:00 PM";
  spans[2].textContent = "01:00 AM";

  const meta = window.buildClassroomMeta(card, new Date(2026, 8, 2));
  assert.equal(new Date(meta.startsAt).getDate(), 2);
  assert.equal(new Date(meta.endsAt).getDate(), 3);
});

// ── tag copy ──────────────────────────────────────────────────────────────────

test("the tag names the room and nothing else", () => {
  const { window } = loadFeature(FEATURES);
  // Head counts and disagreement belong in the popover, not on a crowded card.
  const tag = window.formatRoomTag({ room: "2B1", source: "live", voters: 4 });
  assert.equal(tag.text, "Room : 2B1");
  assert.equal(tag.tone, "live");
});

test("a history guess reads the same but is toned differently", () => {
  const { window } = loadFeature(FEATURES);
  const tag = window.formatRoomTag({ room: "2B1", source: "history", voters: 0 });
  assert.equal(tag.text, "Room : 2B1");
  assert.equal(tag.tone, "history");
  // The only place a guess is distinguishable in text is the tooltip.
  assert.match(tag.title, /usually/i);
});

test("with no signal at all the tag asks the question", () => {
  const { window } = loadFeature(FEATURES);
  const tag = window.formatRoomTag({ room: null, source: "none", voters: 0 });
  assert.equal(tag.text, "Room : ?");
  assert.equal(tag.tone, "unknown");
});

test("online reads as a word, not a room code", () => {
  const { window } = loadFeature(FEATURES);
  assert.equal(
    window.formatRoomTag({ room: "online", source: "live", voters: 3 }).text,
    "Room : Online",
  );
});

test("a closed vote on a settled room is toned down", () => {
  const { window } = loadFeature(FEATURES);
  const tag = window.formatRoomTag({
    room: "1A",
    source: "live",
    voters: 5,
    votingOpen: false,
  });
  assert.equal(tag.text, "Room : 1A");
  assert.equal(tag.tone, "closed");
});

test("the tooltip carries the head count the tag no longer shows", () => {
  const { window } = loadFeature(FEATURES);
  const tag = window.formatRoomTag({ room: "1A", source: "live", voters: 5 });
  assert.match(tag.title, /5 people/);
});

// ── injection resilience ──────────────────────────────────────────────────────
// The tag has to exist before the backend answers, and survive it never
// answering: a 404 or a flaky network must not make the feature disappear with
// no explanation.

const INJECT_FEATURES = [
  "content/features/joinClassButton.js",
  "content/features/classroomVote/classroomLogic.js",
  "content/features/classroomVote/classroomVote.js",
];

const DASHBOARD_HTML = `<!DOCTYPE html><html><body>
  <div class="mentee-dashboard__content">
    <div class="tabs__header"><div class="tabs__tab tabs__tab--active">3 Sep</div></div>
    ${CARD_HTML}
  </div>
</body></html>`;

function loadDashboard(sendMessage) {
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  return load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome: makeChrome({ sendMessage, syncStore: { scaler_user: { email: "me@x.com" } } }),
    globals: {
      currentSettings: { "classroom-tag": true },
      isExtensionValid: () => true,
    },
  });
}

test("a tag appears even when the backend cannot be reached", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));

  await window.injectClassroomTags();

  const tag = window.document.querySelector(".scaler-classroom-tag");
  assert.ok(tag, "expected a tag to be injected without a backend answer");
  assert.equal(tag.textContent, "Room : ?");
});

test("a reachable backend upgrades the tag to what people voted", async () => {
  const { window } = loadDashboard((msg, cb) => {
    if (msg.action === "fetchClassroomStates") {
      cb({
        success: true,
        data: {
          states: [
            {
              classId: "575444",
              room: "2B1",
              source: "live",
              voters: 4,
              dissent: null,
              tallies: { "2B1": 4 },
              myVote: null,
              myVoteLocked: false,
              votingOpen: true,
            },
          ],
        },
      });
      return;
    }
    cb({ success: false });
  });

  await window.injectClassroomTags();

  assert.equal(
    window.document.querySelector(".scaler-classroom-tag").textContent,
    "Room : 2B1",
  );
});

test("disagreement never gets its own chip on the card", async () => {
  const { window } = loadDashboard((msg, cb) => {
    if (msg.action === "fetchClassroomStates") {
      cb({
        success: true,
        data: {
          states: [
            {
              classId: "575444",
              room: "1A",
              source: "live",
              voters: 5,
              dissent: { room: "2B1", voters: 1 },
              tallies: { "1A": 5, "2B1": 1 },
              myVote: "1A",
              myVoteLocked: false,
              votingOpen: true,
            },
          ],
        },
      });
      return;
    }
    cb({ success: false });
  });

  await window.injectClassroomTags();

  const container = window.document.querySelector(".scaler-classroom-info");
  assert.equal(container.children.length, 1, "expected exactly one tag on the card");
  assert.equal(container.textContent, "Room : 1A");
});

test("the tag lives outside lectureInfo's container, which gets innerHTML-wiped", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));

  await window.injectClassroomTags();

  const lectureContainer = window.document.querySelector(".scaler-lecture-instructor-info");
  assert.equal(lectureContainer.querySelector(".scaler-classroom-tag"), null);
  assert.ok(window.document.querySelector(".scaler-classroom-info .scaler-classroom-tag"));
});

test("re-running injection does not stack duplicate tags", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));

  await window.injectClassroomTags();
  await window.injectClassroomTags();

  assert.equal(window.document.querySelectorAll(".scaler-classroom-tag").length, 1);
});

test("the tag sits on the Live Class line, in the empty space to its right", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));

  await window.injectClassroomTags();

  const container = window.document.querySelector(".scaler-classroom-info");
  assert.ok(container, "expected a classroom container");

  // The header is a nowrap flex row shared with lectureInfo's tags: anything
  // added there squeezes them off the card.
  assert.equal(container.closest(".mentee-card__header"), null);

  const classType = window.document.querySelector("._2GsNsJLDK4elcdmjka5HmF");
  assert.equal(
    container.parentElement,
    classType,
    "expected the tag inside the Live Class line, after its text",
  );
  assert.equal(classType.lastElementChild, container);
  // Scaler's own text must survive untouched.
  assert.match(classType.textContent, /^Live Class/);
});

test("the tag still lands on the card when the class-type line is missing", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));
  window.document.querySelector("._2GsNsJLDK4elcdmjka5HmF").remove();

  await window.injectClassroomTags();

  const container = window.document.querySelector(".scaler-classroom-info");
  assert.ok(container);
  assert.ok(container.closest(".mentee-card__content"), "expected it inside the card content");
  assert.equal(container.closest(".mentee-card__header"), null);
});

test("no tag is injected when the active date tab cannot be read", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));
  // Scaler renames a hashed class, or this dashboard view has no date tabs.
  window.document.querySelector(".tabs__tab--active").className = "tabs__tab";

  await window.injectClassroomTags();

  // Guessing "today" would close the vote window on tomorrow's classes AND
  // store votes under the wrong class_date, weekday and slot.
  assert.equal(window.document.querySelector(".scaler-classroom-info"), null);
});

test("the vote window is measured from the active tab's date, not today", async () => {
  const { window } = loadDashboard((msg, cb) => cb({ success: false, error: "HTTP 404" }));
  const card = window.document.querySelector("a.me-cr-classroom-url");

  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  const start = Date.parse(meta.startsAt);

  // A 2 PM class on the 3rd, seen on the evening of the 2nd, is votable.
  const eveningBefore = new Date(start);
  eveningBefore.setDate(eveningBefore.getDate() - 1);
  eveningBefore.setHours(21, 0, 0, 0);

  assert.equal(
    window.isClassroomVoteOpen(eveningBefore.getTime(), start, Date.parse(meta.endsAt)),
    true,
  );
});

// ── changing your mind ────────────────────────────────────────────────────────

function openPopoverWith(state) {
  const { window } = loadDashboard((msg, cb) => cb({ success: false }));
  const card = window.document.querySelector("a.me-cr-classroom-url");
  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  const anchor = window.document.createElement("button");
  window.document.body.appendChild(anchor);
  window._openClassroomPopover(anchor, meta, state);
  return window;
}

const OPEN_STATE = (extra) => ({
  room: "1A",
  source: "live",
  voters: 5,
  dissent: null,
  tallies: { "1A": 5 },
  myVote: "1A",
  votingOpen: true,
  ...extra,
});

test("a voter who already answered can still pick a different room", () => {
  const window = openPopoverWith(OPEN_STATE());
  const buttons = Array.from(
    window.document.querySelectorAll("#scaler-classroom-popover .scr-room"),
  );

  assert.equal(buttons.length, 8);
  assert.equal(
    buttons.filter((b) => b.disabled).length,
    0,
    "every room must stay selectable — a room really does change sometimes",
  );
});

test("the voter's current answer is marked as theirs", () => {
  const window = openPopoverWith(OPEN_STATE());
  const pressed = Array.from(
    window.document.querySelectorAll('#scaler-classroom-popover .scr-room[aria-pressed="true"]'),
  );
  assert.equal(pressed.length, 1);
  assert.match(pressed[0].textContent, /^1A/);
});

test("rooms are locked only once voting has closed", () => {
  const window = openPopoverWith(OPEN_STATE({ votingOpen: false }));
  const buttons = Array.from(
    window.document.querySelectorAll("#scaler-classroom-popover .scr-room"),
  );
  assert.equal(buttons.filter((b) => b.disabled).length, 8);
});

test("nothing tells a voter their vote is locked while voting is open", () => {
  const window = openPopoverWith(OPEN_STATE());
  const note = window.document.querySelector("#scaler-classroom-popover .scr-note");
  assert.doesNotMatch(note.textContent, /locked/i);
  assert.doesNotMatch(note.textContent, /once/i, "there is no longer a one-edit limit");
  assert.match(note.textContent, /change/i);
});

test("a legacy myVoteLocked flag from an older backend disables nothing", () => {
  // The one-edit lock is gone. A stale deploy still sending the flag must not
  // strand a voter who can see the room has changed.
  const window = openPopoverWith(OPEN_STATE({ myVoteLocked: true }));
  const buttons = Array.from(
    window.document.querySelectorAll("#scaler-classroom-popover .scr-room"),
  );
  assert.equal(buttons.filter((b) => b.disabled).length, 0);

  const note = window.document.querySelector("#scaler-classroom-popover .scr-note");
  assert.doesNotMatch(note.textContent, /locked/i);
});

// ── removing your answer ──────────────────────────────────────────────────────

/** Popover wired to a recording chrome mock, so sent messages can be asserted. */
function openPopoverRecording(state) {
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  const sent = [];
  const { window } = load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome: makeChrome({
      syncStore: { scaler_user: { email: "me@x.com" } },
      sendMessage: (msg, cb) => {
        sent.push(msg);
        cb({ success: true, data: { state: { ...state, myVote: null } } });
      },
    }),
    globals: { currentSettings: { "classroom-tag": true }, isExtensionValid: () => true },
  });

  const card = window.document.querySelector("a.me-cr-classroom-url");
  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  const anchor = window.document.createElement("button");
  window.document.body.appendChild(anchor);
  window._openClassroomPopover(anchor, meta, state);
  return { window, sent };
}

const VOTED_STATE = (extra) => ({
  room: "1A",
  source: "live",
  voters: 2,
  dissent: null,
  tallies: { "1A": 2 },
  myVote: "1A",
  votingOpen: true,
  ...extra,
});

test("a voter who has answered is offered a way to remove it", () => {
  const { window } = openPopoverRecording(VOTED_STATE());
  const clear = window.document.querySelector("#scaler-classroom-popover .scr-clear");
  assert.ok(clear, "expected a remove control");
  assert.match(clear.textContent, /remove/i);
});

test("nothing offers removal to someone who has not answered", () => {
  const { window } = openPopoverRecording(VOTED_STATE({ myVote: null }));
  assert.equal(window.document.querySelector("#scaler-classroom-popover .scr-clear"), null);
});

test("removal is not offered once voting has closed", () => {
  const { window } = openPopoverRecording(VOTED_STATE({ votingOpen: false }));
  assert.equal(window.document.querySelector("#scaler-classroom-popover .scr-clear"), null);
});

test("the remove control withdraws the vote rather than casting one", async () => {
  const { window, sent } = openPopoverRecording(VOTED_STATE());
  window.document.querySelector("#scaler-classroom-popover .scr-clear").click();
  await new Promise((r) => setTimeout(r, 0));

  const vote = sent.find((m) => m.action === "voteClassroom");
  assert.ok(vote, "expected a vote message");
  assert.equal(vote.room, null, "a withdrawal sends room: null");
});

test("clicking the room you already picked also withdraws it", async () => {
  const { window, sent } = openPopoverRecording(VOTED_STATE());
  const mine = window.document.querySelector(
    '#scaler-classroom-popover .scr-room[aria-pressed="true"]',
  );
  mine.click();
  await new Promise((r) => setTimeout(r, 0));

  const vote = sent.find((m) => m.action === "voteClassroom");
  assert.equal(vote.room, null);
});

test("clicking a different room still casts a normal vote", async () => {
  const { window, sent } = openPopoverRecording(VOTED_STATE());
  const others = Array.from(
    window.document.querySelectorAll('#scaler-classroom-popover .scr-room[aria-pressed="false"]'),
  );
  others[0].click();
  await new Promise((r) => setTimeout(r, 0));

  const vote = sent.find((m) => m.action === "voteClassroom");
  assert.equal(vote.room, "0C");
});

// ── responsiveness ────────────────────────────────────────────────────────────
// Picking a room used to hold the popover open until the backend answered, so
// every vote felt laggy. The click is now acknowledged immediately and the
// write happens in the background.

/**
 * Popover whose VOTE writes never answer, to prove the UI does not wait for
 * them. Reads still answer — a read that hangs would just hang the test.
 */
function openPopoverNeverAnswering(state) {
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  const sent = [];
  const { window } = load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome: makeChrome({
      syncStore: { scaler_user: { email: "me@x.com" } },
      sendMessage: (msg, cb) => {
        sent.push(msg);
        if (msg.action === "fetchClassroomStates") {
          cb({ success: true, data: { states: [{ classId: "575444", ...state }] } });
        }
        // voteClassroom deliberately never calls back
      },
    }),
    globals: { currentSettings: { "classroom-tag": true }, isExtensionValid: () => true },
  });

  const card = window.document.querySelector("a.me-cr-classroom-url");
  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  const anchor = window.document.createElement("button");
  window.document.body.appendChild(anchor);
  window._openClassroomPopover(anchor, meta, state);
  return { window, sent, meta };
}

test("picking a room closes the popover without waiting for the backend", async () => {
  const { window } = openPopoverNeverAnswering(VOTED_STATE({ myVote: null }));

  window.document.querySelector("#scaler-classroom-popover .scr-room").click();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(
    window.document.getElementById("scaler-classroom-popover"),
    null,
    "the popover must not stay open until the write completes",
  );
});

test("the picked room is acknowledged on the card straight away", async () => {
  const { window, meta } = openPopoverNeverAnswering(VOTED_STATE({ myVote: null }));
  const card = window.document.querySelector("a.me-cr-classroom-url");
  window._applyClassroomState(card, meta, VOTED_STATE({ myVote: null }));

  window.document.querySelector("#scaler-classroom-popover .scr-room").click();
  await new Promise((r) => setTimeout(r, 0));

  const tag = window.document.querySelector(".scaler-classroom-tag");
  assert.match(tag.className, /pending/, "expected a pending marker while the write is in flight");
});

test("an injection pass does not overwrite a card whose vote is in flight", async () => {
  const { window, meta } = openPopoverNeverAnswering(VOTED_STATE({ myVote: null }));
  const card = window.document.querySelector("a.me-cr-classroom-url");
  window._applyClassroomState(card, meta, VOTED_STATE({ myVote: null }));

  window.document.querySelector("#scaler-classroom-popover .scr-room").click();
  await new Promise((r) => setTimeout(r, 0));

  const before = window.document.querySelector(".scaler-classroom-tag").outerHTML;
  await window.injectClassroomTags();
  const after = window.document.querySelector(".scaler-classroom-tag").outerHTML;

  assert.equal(after, before, "a pending card must be left alone");
});

test("the email is warmed at init so the first vote does not wait on storage", async () => {
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  let reads = 0;
  const chrome = makeChrome({ syncStore: { scaler_user: { email: "me@x.com" } } });
  const originalGet = chrome.storage.sync.get;
  chrome.storage.sync.get = (keys, cb) => {
    if (keys === "scaler_user") reads += 1;
    return originalGet(keys, cb);
  };

  const { window } = load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome,
    globals: { currentSettings: { "classroom-tag": true }, isExtensionValid: () => true },
  });

  window.initClassroomVote();
  await new Promise((r) => setTimeout(r, 0));

  assert.equal(reads, 1, "init should have already fetched the signed-in email");
});

test("an identical injection pass rewrites nothing", async () => {
  // The observer watches the subtree this feature writes into, so a pass that
  // re-renders the same value re-triggers the observer, which re-renders again:
  // a 300 ms loop for as long as the tab is open. Node identity is the check.
  const { window } = loadDashboard((msg, cb) => {
    if (msg.action === "fetchClassroomStates") {
      cb({
        success: true,
        data: {
          states: [
            {
              classId: "575444",
              room: "1A",
              source: "live",
              voters: 2,
              dissent: null,
              tallies: { "1A": 2 },
              myVote: null,
              votingOpen: true,
            },
          ],
        },
      });
      return;
    }
    cb({ success: false });
  });

  await window.injectClassroomTags();
  const first = window.document.querySelector(".scaler-classroom-tag");

  await window.injectClassroomTags();
  const second = window.document.querySelector(".scaler-classroom-tag");

  assert.equal(second, first, "the tag node must survive an unchanged pass untouched");
});

test("a changed state does replace the tag", async () => {
  const { window } = loadDashboard((msg, cb) => {
    if (msg.action === "fetchClassroomStates") {
      cb({
        success: true,
        data: {
          states: [
            {
              classId: "575444",
              room: "1A",
              source: "live",
              voters: 2,
              dissent: null,
              tallies: { "1A": 2 },
              myVote: null,
              votingOpen: true,
            },
          ],
        },
      });
      return;
    }
    cb({ success: false });
  });

  await window.injectClassroomTags();
  const first = window.document.querySelector(".scaler-classroom-tag");

  const card = window.document.querySelector("a.me-cr-classroom-url");
  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  window._applyClassroomState(card, meta, {
    room: "2C",
    source: "live",
    voters: 3,
    dissent: null,
    tallies: { "2C": 3 },
    myVote: null,
    votingOpen: true,
  });

  const second = window.document.querySelector(".scaler-classroom-tag");
  assert.notEqual(second, first, "a real change must re-render");
  assert.equal(second.textContent, "Room : 2C");
});

// ── leaks and teardown ────────────────────────────────────────────────────────

const ANSWERING = (msg, cb) => {
  if (msg.action === "fetchClassroomStates") {
    cb({
      success: true,
      data: {
        states: [
          {
            classId: "575444",
            room: "1A",
            source: "live",
            voters: 2,
            dissent: null,
            tallies: { "1A": 2 },
            myVote: null,
            votingOpen: true,
          },
        ],
      },
    });
    return;
  }
  cb({ success: true, data: {} });
};

test("a debounced observer pass cannot fire after teardown", async () => {
  const { window } = loadDashboard(ANSWERING);
  window.initClassroomVote();
  await new Promise((r) => setTimeout(r, 10));

  // Mutate the observed subtree, then tear down before the 300 ms debounce.
  window.document.querySelector(".mentee-dashboard__content").appendChild(
    window.document.createElement("div"),
  );
  window.teardownClassroomTags();

  await new Promise((r) => setTimeout(r, 450));

  assert.equal(
    window.document.querySelector(".scaler-classroom-info"),
    null,
    "a pending debounce re-injected the feature after it was switched off",
  );
});

test("teardown leaves no observer behind", async () => {
  const { window } = loadDashboard(ANSWERING);
  window.initClassroomVote();
  await new Promise((r) => setTimeout(r, 10));

  window.teardownClassroomTags();
  assert.equal(window._classroomVoteObserver, null);
});

test("re-initialising closes a popover left open by the previous page", async () => {
  const { window } = loadDashboard(ANSWERING);
  const card = window.document.querySelector("a.me-cr-classroom-url");
  const meta = window.buildClassroomMeta(card, window.getActiveDashboardDate());
  const anchor = window.document.createElement("button");
  window.document.body.appendChild(anchor);
  window._openClassroomPopover(anchor, meta, VOTED_STATE());

  assert.ok(window.document.getElementById("scaler-classroom-popover"));

  window.initClassroomVote();
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(
    window.document.getElementById("scaler-classroom-popover"),
    null,
    "an orphaned popover survived a navigation",
  );
});

test("a missing email is retried rather than cached as absent forever", async () => {
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  const chrome = makeChrome({ syncStore: {} });
  const { window } = load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome,
    globals: { currentSettings: { "classroom-tag": true }, isExtensionValid: () => true },
  });

  assert.equal(await window._getClassroomEmail(), "");

  // usernameTracker finishes its sync a moment later.
  chrome.__sync.scaler_user = { email: "late@x.com" };

  assert.equal(
    await window._getClassroomEmail(),
    "late@x.com",
    "an empty first read must not be cached as the final answer",
  );
});

test("a stale in-flight read cannot populate the cache for a newer request", async () => {
  const pendingCallbacks = [];
  const { loadFeature: load, makeChrome } = require("./helpers/harness");
  const { window } = load(INJECT_FEATURES, {
    url: "https://www.scaler.com/academy/mentee-dashboard/todos",
    html: DASHBOARD_HTML,
    chrome: makeChrome({
      syncStore: { scaler_user: { email: "me@x.com" } },
      sendMessage: (msg, cb) => pendingCallbacks.push([msg, cb]),
    }),
    globals: { currentSettings: { "classroom-tag": true }, isExtensionValid: () => true },
  });

  const metaA = { classId: "111", startsAt: "2026-09-04T04:00:00Z", endsAt: "2026-09-04T06:00:00Z" };
  const metaB = { classId: "222", startsAt: "2026-09-04T04:00:00Z", endsAt: "2026-09-04T06:00:00Z" };

  const first = window._fetchClassroomStates([metaA]);
  const second = window._fetchClassroomStates([metaB]);

  // Both calls await the stored email before sending, so let those microtasks
  // drain or the message queue is still empty here.
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(pendingCallbacks.length, 2, "expected both reads to be in flight");

  // The second request answers first; the first arrives late, for a class the
  // dashboard is no longer showing.
  const answer = (id) => ({
    success: true,
    data: { states: [{ classId: id, room: "1A", source: "live", voters: 2, tallies: {}, votingOpen: true }] },
  });

  pendingCallbacks[1][1](answer("222"));
  await second;
  pendingCallbacks[0][1](answer("111"));
  await first;

  const fresh = await window._fetchClassroomStates([metaB]);
  assert.ok(fresh && fresh["222"], "the newer request's states were clobbered by a stale reply");
});
