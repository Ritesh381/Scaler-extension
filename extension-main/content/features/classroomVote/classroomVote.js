// ============================================
// features/classroomVote/classroomVote.js
// Crowdsourced classroom tag on dashboard class cards.
//
// Scaler exposes no room anywhere, so students report it themselves. What is
// displayed is decided server-side (see backend classroomTrust.js): a history
// guess holds the label until enough earned, recent votes disagree. This file
// only renders that decision and collects one vote.
//
// Pure helpers — the vote window, card parsing, tag copy — live in
// classroomLogic.js and are unit-tested.
// ============================================

const CLASSROOM_CONTAINER_CLASS = "scaler-classroom-info";
const CLASSROOM_TAG_CLASS = "scaler-classroom-tag";
const CLASSROOM_STYLE_ID = "scaler-classroom-styles";
const CLASSROOM_POPOVER_ID = "scaler-classroom-popover";
const CLASSROOM_TOAST_ID = "scaler-classroom-toast";
const CLASSROOM_CACHE_TTL_MS = 60 * 1000;
const CLASSROOM_TOAST_MS = 3500;
const CLASSROOM_RENDERED_ATTR = "data-classroom-rendered";

/** Per-tone tag colours. Deliberately distinct from lectureInfo's blue tags so
 *  a room never reads as part of Scaler's own metadata. */
const CLASSROOM_TONES = {
  live: { bg: "rgba(22, 163, 74, 0.12)", fg: "#14532d" },
  history: { bg: "rgba(234, 179, 8, 0.14)", fg: "#713f12" },
  closed: { bg: "rgba(100, 116, 139, 0.12)", fg: "#334155" },
  unknown: { bg: "rgba(100, 116, 139, 0.10)", fg: "#475569" },
};

const _classroomCache = {
  key: "",
  timestamp: 0,
  states: null,
  inFlight: null,
  warnedFor: "",
};

/** Class ids with a vote in flight. Their cards are left alone until it lands. */
const _classroomPending = new Set();

let _classroomEmail = null;

// ── plumbing ─────────────────────────────────────────────────────────────────

function _classroomIsDashboard() {
  return location.href.includes("mentee-dashboard");
}

function _classroomEnabled() {
  return (
    typeof currentSettings === "undefined" ||
    currentSettings["classroom-tag"] !== false
  );
}

/**
 * The signed-in student's email, as recorded by usernameTracker.
 *
 * Only a real address is cached. An empty read means usernameTracker has not
 * finished its profile sync yet — caching that as the final answer left the
 * feature permanently telling the user to sign in, on a page where they
 * demonstrably already are.
 */
function _getClassroomEmail() {
  if (_classroomEmail) return Promise.resolve(_classroomEmail);
  if (!isExtensionValid()) return Promise.resolve("");

  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get("scaler_user", (result) => {
        const email = result?.scaler_user?.email || "";
        if (email) _classroomEmail = email;
        resolve(email);
      });
    } catch (_err) {
      resolve("");
    }
  });
}

