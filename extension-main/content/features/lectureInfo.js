// ============================================
// features/lectureInfo.js
// Adds lecture-instructor + subject info to dashboard class cards
// ============================================

(function(global) {
const INSTRUCTOR_CARD_CLASS = "_1b4ouQze1boferRpnHE3E3";
const LECTURE_INSTRUCTOR_CONTAINER_CLASS = "scaler-lecture-instructor-info";
const LECTURE_INSTRUCTOR_TAG_CLASS = "scaler-lecture-instructor-tag";
const LECTURE_INSTRUCTOR_DATA_ATTR = "data-lecture-instructor-info-id";

const _lectureInstructorCache = {
  timestamp: 0,
  lectureMap: null,
  inFlight: null,
};

function _isTodosDashboard() {
  return location.href.includes("/academy/mentee-dashboard/todos");
}

function _formatDate(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _getEventsUrl() {
  const today = new Date();
  const start = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 7,
  );
  const end = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() + 7,
  );
  const startDate = _formatDate(start);
  const endDate = _formatDate(end);
  return `https://www.scaler.com/academy/mentee/events/?start_date=${startDate}&end_date=${endDate}`;
}

function _extractClassId(href) {
  if (!href) return null;
  const match = href.match(/\/class\/(\d+)/);
  return match ? match[1] : null;
}

function _cleanBatchName(name) {
  if (!name) return "";

  const disallowed = new Set(["sst", "group"]);
  const tokens = name.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => {
    const cleaned = token.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
    if (!cleaned) return false;
    const lower = cleaned.toLowerCase();
    if (disallowed.has(lower)) return false;
    if (cleaned.length === 1) return false;
    if (/\d{4}/.test(cleaned)) return false;
    return true;
  });

  const result = kept.join(" ").trim();
  return result || name;
}

async function _fetchLectureMap() {
  const cacheTtlMs = 5 * 60 * 1000;
  const now = Date.now();
  if (
    _lectureInstructorCache.lectureMap &&
    now - _lectureInstructorCache.timestamp < cacheTtlMs
  ) {
    return _lectureInstructorCache.lectureMap;
  }

  if (_lectureInstructorCache.inFlight) return _lectureInstructorCache.inFlight;

  _lectureInstructorCache.inFlight = (async () => {
    try {
      const res = await fetch(_getEventsUrl());
      if (!res.ok) {
        throw new Error(`Scaler events API error: ${res.status}`);
      }

      const data = await res.json();
      const lectures = [
        ...(data.pastEvents || []),
        ...(data.futureEvents || []),
      ];

      const map = new Map();
      lectures.forEach((lecture) => {
        if (!lecture || !lecture.sbat_id) return;
        map.set(String(lecture.sbat_id), lecture);
      });

      _lectureInstructorCache.timestamp = Date.now();
      _lectureInstructorCache.lectureMap = map;
      return map;
    } finally {
      _lectureInstructorCache.inFlight = null;
    }
  })();

  return _lectureInstructorCache.inFlight;
}

function _buildTag(text, title) {
  const tag = document.createElement("span");
  tag.className = LECTURE_INSTRUCTOR_TAG_CLASS;
  tag.textContent = text;
  if (title) tag.title = title;
  return tag;
}

function _applyInstructorInfo(card, lecture) {
  const header = card.querySelector(".mentee-card__header");
  if (!header || !lecture) return;

  // Prevent duplication if instructorInfo.js already added tags
  if (header.querySelector(".scaler-instructor-info")) return;

  const subject = _cleanBatchName(lecture.super_batch_name || "");
  const instructor = lecture.instructors_name || "";

  if (!subject && !instructor) return;

  let container = header.querySelector(
    `.${LECTURE_INSTRUCTOR_CONTAINER_CLASS}`,
  );
  if (!container) {
    container = document.createElement("div");
    container.className = LECTURE_INSTRUCTOR_CONTAINER_CLASS;
    container.style.display = "flex";
    container.style.flexWrap = "nowrap";
    container.style.gap = "6px";
    container.style.padding = "6px 8px 0";
    container.style.overflow = "hidden";
    container.style.whiteSpace = "nowrap";
    header.appendChild(container);
  } else {
    container.innerHTML = "";
  }

  if (subject) {
    const subjectTag = _buildTag(subject, lecture.super_batch_name);
    container.appendChild(subjectTag);
  }

  if (instructor) {
    const instructorTag = _buildTag(instructor, "Instructor");
    container.appendChild(instructorTag);
  }

  container
    .querySelectorAll(`.${LECTURE_INSTRUCTOR_TAG_CLASS}`)
    .forEach((tag) => {
      tag.style.fontSize = "11px";
      tag.style.padding = "4px 6px";
      tag.style.borderRadius = "6px";
      tag.style.backgroundColor = "rgba(0, 115, 255, 0.08)";
      tag.style.color = "#000000";
      tag.style.letterSpacing = "0.2px";
    });

  card.setAttribute(
    LECTURE_INSTRUCTOR_DATA_ATTR,
    String(lecture.sbat_id || ""),
  );
}

async function _injectInstructorInfo() {
  if (!_isTodosDashboard()) return;

  const cards = document.querySelectorAll(
    'a.me-cr-classroom-url[data-cy="classroom-link"]',
  );
  if (!cards.length) return;

  let lectureMap = null;
  try {
    lectureMap = await _fetchLectureMap();
  } catch (error) {
    console.error("[Scaler++] Instructor info fetch failed:", error);
    return;
  }

  cards.forEach((card) => {
    const href = card.getAttribute("href");
    const classId = _extractClassId(href);
    if (!classId) return;
    const lecture = lectureMap.get(String(classId));
    if (!lecture) return;

    const existingId = card.getAttribute(LECTURE_INSTRUCTOR_DATA_ATTR);
    if (existingId && existingId === String(lecture.sbat_id)) {
      return;
    }

    _applyInstructorInfo(card, lecture);
  });
}

function _observeDashboardForInstructorInfo() {
  if (!_isTodosDashboard()) return;
  const liveRoot =
    document.querySelector(".mentee-dashboard__content") ||
    document.querySelector(".mentee-dashboard") ||
    document.body;
  if (window._instructorInfoObserver_lecture) {
    // Re-root if the SPA replaced the subtree we were watching.
    const watched = window._instructorInfoObserverRoot_lecture;
    if (watched === liveRoot && watched.isConnected) return;
    window._instructorInfoObserver_lecture.disconnect();
    window._instructorInfoObserver_lecture = null;
  }

  let debounceTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (_isTodosDashboard()) {
        _injectInstructorInfo();
      }
    }, 300);
  });

  const root =
    document.querySelector(".mentee-dashboard__content") ||
    document.querySelector(".mentee-dashboard") ||
    document.body;

  observer.observe(root, { childList: true, subtree: true });
  window._instructorInfoObserver_lecture = observer;
  window._instructorInfoObserverRoot_lecture = root;
}

global.initLectureInfo = function() {
  if (_isTodosDashboard()) {
    _injectInstructorInfo();
    _observeDashboardForInstructorInfo();
  } else if (window._instructorInfoObserver_lecture) {
    window._instructorInfoObserver_lecture.disconnect();
    window._instructorInfoObserver_lecture = null;
  }
};

})(window);
