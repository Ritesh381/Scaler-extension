// ============================================
// features/instructorInfo.js
// Dashboard tags + instructor tab on class session page
// ============================================
(function(global) {

const INSTRUCTOR_CONTAINER_CLASS = "scaler-instructor-info";
const INSTRUCTOR_TAG_CLASS = "scaler-instructor-tag";
const INSTRUCTOR_DATA_ATTR = "data-instructor-info-id";

const INSTRUCTOR_TAB_ID = "classroom-instructor-info";
const INSTRUCTOR_PANEL_ID = "scaler-instructor-panel";
const INSTRUCTOR_PANEL_ATTR = "data-scaler-instructor-panel";

const _dashboardInstructorCache = {
	timestamp: 0,
	lectureMap: null,
	inFlight: null,
	cacheKey: "",
};

const _sessionInstructorCache = {
	timestamp: 0,
	lectureMap: null,
	inFlight: null,
	cacheKey: "",
};

function _isTodosDashboard() {
	return location.href.includes("/academy/mentee-dashboard/todos");
}

function _isSessionPage() {
	const url = new URL(location.href);
	const isSessionPath = /\/academy\/mentee-dashboard\/class\/\d/.test(
		url.pathname,
	);
	return isSessionPath && url.searchParams.get("joinSession") !== "1";
}

function _formatDate(d) {
	const pad = (n) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _getEventsUrl(startDate, endDate) {
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

function _parseSessionDate(text) {
	if (!text) return null;
	const cleaned = text.replace(/,/g, " ").replace(/\s+/g, " ").trim();
	const match = cleaned.match(/(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
	if (!match) return null;

	const day = parseInt(match[1], 10);
	const monthStr = match[2].toLowerCase();
	const year = parseInt(match[3], 10);
	const months = [
		"jan",
		"feb",
		"mar",
		"apr",
		"may",
		"jun",
		"jul",
		"aug",
		"sep",
		"oct",
		"nov",
		"dec",
	];
	const monthIndex = months.findIndex((m) => monthStr.startsWith(m));
	if (monthIndex === -1) return null;
	return new Date(year, monthIndex, day, 0, 0, 0, 0);
}

function _getSessionDate() {
	const el = document.querySelector(".me-cr-header-dropdown-title__date");
	if (!el) return null;
	return _parseSessionDate(el.textContent.trim());
}

function _isSameDay(a, b) {
	if (!a || !b) return false;
	return (
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate()
	);
}

async function _fetchLectureMapForRange(cache, startDate, endDate) {
	const cacheTtlMs = 5 * 60 * 1000;
	const cacheKey = `${startDate}:${endDate}`;
	const now = Date.now();

	if (
		cache.lectureMap &&
		cache.cacheKey === cacheKey &&
		now - cache.timestamp < cacheTtlMs
	) {
		return cache.lectureMap;
	}

	if (cache.inFlight && cache.cacheKey === cacheKey) return cache.inFlight;

	cache.cacheKey = cacheKey;
	cache.inFlight = (async () => {
		try {
			const res = await fetch(_getEventsUrl(startDate, endDate));
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

			cache.timestamp = Date.now();
			cache.lectureMap = map;
			return map;
		} finally {
			cache.inFlight = null;
		}
	})();

	return cache.inFlight;
}

function _buildTag(text, title) {
	const tag = document.createElement("span");
	tag.className = INSTRUCTOR_TAG_CLASS;
	tag.textContent = text;
	if (title) tag.title = title;
	return tag;
}

function _applyInstructorInfo(card, lecture) {
	const header = card.querySelector(".mentee-card__header");
	if (!header || !lecture) return;

	// Prevent duplication if lectureInfo.js already added tags
	if (header.querySelector(".scaler-lecture-instructor-info")) return;

	const subject = _cleanBatchName(lecture.super_batch_name || "");
	const instructor = lecture.instructors_name || "";

	if (!subject && !instructor) return;

	let container = header.querySelector(`.${INSTRUCTOR_CONTAINER_CLASS}`);
	if (!container) {
		container = document.createElement("div");
		container.className = INSTRUCTOR_CONTAINER_CLASS;
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

	container.querySelectorAll(`.${INSTRUCTOR_TAG_CLASS}`).forEach((tag) => {
		tag.style.fontSize = "11px";
		tag.style.padding = "4px 6px";
		tag.style.borderRadius = "6px";
		tag.style.backgroundColor = "rgba(0, 115, 255, 0.08)";
		tag.style.color = "#000000";
		tag.style.letterSpacing = "0.2px";
	});

	card.setAttribute(INSTRUCTOR_DATA_ATTR, String(lecture.sbat_id || ""));
}

async function _injectDashboardInstructorInfo() {
	if (!_isTodosDashboard()) return;

	const cards = document.querySelectorAll(
		'a.me-cr-classroom-url[data-cy="classroom-link"]',
	);
	if (!cards.length) return;

	const today = new Date();
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7);
	const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
	const startDate = _formatDate(start);
	const endDate = _formatDate(end);

	let lectureMap = null;
	try {
		lectureMap = await _fetchLectureMapForRange(
			_dashboardInstructorCache,
			startDate,
			endDate,
		);
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

		const existingId = card.getAttribute(INSTRUCTOR_DATA_ATTR);
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
	if (window._instructorInfoObserver) {
		// Re-root if the SPA replaced the subtree we were watching.
		const watched = window._instructorInfoObserverRoot;
		if (watched === liveRoot && watched.isConnected) return;
		window._instructorInfoObserver.disconnect();
		window._instructorInfoObserver = null;
	}

	let debounceTimer = null;
	const observer = new MutationObserver(() => {
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (_isTodosDashboard()) {
				_injectDashboardInstructorInfo();
			}
		}, 300);
	});

	const root =
		document.querySelector(".mentee-dashboard__content") ||
		document.querySelector(".mentee-dashboard") ||
		document.body;

	observer.observe(root, { childList: true, subtree: true });
	window._instructorInfoObserver = observer;
	window._instructorInfoObserverRoot = root;
}

function _buildInfoRow(label, value, isEmail = false) {
	if (!value) return null;
	const row = document.createElement("div");
	row.style.display = "flex";
	row.style.gap = "8px";
	row.style.alignItems = "baseline";

	const labelEl = document.createElement("div");
	labelEl.style.fontWeight = "600";
	labelEl.style.minWidth = "120px";
	labelEl.textContent = label;

	const valueEl = document.createElement("div");
	if (isEmail) {
		const a = document.createElement("a");
		a.href = `mailto:${value}`;
		a.textContent = value;
		a.style.color = "#0073ff";
		a.style.textDecoration = "underline";
		valueEl.appendChild(a);
	} else {
		valueEl.textContent = value;
	}

	row.appendChild(labelEl);
	row.appendChild(valueEl);
	return row;
}

function _renderInstructorPanelContent(panel, lecture, sessionDate) {
	const contentRoot = panel.querySelector(".section-content");
	if (!contentRoot) return;
	contentRoot.innerHTML = "";

	const card = document.createElement("div");
	card.className = "event-card event-card--rounded";
	contentRoot.appendChild(card);

	const cardContent = document.createElement("div");
	cardContent.className = "event-card__content-container";
	cardContent.style.alignItems = "flex-start";
	cardContent.style.textAlign = "left";
	cardContent.style.width = "100%";
	cardContent.style.boxSizing = "border-box";
	if (!cardContent.style.padding) cardContent.style.padding = "24px 32px";
	card.appendChild(cardContent);

	const header = document.createElement("div");
	header.className = "event-card__content-header";
	header.textContent = "Instructor Info [Scaler++]";
	header.style.textAlign = "left";
	header.style.width = "100%";
	cardContent.appendChild(header);

	if (!lecture) {
		const empty = document.createElement("div");
		empty.className = "event-card__content-subheader";
		empty.textContent = "No instructor data available for this session.";
		cardContent.appendChild(empty);
		return;
	}

	const list = document.createElement("div");
	list.className = "event-card__content-subheader";
	list.style.display = "grid";
	list.style.gap = "8px";
	list.style.marginTop = "10px";
	cardContent.appendChild(list);

	const dateText = sessionDate ? sessionDate.toDateString() : "";
	const rows = [
		_buildInfoRow("Instructor", lecture.instructors_name || ""),
		_buildInfoRow("Email", lecture.instructors_email || "", true),
		_buildInfoRow("Role", lecture.instructors_position || ""),
		_buildInfoRow("Company", lecture.instructors_company || ""),
		_buildInfoRow(
			"Rating",
			lecture.instructors_rating ? String(lecture.instructors_rating) : "",
		),
		_buildInfoRow(
			"Experience",
			lecture.instructors_experience
				? `${lecture.instructors_experience} hours`
				: "",
		),
	];

	rows.forEach((row) => {
		if (row) list.appendChild(row);
	});
}

function _ensureInstructorPanel() {
	let panel = document.getElementById(INSTRUCTOR_PANEL_ID);
	if (panel) return panel;

	panel = document.createElement("div");
	panel.id = INSTRUCTOR_PANEL_ID;
	panel.className = "section me-cr-section";
	panel.style.display = "none";
	panel.setAttribute(INSTRUCTOR_PANEL_ATTR, "true");

	const content = document.createElement("div");
	content.className = "section-content";
	panel.appendChild(content);

	const lectureContainer = document.querySelector(".me-cr-lecture-container") || document.querySelector(".flex-fill");
	// No place to mount yet: build nothing, or every observer tick would leave
	// another detached panel behind.
	if (!lectureContainer || !lectureContainer.parentElement) return null;
	lectureContainer.parentElement.insertBefore(panel, lectureContainer.nextSibling);

	return panel;
}

function _setLectureContainerVisible(isVisible) {
	const containers = document.querySelectorAll(".me-cr-lecture-container, .flex-fill");
	
	containers.forEach((container) => {
		// Avoid hiding our own panel if it somehow gets the flex-fill class
		if (container.id === INSTRUCTOR_PANEL_ID) return;

		if (isVisible) {
			const prev = container.dataset.scalerPrevDisplay;
			container.style.display = prev || "";
			delete container.dataset.scalerPrevDisplay;
		} else if (!container.dataset.scalerPrevDisplay) {
			container.dataset.scalerPrevDisplay = container.style.display;
			container.style.display = "none";
		}
	});
}

function _activateInstructorTab() {
	const tab = document.getElementById(INSTRUCTOR_TAB_ID);
	if (!tab) return;

	const tabs = tab.closest(".navigation-tabs");
	if (tabs) {
		tabs
			.querySelectorAll(".navigation-tab-item")
			.forEach((item) => {
				item.classList.remove("navigation-tab-item--active");
				item.classList.remove("me-cr-tabs__tab-item--active");
			});
	}

	tab.classList.add("navigation-tab-item--active");
	tab.classList.add("me-cr-tabs__tab-item--active");

	const panel = _ensureInstructorPanel();
	if (!panel) return;
	panel.style.display = "block";
	_setLectureContainerVisible(false);
}

function _deactivateInstructorTab() {
	const tab = document.getElementById(INSTRUCTOR_TAB_ID);
	if (tab) {
		tab.classList.remove("navigation-tab-item--active");
		tab.classList.remove("me-cr-tabs__tab-item--active");
	}

	const panel = document.getElementById(INSTRUCTOR_PANEL_ID);
	if (panel) panel.style.display = "none";
	_setLectureContainerVisible(true);
}

function _ensureNavigationHandler(navigationTabs) {
	if (!navigationTabs || navigationTabs.dataset.scalerInstructorNav === "true") {
		return;
	}

	navigationTabs.addEventListener("click", (event) => {
		const target = event.target.closest(".navigation-tab-item");
		if (!target) return;
		if (target.id === INSTRUCTOR_TAB_ID) return;
		_deactivateInstructorTab();
	});

	navigationTabs.dataset.scalerInstructorNav = "true";
}

function _ensureInstructorTab() {
	const navigationTabs = document.querySelector(".navigation-tabs");
	if (!navigationTabs) return null;

	let tab = document.getElementById(INSTRUCTOR_TAB_ID);
	if (!tab) {
		tab = document.createElement("a");
		tab.className = "navigation-tab-item me-cr-tabs__tab-item";
		tab.id = INSTRUCTOR_TAB_ID;
		tab.href = "#";

		const heading = document.createElement("div");
		heading.className = "me-cr-tabs__tab-item-heading";
		heading.textContent = "Instructor Info";
		tab.appendChild(heading);

		navigationTabs.appendChild(tab);
	}

	if (!tab.dataset.scalerInstructorHandler) {
		tab.addEventListener("click", (event) => {
			event.preventDefault();
			_activateInstructorTab();
		});
		tab.dataset.scalerInstructorHandler = "true";
	}

	_ensureNavigationHandler(navigationTabs);
	return tab;
}

async function _injectSessionInstructorInfo() {
	if (!_isSessionPage()) return;

	const sessionDate = _getSessionDate() || new Date();
	const startDate = _formatDate(sessionDate);
	const endDate = _formatDate(
		new Date(sessionDate.getFullYear(), sessionDate.getMonth(), sessionDate.getDate() + 1),
	);

	let lectureMap = null;
	try {
		lectureMap = await _fetchLectureMapForRange(
			_sessionInstructorCache,
			startDate,
			endDate,
		);
	} catch (error) {
		console.error("[Scaler++] Instructor info fetch failed:", error);
		return;
	}

	const classId = _extractClassId(location.pathname);
	let lecture = classId ? lectureMap.get(String(classId)) : null;

	if (!lecture) {
		const lectureCandidates = Array.from(lectureMap.values());
		lecture = lectureCandidates.find((item) => {
			const rawDate = item?.date_of_topic || item?.date;
			if (!rawDate) return false;
			const parsed = new Date(rawDate);
			return _isSameDay(parsed, sessionDate);
		});
	}

	const panel = _ensureInstructorPanel();
	if (!panel) return;
	// Re-render only when what the panel shows changes. Rebuilding it on every
	// observer tick mutated the observed subtree and kept the loop going.
	const renderKey = `${classId || ""}|${lecture?.sbat_id || ""}|${sessionDate.toDateString()}`;
	if (panel.dataset.scalerInstructorKey !== renderKey) {
		_renderInstructorPanelContent(panel, lecture, sessionDate);
		panel.dataset.scalerInstructorKey = renderKey;
		panel.dataset.scalerInstructorLecture = lecture?.sbat_id
			? String(lecture.sbat_id)
			: "";
	}

	const tab = document.getElementById(INSTRUCTOR_TAB_ID);
	if (tab) {
		const heading = tab.querySelector(".me-cr-tabs__tab-item-heading");
		if (heading) {
			if (lecture && lecture.instructors_name) {
				const firstName = lecture.instructors_name.trim().split(/\s+/)[0];
				// Escape HTML just in case
				const safeName = firstName.replace(/</g, "&lt;").replace(/>/g, "&gt;");
				const html = `Instructor Info <span style="color: #94a1b5;">(${safeName})</span>`;
				if (heading.innerHTML !== html) heading.innerHTML = html;
			} else if (heading.textContent !== "Instructor Info") {
				heading.textContent = "Instructor Info";
			}
		}
	}
}

function _observeSessionInstructorInfo() {
	if (window._instructorTabObserver) return;
	if (!_isSessionPage()) return;

	let debounceTimer = null;
	const observer = new MutationObserver((mutations) => {
		// Our own panel/tab edits are not page changes worth reacting to.
		const ours = (node) =>
			node && node.closest && node.closest(`#${INSTRUCTOR_PANEL_ID}, #${INSTRUCTOR_TAB_ID}`);
		if (mutations.every((m) => ours(m.target.nodeType === 1 ? m.target : m.target.parentElement))) return;
		clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			if (_isSessionPage()) {
				_ensureInstructorTab();
				_injectSessionInstructorInfo();
			}
		}, 300);
	});

	const root = document.querySelector(".me-cr-body") || document.body;
	observer.observe(root, { childList: true, subtree: true });
	window._instructorTabObserver = observer;
}

function _teardownSessionObserver() {
	if (window._instructorTabObserver) {
		window._instructorTabObserver.disconnect();
		window._instructorTabObserver = null;
	}
}

global.initInstructorInfo = function() {
	if (_isTodosDashboard()) {
		_injectDashboardInstructorInfo();
		_observeDashboardForInstructorInfo();
	} else if (window._instructorInfoObserver) {
		window._instructorInfoObserver.disconnect();
		window._instructorInfoObserver = null;
	}

	if (_isSessionPage()) {
		_ensureInstructorTab();
		_injectSessionInstructorInfo();
		_observeSessionInstructorInfo();
	} else {
		_teardownSessionObserver();
	}
};
})(window);