function _sendClassroomMessage(payload) {
  if (!isExtensionValid()) return Promise.resolve({ success: false, error: "no_context" });

  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(payload, (response) => {
        resolve(response || { success: false, error: "no_response" });
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

// ── styles ───────────────────────────────────────────────────────────────────

function _injectClassroomStyles() {
  if (document.getElementById(CLASSROOM_STYLE_ID)) return;

  const style = document.createElement("style");
  style.id = CLASSROOM_STYLE_ID;
  style.textContent = `
    /* inline-block on a plain baseline, NOT inline-flex + vertical-align:
       middle. A flex box aligns by its own centre, which left the chip's text
       sitting off the "Live Class" baseline it stands next to. Default baseline
       alignment lines the two text runs up exactly, and padding no longer
       shifts anything because it does not move a baseline. */
    .${CLASSROOM_CONTAINER_CLASS} {
      display: inline-block;
      margin-left: 8px;
      white-space: nowrap;
    }
    .${CLASSROOM_TAG_CLASS} {
      display: inline-block;
      /* Inherit the surrounding size so the letters match the line they sit on;
         em padding then scales with whatever Scaler sets. */
      font: inherit;
      font-size: 0.92em;
      padding: 0.15em 0.5em;
      border-radius: 6px;
      letter-spacing: 0.2px;
      border: none;
      cursor: pointer;
      line-height: inherit;
      vertical-align: baseline;
    }
    .${CLASSROOM_TAG_CLASS}[disabled] { cursor: default; }
    .${CLASSROOM_TAG_CLASS}-pending { opacity: 0.55; }
    #${CLASSROOM_TOAST_ID} {
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 2147483001;
      max-width: 300px;
      padding: 9px 12px;
      border-radius: 8px;
      background: #0f172a;
      color: #f8fafc;
      font-size: 12px;
      font-family: inherit;
      box-shadow: 0 8px 24px rgba(15, 23, 42, 0.3);
    }
    #${CLASSROOM_POPOVER_ID} {
      position: absolute;
      z-index: 2147483000;
      min-width: 190px;
      padding: 10px;
      border-radius: 10px;
      background: #ffffff;
      color: #0f172a;
      box-shadow: 0 8px 28px rgba(15, 23, 42, 0.22);
      font-size: 12px;
      font-family: inherit;
    }
    #${CLASSROOM_POPOVER_ID} .scr-head {
      font-weight: 600;
      margin-bottom: 6px;
    }
    #${CLASSROOM_POPOVER_ID} .scr-contested {
      margin: -2px 0 7px;
      font-size: 11px;
      color: #b45309;
    }
    #${CLASSROOM_POPOVER_ID} .scr-note {
      margin-top: 8px;
      font-size: 10px;
      color: #64748b;
      line-height: 1.35;
    }
    #${CLASSROOM_POPOVER_ID} .scr-room {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      width: 100%;
      padding: 5px 7px;
      margin-bottom: 3px;
      border: none;
      border-radius: 6px;
      background: rgba(15, 23, 42, 0.04);
      color: inherit;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
    }
    #${CLASSROOM_POPOVER_ID} .scr-room:hover { background: rgba(15, 23, 42, 0.09); }
    #${CLASSROOM_POPOVER_ID} .scr-room[aria-pressed="true"] {
      background: rgba(22, 163, 74, 0.16);
      font-weight: 600;
    }
    #${CLASSROOM_POPOVER_ID} .scr-room[disabled] { opacity: 0.55; cursor: not-allowed; }
    #${CLASSROOM_POPOVER_ID} .scr-count { color: #64748b; }
    #${CLASSROOM_POPOVER_ID} .scr-clear {
      width: 100%;
      margin-top: 4px;
      padding: 5px 7px;
      border: none;
      border-radius: 6px;
      background: rgba(220, 38, 38, 0.09);
      color: #7f1d1d;
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      text-align: left;
    }
    #${CLASSROOM_POPOVER_ID} .scr-clear:hover { background: rgba(220, 38, 38, 0.16); }
  `;
  document.head.appendChild(style);
}

// ── popover ──────────────────────────────────────────────────────────────────

function _closeClassroomPopover() {
  document.getElementById(CLASSROOM_POPOVER_ID)?.remove();

  if (window._classroomPopoverAbort) {
    window._classroomPopoverAbort.abort();
    window._classroomPopoverAbort = null;
  }
}

/**
 * Open the room picker for one card.
 *
 * Counts shown are head counts only. Weights, accuracy scores and voter
 * identities never reach the client — being able to see who said what is what
 * turns a wrong tap into a pile-on.
 */
function _openClassroomPopover(anchor, meta, state) {
  _closeClassroomPopover();
  _injectClassroomStyles();

  const popover = document.createElement("div");
  popover.id = CLASSROOM_POPOVER_ID;

  const head = document.createElement("div");
  head.className = "scr-head";
  head.textContent = state.votingOpen ? "Where is this class?" : "Where was this class?";
  popover.appendChild(head);

  // With no dissent chip on the card, this is where a contested room shows up.
  if (state.dissent && state.dissent.room) {
    const contested = document.createElement("div");
    contested.className = "scr-contested";
    contested.textContent = `${state.dissent.voters} also said ${formatRoomName(state.dissent.room)}`;
    popover.appendChild(contested);
  }

  const tallies = state.tallies || {};
  const rooms = window.CLASSROOM_ROOMS || [];

  rooms.forEach((room) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "scr-room";
    button.setAttribute("aria-pressed", String(state.myVote === room));
    if (!state.votingOpen || state.offline) button.disabled = true;

    const name = document.createElement("span");
    name.textContent = formatRoomName(room);
    button.appendChild(name);

    const count = document.createElement("span");
    count.className = "scr-count";
    count.textContent = tallies[room] ? String(tallies[room]) : "";
    button.appendChild(count);

    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      // Clicking the answer you already hold takes it back. Mirrors the
      // transcript-version voting UI, and is what people try first.
      _castClassroomVote(anchor, meta, state.myVote === room ? null : room, state);
    });

    popover.appendChild(button);
  });

  // The toggle above is invisible until you try it, so say it out loud.
  if (state.myVote && state.votingOpen && !state.offline) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "scr-clear";
    clear.textContent = `Remove my answer (${formatRoomName(state.myVote)})`;
    clear.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      _castClassroomVote(anchor, meta, null, state);
    });
    popover.appendChild(clear);
  }

  const note = document.createElement("div");
  note.className = "scr-note";
  if (state.offline) {
    note.textContent =
      "Could not reach the vote server, so nobody's answers are loaded. Voting again in a moment usually works.";
  } else if (!state.votingOpen) {
    note.textContent = `Voting is closed. It runs from 24 hours before the class until it ends — this one is ${_classroomWindowLabel(meta)}.`;
  } else {
    note.textContent =
      "Votes are tied to your Scaler account, and you can change yours whenever the room changes. Two people have to agree before a room is shown.";
  }
  popover.appendChild(note);

  document.body.appendChild(popover);

  // Position under the tag, kept inside the viewport.
  const rect = anchor.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - popover.offsetWidth - 8;
  popover.style.top = `${top}px`;
  popover.style.left = `${Math.max(window.scrollX + 8, Math.min(rect.left + window.scrollX, maxLeft))}px`;

  // One signal tears down every listener this popover installs.
  const controller = new AbortController();
  window._classroomPopoverAbort = controller;

  document.addEventListener(
    "click",
    (event) => {
      if (!popover.contains(event.target) && event.target !== anchor) {
        _closeClassroomPopover();
      }
    },
    { signal: controller.signal },
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape") _closeClassroomPopover();
    },
    { signal: controller.signal },
  );

  window.addEventListener("scroll", _closeClassroomPopover, {
    signal: controller.signal,
    passive: true,
  });
}

