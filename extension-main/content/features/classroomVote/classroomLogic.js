// ============================================
// features/classroomVote/classroomLogic.js
// Pure helpers for the crowdsourced classroom tag: the vote window, reading a
// class off a dashboard card, and the copy that goes in the tag.
//
// No network, no injection, no observers — all of that lives in
// classroomVote.js. Everything here is unit-tested in
// tests/classroomVote.test.js.
//
// The trust math (who moves a label, and when) is deliberately NOT here: it
// runs server-side only, so a client cannot be edited into voting with more
// weight than it has earned.
// ============================================

/** Every votable value. Must stay in step with the backend CHECK constraint. */
const CLASSROOM_ROOMS = ["0C", "1A", "1B", "2A", "2B1", "2B2", "2C", "online"];

/** Voting opens a day before the class and closes when it ends. */
const CLASSROOM_VOTE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True while a class is inside its voting window.
 * The server re-checks this against its own clock; this copy only decides
 * whether the UI offers the control.
 *
 * @param {number} nowMs
 * @param {number} startMs
 * @param {number} endMs
 * @returns {boolean}
 */
function isClassroomVoteOpen(nowMs, startMs, endMs) {
  return nowMs >= startMs - CLASSROOM_VOTE_WINDOW_MS && nowMs <= endMs;
}

/** 'YYYY-MM-DD' in local time — the dashboard's own notion of a day. */
function _localDateKey(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Combine a calendar date with a "02:00 PM" string into a real Date.
 * Reuses joinClassButton's parser rather than repeating the 12-hour rules.
 */
function _atTime(date, timeStr) {
  const parsed = parseClassTime(timeStr);
  if (!parsed) return null;

  const out = new Date(date.getTime());
  out.setHours(parsed.getHours(), parsed.getMinutes(), 0, 0);
  return out;
}

/**
 * Everything the backend needs to place a vote, read off one class card.
 *
 * The date comes from the caller (the active date tab), not from `today`: the
 * 24 h window means tomorrow's tab is votable, so this must never be gated on
 * today the way joinClassButton is.
 *
 * @param {Element} card    the `a.me-cr-classroom-url` anchor
 * @param {Date} activeDate the date the dashboard tab is showing
 * @returns {object|null}   null when the card cannot be understood
 */
function buildClassroomMeta(card, activeDate) {
  if (!card || !activeDate) return null;

  const classId =
    card.dataset.lectureInstructorInfoId ||
    (card.getAttribute("href") || "").match(/\/class\/(\d+)/)?.[1] ||
    null;
  if (!classId) return null;

  const times = extractClassTimes(card);
  if (!times) return null;

  const startsAt = _atTime(activeDate, times.start);
  const endsAt = _atTime(activeDate, times.end);
  if (!startsAt || !endsAt) return null;

  // A class that ends "before" it starts has run past midnight.
  if (endsAt <= startsAt) endsAt.setDate(endsAt.getDate() + 1);

  const titleNode =
    card.querySelector("._1w9PC_5JhjMvKbYuHOnWub p") || card.querySelector("p");

  // lectureInfo puts the full batch name in the first tag's title attribute.
  // Absent when that feature is toggled off — the server then falls back to the
  // cohort it already has on file for this user.
  const batchTag = card.querySelector(".scaler-lecture-instructor-tag");

  return {
    classId: String(classId),
    classDate: _localDateKey(activeDate),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    lectureTitle: titleNode ? titleNode.textContent.trim() : null,
    batch: batchTag && batchTag.title ? batchTag.title.trim() : null,
  };
}

/** `online` is a state, not a room number, so it reads as a word. */
function formatRoomName(room) {
  return room === "online" ? "Online" : room;
}

/**
 * The tag's text and tone.
 *
 * The card gets exactly one chip reading `Room : 1A`. Head counts, the room
 * everyone else voted for, and whether the answer is a report or a guess all
 * live one click away in the popover — a dashboard card has room for a room
 * number, not for an argument.
 *
 * A guess is still distinguishable without opening anything: the tone differs
 * (amber, not green) and the tooltip says so. Acting on a stale guess as if it
 * were a report is the failure this whole feature exists to avoid, so that
 * signal never disappears entirely.
 *
 * @param {{room: string|null, source: string, voters: number, votingOpen?: boolean}} state
 * @returns {{text: string, tone: "live"|"history"|"unknown"|"closed", title: string}}
 */
function formatRoomTag(state) {
  const room = state && state.room ? formatRoomName(state.room) : null;

  if (!room || state.source === "none") {
    return {
      text: "Room : ?",
      tone: "unknown",
      title: "Nobody has said where this class is yet. Click to tell everyone.",
    };
  }

  const text = `Room : ${room}`;

  if (state.source === "history") {
    return {
      text,
      tone: "history",
      title: `Nobody has voted yet — ${room} is where this class usually happens. Click to confirm or correct it.`,
    };
  }

  const voters = state.voters || 0;
  const people = `${voters} ${voters === 1 ? "person" : "people"}`;
  const closed = state.votingOpen === false;

  return {
    text,
    tone: closed ? "closed" : "live",
    title: closed
      ? `${people} said ${room}. Voting is closed for this class.`
      : `${people} said ${room}. Click to see the votes or add yours.`,
  };
}

// `const` declared in an eval'd/injected script does not become a window
// property the way a top-level `function` does, so the two constants other
// files (and the tests) read are attached explicitly.
window.CLASSROOM_ROOMS = CLASSROOM_ROOMS;
window.CLASSROOM_VOTE_WINDOW_MS = CLASSROOM_VOTE_WINDOW_MS;