/** Human-readable class window, for explaining a closed vote. */
function _classroomWindowLabel(meta) {
  const opts = { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" };
  try {
    return new Date(meta.startsAt).toLocaleString(undefined, opts);
  } catch (_err) {
    return meta.classDate || "unknown";
  }
}

// ── voting ───────────────────────────────────────────────────────────────────

const CLASSROOM_REFUSALS = {
  window_closed: "Voting is closed for this class.",
  daily_cap: "You have hit today's vote limit.",
  bad_room: "That room is not on the list.",
  bad_times: "Could not read this class's timings.",
  email_required: "Sign in through the extension popup to vote.",
};

/**
 * Cast, change or withdraw one answer.
 *
 * `room === null` is a withdrawal, and must survive the round trip as an
 * explicit null rather than being defaulted away into an empty string.
 */
function _cardForClass(classId) {
  return document.querySelector(
    `a.me-cr-classroom-url[data-lecture-instructor-info-id="${classId}"], ` +
      `a.me-cr-classroom-url[href*="/class/${classId}"]`,
  );
}

/**
 * Cast, change or withdraw one answer.
 *
 * The click is acknowledged before the network is touched: the popover closes
 * at once and the chip goes into a "saving" state. Waiting for the round trip
 * made every vote feel like the extension had hung, and the answer the server
 * returns is authoritative anyway — so there is nothing to gain by making the
 * person watch it arrive.
 *
 * `room === null` is a withdrawal, and must survive as an explicit null rather
 * than being defaulted away into an empty string.
 */
function _castClassroomVote(anchor, meta, room, previousState) {
  _closeClassroomPopover();

  const classId = meta.classId;
  const card = (anchor && anchor.closest("a.me-cr-classroom-url")) || _cardForClass(classId);

  _classroomPending.add(classId);
  if (card && previousState) {
    _applyClassroomState(card, meta, { ...previousState, myVote: room }, { pending: true });
  }

  (async () => {
    try {
      const email = await _getClassroomEmail();
      if (!email) {
        _classroomToast(CLASSROOM_REFUSALS.email_required);
        return;
      }

      const response = await _sendClassroomMessage({
        action: "voteClassroom",
        classId,
        email,
        room: room === null ? null : room,
        meta,
      });

      if (!response.success) {
        _classroomToast(
          CLASSROOM_REFUSALS[response.error] ||
            (room === null ? "Could not remove your answer." : "Could not save your vote."),
        );
        return;
      }

      // The vote changed the tally, so the cached batch is stale.
      _classroomCache.key = "";
      _classroomCache.states = null;

      const state = response.data?.state;
      if (state && card) _applyClassroomState(card, meta, state);
    } finally {
      _classroomPending.delete(classId);
      // Whatever happened, the card must not stay stuck in "saving".
      if (card) card.removeAttribute(CLASSROOM_RENDERED_ATTR);
    }
  })();
}

/** Transient message, since the popover is already gone by the time we know. */
function _classroomToast(message) {
  document.getElementById(CLASSROOM_TOAST_ID)?.remove();

  const toast = document.createElement("div");
  toast.id = CLASSROOM_TOAST_ID;
  toast.textContent = message;
  document.body.appendChild(toast);

  clearTimeout(window._classroomToastTimer);
  window._classroomToastTimer = setTimeout(() => {
    toast.remove();
    window._classroomToastTimer = null;
  }, CLASSROOM_TOAST_MS);
}

function _renderClassroomStatus(anchor, message) {
  const popover = document.getElementById(CLASSROOM_POPOVER_ID);
  const note = popover?.querySelector(".scr-note");
  if (note) note.textContent = message;
}

// ── rendering ────────────────────────────────────────────────────────────────

/** Scaler's "Live Class" / "Online Class" line — the row we sit under. */
const CLASSROOM_TYPE_LINE_CLASS = "_2GsNsJLDK4elcdmjka5HmF";

/** The card's time row, used as a fallback anchor. */
const CLASSROOM_TIME_ROW_CLASS = "_1EQZYaGMSYVhKTiIKY-qXP";

/**
 * Our own container — never lectureInfo's, which gets innerHTML-wiped on
 * re-render.
 *
 * It goes on the class-type line ("Live Class"), in the empty space to the
 * right of that text, and NOT in `.mentee-card__header`: that header is a
 * nowrap flex row shared with lectureInfo's batch and instructor tags, so
 * anything added there pushes them off the edge of the card.
 *
 * The tag is appended *inside* Scaler's class-type div rather than styled
 * alongside it, so no Scaler node's own styles are touched — the div stays a
 * block, its text node stays first, and an inline-flex child simply lands after
 * the text. Teardown removes our node and the original line is unchanged.
 */
function _classroomContainer(card) {
  const existing = card.querySelector(`.${CLASSROOM_CONTAINER_CLASS}`);
  if (existing) return existing;

  const content = card.querySelector(".mentee-card__content");
  const typeLine = card.querySelector(`.${CLASSROOM_TYPE_LINE_CLASS}`);
  const timeRow = card.querySelector(`.${CLASSROOM_TIME_ROW_CLASS}`);
  if (!content && !typeLine && !timeRow) return null;

  const container = document.createElement("div");
  container.className = CLASSROOM_CONTAINER_CLASS;

  // Scaler's class-card markup uses hashed class names, so each anchor is
  // treated as optional and the next one takes over.
  if (typeLine) {
    typeLine.appendChild(container);
  } else if (timeRow) {
    timeRow.insertAdjacentElement("beforebegin", container);
  } else {
    content.appendChild(container);
  }

  return container;
}

/**
 * Everything about a card's rendered output, as one comparable string.
 *
 * The observer watches the same subtree this function writes into, so an
 * unconditional re-render re-triggered the observer, which re-rendered, forever
 * — a 300 ms render loop for as long as the tab stayed open. Comparing against
 * the last rendered signature makes a no-op pass genuinely do nothing, which is
 * what breaks the cycle.
 */
function _classroomSignature(state) {
  const tag = formatRoomTag(state);
  return [tag.text, tag.tone, state.myVote || "-", state.votingOpen ? "open" : "shut"].join("|");
}

function _applyClassroomState(card, meta, state, options) {
  if (!card) return;

  const pending = options && options.pending;
  const signature = `${_classroomSignature(state)}${pending ? "|pending" : ""}`;
  if (card.getAttribute(CLASSROOM_RENDERED_ATTR) === signature) return;

  const container = _classroomContainer(card);
  if (!container) return;

  container.innerHTML = "";
  card.setAttribute(CLASSROOM_RENDERED_ATTR, signature);

  const tag = formatRoomTag(state);
  const button = document.createElement("button");
  button.type = "button";
  button.className = CLASSROOM_TAG_CLASS;
  button.textContent = tag.text;
  button.title = tag.title;

  const tone = CLASSROOM_TONES[tag.tone] || CLASSROOM_TONES.unknown;
  button.style.backgroundColor = tone.bg;
  button.style.color = tone.fg;

  if (pending) {
    button.classList.add(`${CLASSROOM_TAG_CLASS}-pending`);
    button.title = "Saving your answer…";
  }

  button.addEventListener("click", (event) => {
    // The whole card is an anchor; without this the click navigates instead.
    event.preventDefault();
    event.stopPropagation();
    _openClassroomPopover(button, meta, state);
  });

  container.appendChild(button);
}

// ── fetch + inject ───────────────────────────────────────────────────────────

/**
 * The date tab the dashboard is showing — not necessarily today.
 *
 * Returns null rather than guessing. Assuming today was worse than useless: it
 * closed the vote window on every class shown on a future tab, and any vote
 * that did get through would be stored under the wrong class_date, weekday and
 * slot_start, quietly poisoning the history prior for that batch.
 */
function _activeClassroomDate() {
  return getActiveDashboardDate();
}

async function _fetchClassroomStates(metas) {
  const key = metas.map((meta) => meta.classId).sort().join(",");
  const now = Date.now();

  if (
    _classroomCache.states &&
    _classroomCache.key === key &&
    now - _classroomCache.timestamp < CLASSROOM_CACHE_TTL_MS
  ) {
    return _classroomCache.states;
  }

  if (_classroomCache.inFlight && _classroomCache.key === key) {
    return _classroomCache.inFlight;
  }

  const email = await _getClassroomEmail();

  _classroomCache.key = key;
  _classroomCache.inFlight = (async () => {
    // Captured, because `key` on the shared cache may have moved on by the time
    // this resolves — switching date tabs mid-flight used to let a stale reply
    // land under the newer request's key and serve states for cards that are no
    // longer on screen.
    const requestKey = key;
    try {
      const response = await _sendClassroomMessage({
        action: "fetchClassroomStates",
        email,
        classes: metas,
      });

      if (!response.success) {
        if (_classroomCache.warnedFor !== requestKey) {
          _classroomCache.warnedFor = requestKey;
          console.warn(
            `Scaler++: classroom states unavailable (${response.error}). ` +
              "Is the backend deployed, or scalerpp_backend_override set?",
          );
        }
        return null;
      }

      const states = {};
      for (const state of response.data?.states || []) {
        states[state.classId] = state;
      }

      if (_classroomCache.key === requestKey) {
        _classroomCache.states = states;
        _classroomCache.timestamp = Date.now();
      }
      return states;
    } finally {
      if (_classroomCache.key === requestKey) _classroomCache.inFlight = null;
    }
  })();

  return _classroomCache.inFlight;
}

/**
 * What a card shows before — or without — an answer from the backend.
 *
 * Rendering this first matters: the earlier version injected nothing until the
 * fetch succeeded, so a 404 or a dropped connection made the whole feature
 * vanish with no way to tell it apart from being switched off.
 */
function _placeholderClassroomState(meta, offline) {
  return {
    room: null,
    source: "none",
    voters: 0,
    dissent: null,
    tallies: {},
    myVote: null,
    votingOpen: isClassroomVoteOpen(
      Date.now(),
      Date.parse(meta.startsAt),
      Date.parse(meta.endsAt),
    ),
    offline: offline === true,
  };
}

async function injectClassroomTags() {
  if (!_classroomIsDashboard() || !_classroomEnabled()) return;

  const cards = document.querySelectorAll(
    'a.me-cr-classroom-url[data-cy="classroom-link"]',
  );
  if (!cards.length) return;

  const activeDate = _activeClassroomDate();
  if (!activeDate) {
    if (!window._classroomWarnedNoDate) {
      window._classroomWarnedNoDate = true;
      console.warn(
        "Scaler++: no active date tab found (.tabs__tab--active), so classroom " +
          "tags are skipped — a guessed date would store votes under the wrong day.",
      );
    }
    return;
  }

  const pairs = [];

  cards.forEach((card) => {
    const meta = buildClassroomMeta(card, activeDate);
    if (meta) pairs.push({ card, meta });
  });

  if (!pairs.length) return;

  // Paint what we know locally first. Cards that already carry a tag are left
  // alone so an observer burst cannot flicker a live label back to "Room ?".
  pairs.forEach(({ card, meta }) => {
    if (_classroomPending.has(meta.classId)) return;
    const container = _classroomContainer(card);
    if (container && !container.querySelector(`.${CLASSROOM_TAG_CLASS}`)) {
      _applyClassroomState(card, meta, _placeholderClassroomState(meta, false));
    }
  });

  const states = await _fetchClassroomStates(pairs.map((pair) => pair.meta));

  if (!states) {
    // Keep the placeholders, but let a click say why they are empty.
    pairs.forEach(({ card, meta }) => {
      if (_classroomPending.has(meta.classId)) return;
      _applyClassroomState(card, meta, _placeholderClassroomState(meta, true));
    });
    return;
  }

  pairs.forEach(({ card, meta }) => {
    if (_classroomPending.has(meta.classId)) return;
    const state = states[meta.classId];
    if (state) _applyClassroomState(card, meta, state);
  });
}

function observeDashboardForClassroomTags() {
  if (window._classroomVoteObserver) return;
  if (!_classroomIsDashboard()) return;

  // The handle lives on window, not in this closure: teardown has to be able
  // to cancel a pending pass, or a debounce armed moments before the feature is
  // switched off fires afterwards and re-injects everything it just removed.
  const observer = new MutationObserver(() => {
    clearTimeout(window._classroomVoteDebounce);
    window._classroomVoteDebounce = setTimeout(() => {
      window._classroomVoteDebounce = null;
      if (_classroomIsDashboard()) injectClassroomTags();
    }, 300);
  });

  const root =
    document.querySelector(".mentee-dashboard__content") ||
    document.querySelector(".mentee-dashboard") ||
    document.body;

  observer.observe(root, { childList: true, subtree: true });
  window._classroomVoteObserver = observer;
}

/** Remove everything this feature built. Called by content.js on toggle-off. */
function teardownClassroomTags() {
  _closeClassroomPopover();

  clearTimeout(window._classroomVoteDebounce);
  window._classroomVoteDebounce = null;
  clearTimeout(window._classroomToastTimer);
  window._classroomToastTimer = null;

  document.getElementById(CLASSROOM_TOAST_ID)?.remove();

  document
    .querySelectorAll(`.${CLASSROOM_CONTAINER_CLASS}`)
    .forEach((node) => node.remove());

  document
    .querySelectorAll(`[${CLASSROOM_RENDERED_ATTR}]`)
    .forEach((node) => node.removeAttribute(CLASSROOM_RENDERED_ATTR));

  _classroomPending.clear();

  document.getElementById(CLASSROOM_STYLE_ID)?.remove();

  if (window._classroomVoteObserver) {
    window._classroomVoteObserver.disconnect();
    window._classroomVoteObserver = null;
  }

  _classroomCache.key = "";
  _classroomCache.states = null;
  _classroomCache.timestamp = 0;
}

function initClassroomVote() {
  if (!_classroomIsDashboard()) {
    teardownClassroomTags();
    return;
  }
  if (!_classroomEnabled()) return;

  // The popover is anchored to a card element. After an SPA navigation that
  // card is detached, so anything still open is pointing at nothing.
  _closeClassroomPopover();

  _injectClassroomStyles();
  // Warm the signed-in email now; the first vote then has nothing to await.
  _getClassroomEmail();
  injectClassroomTags();
  observeDashboardForClassroomTags();
}
