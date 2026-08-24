// ============================================
// features/lectureSummary.js
// AI lecture summary tab on the class session page.
//
// Flow:
//   1. User opens the "Summary" tab on a session page.
//   2. Look up a cached summary on the backend (GET /api/summary?slug=).
//        found    → render it.
//        missing  → check the transcript cache for the same lecture.
//            transcript cached → show a "Generate" button.
//            no transcript     → ask the user to generate the transcript first.
//   3. Generate calls the user's own OpenAI-compatible LLM (via the background
//      service worker) with the transcript, then caches the structured result.
//
// The lecture slug is the SAME identifier used for transcripts, so a lecture's
// transcript and summary share one key. The numeric class id is saved as
// metadata alongside it.
// ============================================
(function (global) {
  const SUMMARY_TAB_ID = "classroom-lecture-summary";
  const SUMMARY_PANEL_ID = "scaler-summary-panel";
  const INSTRUCTOR_PANEL_ID = "scaler-instructor-panel"; // sibling feature — never hide it
  const SUMMARY_CONFIG_KEY = "scaler_summary_config";

  // Per-URL cache so repeated tab opens don't refetch the slug/title.
  const _lectureCache = { url: "", promise: null };
  // Cache transcript text per slug so Generate doesn't refetch a huge payload.
  const _transcriptTextCache = new Map();

  function _isSessionPage() {
    const url = new URL(location.href);
    const isSessionPath = /\/academy\/mentee-dashboard\/class\/\d/.test(
      url.pathname,
    );
    return isSessionPath && url.searchParams.get("joinSession") !== "1";
  }

  function _extractClassId() {
    const match = location.pathname.match(/\/class\/(\d+)/);
    return match ? match[1] : null;
  }

  // ── Lecture identity (classId + slug + title) ───────────────────────────
  // Mirrors videoDownloader._fetchLectureSlug: resolve the unique slug from
  // Scaler's classroom meta API. Kept self-contained so this feature has no
  // hard dependency on the video downloader instance.
  function _resolveLecture() {
    const currentUrl = location.pathname;
    if (_lectureCache.promise && _lectureCache.url === currentUrl) {
      return _lectureCache.promise;
    }

    _lectureCache.url = currentUrl;
    _lectureCache.promise = (async () => {
      const classId = _extractClassId();
      if (!classId) return { classId: null, slug: null, title: "" };

      try {
        const res = await fetch(
          `https://www.scaler.com/api/v2/classroom/${classId}/meta`,
          { credentials: "include" },
        );
        if (!res.ok) {
          return { classId, slug: null, title: document.title || "" };
        }
        const json = await res.json();
        const attrs = json?.data?.attributes || {};
        const slug = attrs.slug || null;
        // Prefer the specific lecture topic title over the course/module name.
        const title =
          attrs.current_topic?.title ||
          attrs.name ||
          document.title ||
          slug ||
          "";
        return { classId, slug, title };
      } catch (e) {
        console.warn("[Scaler++] Summary: failed to resolve lecture:", e.message);
        return { classId, slug: null, title: document.title || "" };
      }
    })();

    return _lectureCache.promise;
  }

  function _getUserEmail() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["scaler_user"], (r) =>
          resolve(r?.scaler_user?.email || ""),
        );
      } catch (e) {
        resolve("");
      }
    });
  }

  function _getSummaryConfig() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([SUMMARY_CONFIG_KEY], (r) =>
          resolve(r?.[SUMMARY_CONFIG_KEY] || {}),
        );
      } catch (e) {
        resolve({});
      }
    });
  }

  function _saveSummaryConfig(config) {
    try {
      chrome.storage.local.set({ [SUMMARY_CONFIG_KEY]: config });
    } catch (e) {
      /* ignore */
    }
  }

  // ── Background messaging helpers ────────────────────────────────────────
  function _sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(resp || { success: false, error: "No response" });
        });
      } catch (e) {
        resolve({ success: false, error: e.message });
      }
    });
  }

  // ── Tab + panel scaffolding (mirrors instructorInfo.js) ─────────────────
  function _ensureSummaryPanel() {
    let panel = document.getElementById(SUMMARY_PANEL_ID);
    if (panel) return panel;

    panel = document.createElement("div");
    panel.id = SUMMARY_PANEL_ID;
    panel.className = "section me-cr-section";
    panel.style.display = "none";

    const content = document.createElement("div");
    content.className = "section-content";
    panel.appendChild(content);

    const lectureContainer =
      document.querySelector(".me-cr-lecture-container") ||
      document.querySelector(".flex-fill");
    if (lectureContainer && lectureContainer.parentElement) {
      lectureContainer.parentElement.insertBefore(
        panel,
        lectureContainer.nextSibling,
      );
    }

    return panel;
  }

  function _setLectureContainerVisible(isVisible) {
    const containers = document.querySelectorAll(
      ".me-cr-lecture-container, .flex-fill",
    );
    containers.forEach((container) => {
      // Never touch our own panel or the instructor panel.
      if (container.id === SUMMARY_PANEL_ID) return;
      if (container.id === INSTRUCTOR_PANEL_ID) return;

      if (isVisible) {
        const prev = container.dataset.scalerSummaryPrevDisplay;
        if (prev !== undefined) {
          // Never restore to "none" — that value can leak in if another panel
          // (e.g. instructor info) had the container hidden when we captured it.
          container.style.display = prev && prev !== "none" ? prev : "";
          delete container.dataset.scalerSummaryPrevDisplay;
        }
      } else if (container.dataset.scalerSummaryPrevDisplay === undefined) {
        container.dataset.scalerSummaryPrevDisplay = container.style.display;
        container.style.display = "none";
      }
    });
  }

  function _deactivateInstructorPanelIfOpen() {
    const tab = document.getElementById("classroom-instructor-info");
    if (tab) {
      tab.classList.remove("navigation-tab-item--active");
      tab.classList.remove("me-cr-tabs__tab-item--active");
    }
    const panel = document.getElementById(INSTRUCTOR_PANEL_ID);
    if (panel) panel.style.display = "none";
  }

  function _activateSummaryTab() {
    const tab = document.getElementById(SUMMARY_TAB_ID);
    if (!tab) return;

    const tabs = tab.closest(".navigation-tabs");
    if (tabs) {
      tabs.querySelectorAll(".navigation-tab-item").forEach((item) => {
        item.classList.remove("navigation-tab-item--active");
        item.classList.remove("me-cr-tabs__tab-item--active");
      });
    }

    tab.classList.add("navigation-tab-item--active");
    tab.classList.add("me-cr-tabs__tab-item--active");

    _deactivateInstructorPanelIfOpen();

    const panel = _ensureSummaryPanel();
    panel.style.display = "block";

    // Defer the container hide so it wins over the instructor feature's
    // bubbled nav handler, which re-shows the container on any non-instructor
    // tab click. Running last guarantees the summary panel stands alone.
    setTimeout(() => _setLectureContainerVisible(false), 0);

    _loadSummary(panel);
  }

  function _deactivateSummaryTab(restoreContainer) {
    const tab = document.getElementById(SUMMARY_TAB_ID);
    if (tab) {
      tab.classList.remove("navigation-tab-item--active");
      tab.classList.remove("me-cr-tabs__tab-item--active");
    }
    const panel = document.getElementById(SUMMARY_PANEL_ID);
    if (panel) panel.style.display = "none";
    if (restoreContainer) _setLectureContainerVisible(true);
  }

  function _ensureNavigationHandler(navigationTabs) {
    if (!navigationTabs || navigationTabs.dataset.scalerSummaryNav === "true") {
      return;
    }
    navigationTabs.addEventListener("click", (event) => {
      const target = event.target.closest(".navigation-tab-item");
      if (!target) return;
      if (target.id === SUMMARY_TAB_ID) return; // our own tab handles itself
      // If the instructor tab was clicked it manages the container itself —
      // don't restore it. For native tabs, restore the lecture container.
      const restore = target.id !== "classroom-instructor-info";
      _deactivateSummaryTab(restore);
    });
    navigationTabs.dataset.scalerSummaryNav = "true";
  }

  function _ensureSummaryTab() {
    const navigationTabs = document.querySelector(".navigation-tabs");
    if (!navigationTabs) return null;

    let tab = document.getElementById(SUMMARY_TAB_ID);
    if (!tab) {
      tab = document.createElement("a");
      tab.className = "navigation-tab-item me-cr-tabs__tab-item";
      tab.id = SUMMARY_TAB_ID;
      tab.href = "#";

      const heading = document.createElement("div");
      heading.className = "me-cr-tabs__tab-item-heading";
      heading.textContent = "Notes";
      tab.appendChild(heading);

      // Keep Notes ahead of the Instructor Info tab. If the instructor tab
      // already exists, slot in before it; otherwise append (the instructor
      // tab, if added later, appends after us → Notes still comes first).
      const instructorTab = document.getElementById("classroom-instructor-info");
      if (instructorTab && instructorTab.parentElement === navigationTabs) {
        navigationTabs.insertBefore(tab, instructorTab);
      } else {
        navigationTabs.appendChild(tab);
      }
    }

    if (!tab.dataset.scalerSummaryHandler) {
      tab.addEventListener("click", (event) => {
        event.preventDefault();
        _activateSummaryTab();
      });
      tab.dataset.scalerSummaryHandler = "true";
    }

    _ensureNavigationHandler(navigationTabs);
    return tab;
  }

  // ── Rendering helpers ───────────────────────────────────────────────────
  const NOTES_STYLE_ID = "scaler-notes-styles";

  // One-time stylesheet so we get :hover, custom bullets and clean typography
  // (inline styles can't express those).
  function _ensureNotesStyles() {
    if (document.getElementById(NOTES_STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = NOTES_STYLE_ID;
    style.textContent = `
      #scaler-summary-panel{padding:0;margin:0;}
      #scaler-summary-panel .section-content{padding:0;margin:0;}
      .scaler-notes-root{max-width:820px;margin:0 auto;padding:14px 14px 48px;color:#1e293b;font-family:inherit;}
      .scaler-notes-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;}
      .scaler-notes-title{font-size:26px;font-weight:800;letter-spacing:-.02em;color:#0f172a;display:flex;align-items:center;gap:10px;}
      .scaler-notes-chip{font-size:11px;font-weight:700;color:#4f46e5;background:#eef2ff;border-radius:999px;padding:3px 9px;letter-spacing:.02em;}
      .scaler-notes-sub{font-size:13px;color:#94a3b8;margin-top:4px;}
      .scaler-notes-gearwrap{position:relative;flex:none;}
      .scaler-notes-gear{display:inline-flex;align-items:center;gap:6px;background:#eef2ff;border:1px solid #e0e7ff;color:#4f46e5;cursor:pointer;font-size:13px;font-weight:600;padding:7px 12px;border-radius:9px;transition:background .15s,border-color .15s;}
      .scaler-notes-gear:hover{background:#e0e7ff;border-color:#c7d2fe;}
      .scaler-notes-gear svg{display:block;}
      .scaler-notes-popover{position:absolute;top:calc(100% + 8px);right:0;width:330px;max-width:90vw;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.16);padding:16px;display:grid;gap:11px;z-index:50;}
      .scaler-notes-popover label{font-size:12px;font-weight:600;color:#475569;display:block;margin-bottom:4px;}
      .scaler-notes-popover input,.scaler-notes-popover select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:7px;font-size:13px;width:100%;box-sizing:border-box;background:#fff;color:#0f172a;}
      .scaler-notes-poptitle{font-weight:700;font-size:13px;color:#0f172a;}
      .scaler-notes-popnote{font-size:11px;color:#94a3b8;line-height:1.5;}
      .scaler-notes-dlwrap{position:relative;display:inline-flex;}
      .scaler-notes-dl{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;background:#f1f5f9;border:1px solid #e2e8f0;color:#475569;cursor:pointer;border-radius:9px;transition:background .15s,border-color .15s;}
      .scaler-notes-dl:hover{background:#e2e8f0;border-color:#cbd5e1;}
      .scaler-notes-menu{position:absolute;top:calc(100% + 8px);left:0;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 32px rgba(15,23,42,.16);padding:6px;display:grid;gap:2px;z-index:50;min-width:180px;}
      .scaler-notes-menu button{display:flex;align-items:center;gap:8px;width:100%;text-align:left;background:none;border:none;cursor:pointer;font-size:13px;font-weight:500;color:#334155;padding:9px 10px;border-radius:7px;}
      .scaler-notes-menu button:hover{background:#f1f5f9;}
      .scaler-notes-section{margin-top:30px;}
      .scaler-notes-shead{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
      .scaler-notes-badge{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none;}
      .scaler-notes-shead h3{margin:0;font-size:16px;font-weight:700;}
      .scaler-notes-brief{margin-top:22px;background:#fbfbfd;border:1px solid #f1f5f9;border-radius:14px;padding:20px 22px;}
      .scaler-notes-para{font-size:15.5px;line-height:1.85;color:#334155;margin:0 0 14px;}
      .scaler-notes-para:first-child{margin-top:0;}
      .scaler-notes-para:last-child{margin-bottom:0;}
      .scaler-notes-concept{margin-bottom:18px;}
      .scaler-notes-concept:last-child{margin-bottom:0;}
      .scaler-notes-ctitle{font-size:15px;font-weight:700;color:#7c3aed;margin:0 0 6px;}
      .scaler-notes-list{list-style:none;margin:0;padding:0;display:grid;gap:1px;}
      .scaler-notes-item{position:relative;padding:5px 12px 5px 28px;border-radius:8px;font-size:15px;line-height:1.55;color:#334155;transition:background .15s ease;}
      .scaler-notes-item::before{content:"";position:absolute;left:12px;top:12px;width:6px;height:6px;border-radius:50%;background:var(--dot,#cbd5e1);}
      .scaler-notes-item:hover{background:#f8fafc;}
      .scaler-notes-msg{font-size:15px;line-height:1.6;color:#475569;margin-top:16px;}
      .scaler-notes-foot{margin-top:32px;padding-top:14px;border-top:1px solid #f1f5f9;font-size:12px;color:#b6c0cf;}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  // opts.showGear (default true) controls the "AI Settings" button — we hide it
  // once notes already exist, since there's nothing left to configure/generate.
  function _panelContentRoot(panel, opts) {
    const showGear = !(opts && opts.showGear === false);
    _ensureNotesStyles();
    const sectionContent = panel.querySelector(".section-content");
    sectionContent.innerHTML = "";

    const root = document.createElement("div");
    root.className = "scaler-notes-root";
    sectionContent.appendChild(root);

    const head = document.createElement("div");
    head.className = "scaler-notes-head";

    const titleWrap = document.createElement("div");
    const title = document.createElement("div");
    title.className = "scaler-notes-title";
    title.innerHTML = `📒 Lecture Notes <span class="scaler-notes-chip">Scaler++</span>`;
    titleWrap.appendChild(title);
    head.appendChild(titleWrap);

    if (showGear) {
      const gearWrap = document.createElement("div");
      gearWrap.className = "scaler-notes-gearwrap";

      const gear = document.createElement("button");
      gear.type = "button";
      gear.title = "AI settings";
      gear.className = "scaler-notes-gear";
      gear.innerHTML = `${_GEAR_SVG}<span>AI Settings</span>`;
      gear.addEventListener("click", (e) => {
        e.stopPropagation();
        _toggleSettings(gearWrap);
      });
      gearWrap.appendChild(gear);
      head.appendChild(gearWrap);
    }

    root.appendChild(head);

    return root;
  }

  const _GEAR_SVG =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';

  function _subText(parent, text) {
    const el = document.createElement("div");
    el.className = "scaler-notes-msg";
    el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function _renderSection(parent, opts, items) {
    if (!items || !items.length) return;
    const section = document.createElement("div");
    section.className = "scaler-notes-section";

    const shead = document.createElement("div");
    shead.className = "scaler-notes-shead";

    const badge = document.createElement("div");
    badge.className = "scaler-notes-badge";
    badge.textContent = opts.icon;
    badge.style.background = opts.badgeBg;

    const h = document.createElement("h3");
    h.textContent = opts.title;
    h.style.color = opts.titleColor;

    shead.appendChild(badge);
    shead.appendChild(h);
    section.appendChild(shead);

    const ul = document.createElement("ul");
    ul.className = "scaler-notes-list";
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "scaler-notes-item";
      li.style.setProperty("--dot", opts.dot);
      li.textContent = item;
      ul.appendChild(li);
    });
    section.appendChild(ul);
    parent.appendChild(section);
  }

  // Normalise the brief into an array of { title, body } concepts. Accepts the
  // new array shape, a bare string (legacy), or an array of strings.
  function _normaliseBrief(brief) {
    if (!brief) return [];
    if (typeof brief === "string") {
      const t = brief.trim();
      return t ? [{ title: "", body: t }] : [];
    }
    if (!Array.isArray(brief)) return [];
    return brief
      .map((c) => {
        if (typeof c === "string") return { title: "", body: c.trim() };
        if (c && typeof c === "object") {
          return {
            title: String(c.title || "").trim(),
            body: String(c.body || c.text || "").trim(),
          };
        }
        return null;
      })
      .filter((c) => c && (c.title || c.body));
  }

  // Renders the story-telling brief as a sequence of titled concepts, each
  // explained in flowing prose paragraphs (no bullets).
  function _renderBrief(parent, brief) {
    const concepts = _normaliseBrief(brief);
    if (!concepts.length) return;

    const section = document.createElement("div");
    section.className = "scaler-notes-section";

    const shead = document.createElement("div");
    shead.className = "scaler-notes-shead";
    const badge = document.createElement("div");
    badge.className = "scaler-notes-badge";
    badge.textContent = "📖";
    badge.style.background = "#ede9fe";
    const h = document.createElement("h3");
    h.textContent = "Lecture Brief";
    h.style.color = "#7c3aed";
    shead.appendChild(badge);
    shead.appendChild(h);
    section.appendChild(shead);

    const box = document.createElement("div");
    box.className = "scaler-notes-brief";

    concepts.forEach((concept) => {
      const block = document.createElement("div");
      block.className = "scaler-notes-concept";

      if (concept.title) {
        const ct = document.createElement("div");
        ct.className = "scaler-notes-ctitle";
        ct.textContent = concept.title;
        block.appendChild(ct);
      }

      const paras = concept.body
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter(Boolean);
      (paras.length ? paras : [concept.body]).forEach((p) => {
        const el = document.createElement("p");
        el.className = "scaler-notes-para";
        el.textContent = p;
        block.appendChild(el);
      });

      box.appendChild(block);
    });

    section.appendChild(box);
    parent.appendChild(section);
  }

  // Per-category accent palette (keyed by summary field).
  const SECTION_META = {
    announcements: { title: "Announcements", icon: "📢", badgeBg: "#ffe4e6", titleColor: "#e11d48", dot: "#fb7185" },
    deadlines:     { title: "Deadlines",     icon: "⏰", badgeBg: "#fef3c7", titleColor: "#d97706", dot: "#fbbf24" },
    topics:        { title: "Topics Taught", icon: "📚", badgeBg: "#e0e7ff", titleColor: "#4f46e5", dot: "#818cf8" },
    notes:         { title: "Key Takeaways", icon: "📝", badgeBg: "#d1fae5", titleColor: "#059669", dot: "#34d399" },
  };

  // Display order: action items first, then topics, the narrative brief, and
  // finally the key takeaways. "brief" is the prose section.
  const NOTES_ORDER = ["announcements", "deadlines", "topics", "brief", "notes"];
  const BULLET_KEYS = ["announcements", "deadlines", "topics", "notes"];

  // ── Download (Transcript / Notes-as-Markdown) ───────────────────────────
  const _DOWNLOAD_SVG =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';

  function _safeFileName(s) {
    return (
      String(s || "lecture")
        .replace(/[^a-z0-9\-_ ]+/gi, "")
        .trim()
        .replace(/\s+/g, "-")
        .slice(0, 80) || "lecture"
    );
  }

  // The specific class/lecture name shown in the session header
  // (e.g. "Model Context Protocol (MCP) & Agent Communication"), preferred over
  // the course/module name from the meta API for naming downloads.
  function _lectureName(lecture) {
    const el = document.querySelector(
      ".me-cr-header-dropdown-title__label .bold",
    );
    const domName = el ? el.textContent.trim() : "";
    return domName || (lecture && lecture.title) || "Lecture";
  }

  function _downloadFile(filename, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      console.warn("[Scaler++] Download failed:", e.message);
    }
  }

  // Compile the structured summary into a single Markdown document.
  function _buildNotesMarkdown(summary, meta, lecture) {
    const lines = [];
    lines.push(`# Lecture Notes — ${_lectureName(lecture)}`, "");

    const brief = _normaliseBrief(summary.brief);
    if (brief.length) {
      lines.push("## 📖 Lecture Brief", "");
      brief.forEach((c) => {
        if (c.title) lines.push(`### ${c.title}`, "");
        if (c.body) lines.push(c.body, "");
      });
    }

    const sec = (key, heading) => {
      const items = summary[key];
      if (items && items.length) {
        lines.push(`## ${heading}`, "");
        items.forEach((i) => lines.push(`- ${i}`));
        lines.push("");
      }
    };
    sec("announcements", "📢 Announcements");
    sec("deadlines", "⏰ Deadlines");
    sec("topics", "📚 Topics Taught");
    sec("notes", "📝 Key Takeaways");

    if (meta && (meta.generatedBy || meta.model)) {
      lines.push("---", "");
      const bits = [];
      if (meta.generatedBy) bits.push(`Generated by ${meta.generatedBy}`);
      if (meta.model) bits.push(`Model: ${meta.model}`);
      lines.push(`_${bits.join("  ·  ")}_`);
    }
    return lines.join("\n");
  }

  async function _downloadTranscript(lecture) {
    if (!lecture || !lecture.slug) return;
    let text = _transcriptTextCache.get(lecture.slug);
    if (!text) {
      const r = await _sendMessage({ action: "checkTranscriptCache", slug: lecture.slug });
      if (r?.success && r.data?.cached && r.data.text) {
        text = r.data.text;
        _transcriptTextCache.set(lecture.slug, text);
      }
    }
    if (!text) {
      console.warn("[Scaler++] No transcript available to download.");
      return;
    }
    _downloadFile(`${_safeFileName(_lectureName(lecture))}-transcript.txt`, text, "text/plain;charset=utf-8");

    // This panel handed over a real transcript but never reported it, so these
    // downloads were invisible to both the user counters and the per-version
    // count that decides which transcript everyone gets served.
    try {
      const email = await _getUserEmail();
      if (email && chrome.runtime?.id) {
        chrome.runtime.sendMessage({
          action: "trackDownload",
          email,
          downloadType: "transcript",
          lecture: _lectureName(lecture) || "",
          lectureSlug: lecture.slug,
          source: "cache",
        });
      }
    } catch (_) {
      /* tracking must never break the download */
    }
  }

  // A download icon button that opens a small menu: Transcript / Notes.
  function _buildDownloadControl(summary, meta, lecture) {
    const wrap = document.createElement("div");
    wrap.className = "scaler-notes-dlwrap";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scaler-notes-dl";
    btn.title = "Download";
    btn.innerHTML = _DOWNLOAD_SVG;

    const menu = document.createElement("div");
    menu.className = "scaler-notes-menu";
    menu.style.display = "none";

    const mkItem = (label, onClick) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.style.display = "none";
        onClick();
      });
      return b;
    };

    menu.appendChild(mkItem("⬇️  Transcript (.txt)", () => _downloadTranscript(lecture)));
    menu.appendChild(
      mkItem("⬇️  Notes (.md)", () =>
        _downloadFile(
          `${_safeFileName(_lectureName(lecture))}-notes.md`,
          _buildNotesMarkdown(summary, meta, lecture),
          "text/markdown;charset=utf-8",
        ),
      ),
    );

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === "none" ? "grid" : "none";
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  function _renderSummary(panel, summary, meta, lecture) {
    // Notes already exist → nothing to configure, so hide the AI Settings button.
    const root = _panelContentRoot(panel, { showGear: false });

    const hasBrief = _normaliseBrief(summary?.brief).length > 0;
    const isEmpty =
      !summary || (!hasBrief && BULLET_KEYS.every((k) => !summary[k]?.length));
    if (isEmpty) {
      _subText(root, "These notes came back empty — try regenerating.");
      return;
    }

    // Download button, right after the "Lecture Notes" title.
    const titleEl = root.querySelector(".scaler-notes-title");
    if (titleEl) titleEl.appendChild(_buildDownloadControl(summary, meta, lecture));

    NOTES_ORDER.forEach((key) => {
      if (key === "brief") _renderBrief(root, summary.brief);
      else _renderSection(root, SECTION_META[key], summary[key]);
    });

    if (meta && (meta.generatedBy || meta.model)) {
      const footer = document.createElement("div");
      footer.className = "scaler-notes-foot";
      const bits = [];
      if (meta.generatedBy) bits.push(`Generated by ${meta.generatedBy}`);
      if (meta.model) bits.push(`Model: ${meta.model}`);
      footer.textContent = bits.join("  ·  ");
      root.appendChild(footer);
    }
  }

  function _renderGenerate(panel, lecture) {
    const root = _panelContentRoot(panel);
    _subText(
      root,
      "A transcript is cached for this lecture — generate your notes from it using your own AI key (set it via the ⚙ icon).",
    );

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "✨ Generate Notes";
    btn.style.cssText =
      "margin-top:18px;padding:11px 20px;border:none;border-radius:10px;background:linear-gradient(135deg,#4f46e5,#6366f1);color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(79,70,229,.25);";
    btn.addEventListener("click", () => _onGenerate(panel, lecture, btn));
    root.appendChild(btn);
  }

  function _renderNoTranscript(panel) {
    const root = _panelContentRoot(panel);
    _subText(
      root,
      "No transcript is cached for this lecture yet. Generate the transcript first (via the recording download tool), then come back to create your notes.",
    );

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "🎙️ Generate Transcript";
    btn.style.cssText =
      "margin-top:18px;padding:11px 20px;border:none;border-radius:10px;background:linear-gradient(135deg,#0ea5e9,#0284c7);color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 12px rgba(2,132,199,.25);";
    btn.addEventListener("click", () => {
      // Open the recording/session flow where the download+transcript tool lives.
      const url = new URL(location.href);
      url.searchParams.set("joinSession", "1");
      location.href = url.toString();
    });
    root.appendChild(btn);
  }

  function _renderMessage(panel, message) {
    const root = _panelContentRoot(panel);
    _subText(root, message);
  }

  // ── Settings (gear) popover ─────────────────────────────────────────────
  // OpenAI-compatible chat/completions endpoints + a sensible default model.
  const PROVIDER_PRESETS = [
    { id: "openai",     label: "OpenAI",             baseUrl: "https://api.openai.com/v1",                                model: "gpt-4o-mini",              apiKeyUrl: "https://platform.openai.com/api-keys" },
    { id: "gemini",     label: "Google Gemini",      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",  model: "gemini-3.1-flash-lite",    apiKeyUrl: "https://aistudio.google.com/apikey" },
    { id: "groq",       label: "Groq",               baseUrl: "https://api.groq.com/openai/v1",                           model: "llama-3.3-70b-versatile",  apiKeyUrl: "https://console.groq.com/keys" },
    { id: "openrouter", label: "OpenRouter",         baseUrl: "https://openrouter.ai/api/v1",                             model: "openai/gpt-4o-mini",       apiKeyUrl: "https://openrouter.ai/keys" },
    { id: "anthropic",  label: "Claude (Anthropic)", baseUrl: "https://api.anthropic.com/v1",                             model: "claude-haiku-4-5-20251001", apiKeyUrl: "https://console.anthropic.com/settings/keys" },
    { id: "custom",     label: "Custom",             baseUrl: "",                                                         model: "",                         apiKeyUrl: "" },
  ];

  // Opens (or closes) the settings popover anchored next to the gear button.
  async function _toggleSettings(anchor) {
    const existing = anchor.querySelector("[data-scaler-summary-settings]");
    if (existing) {
      existing.remove();
      return;
    }

    const config = await _getSummaryConfig();
    const DEFAULT_PROVIDER = PROVIDER_PRESETS.find((p) => p.id === "openai");
    if (!config.provider && !config.baseUrl) {
      config.provider = DEFAULT_PROVIDER.id;
      config.baseUrl  = DEFAULT_PROVIDER.baseUrl;
      config.model    = DEFAULT_PROVIDER.model;
      _saveSummaryConfig(config);
    }

    const box = document.createElement("div");
    box.setAttribute("data-scaler-summary-settings", "true");
    box.className = "scaler-notes-popover";
    box.addEventListener("click", (e) => e.stopPropagation());

    const title = document.createElement("div");
    title.className = "scaler-notes-poptitle";
    title.textContent = "AI Settings (OpenAI-compatible)";
    box.appendChild(title);

    // Build the text inputs first so the provider <select> can autofill them.
    const mkField = (labelText, key, type, placeholder) => {
      const wrap = document.createElement("div");
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = type;
      input.value = config[key] || "";
      input.placeholder = placeholder;
      input.addEventListener("input", () => {
        config[key] = input.value.trim();
        _saveSummaryConfig(config);
      });
      wrap.appendChild(label);
      wrap.appendChild(input);
      return { wrap, input };
    };

    const baseUrlField = mkField("Base URL", "baseUrl", "text", DEFAULT_PROVIDER.baseUrl);
    const modelField = mkField("Model", "model", "text", DEFAULT_PROVIDER.model);
    // API Key field with a dynamic "Get API Key" link.
    const apiKeyWrap = document.createElement("div");
    const apiKeyLabelRow = document.createElement("div");
    apiKeyLabelRow.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;";
    const apiKeyLabel = document.createElement("label");
    apiKeyLabel.textContent = "API Key";
    apiKeyLabel.style.margin = "0";
    const apiKeyLink = document.createElement("a");
    const currentPreset = PROVIDER_PRESETS.find((p) => p.id === (config.provider || DEFAULT_PROVIDER.id));
    apiKeyLink.href = currentPreset?.apiKeyUrl || "";
    apiKeyLink.target = "_blank";
    apiKeyLink.rel = "noopener noreferrer";
    apiKeyLink.textContent = "Get API Key ↗";
    apiKeyLink.style.cssText = "font-size:11px;font-weight:600;color:#6366f1;text-decoration:none;cursor:pointer;";
    apiKeyLink.addEventListener("mouseenter", () => { apiKeyLink.style.textDecoration = "underline"; });
    apiKeyLink.addEventListener("mouseleave", () => { apiKeyLink.style.textDecoration = "none"; });
    if (!currentPreset?.apiKeyUrl) apiKeyLink.style.display = "none";
    apiKeyLabelRow.appendChild(apiKeyLabel);
    apiKeyLabelRow.appendChild(apiKeyLink);
    const apiKeyInput = document.createElement("input");
    apiKeyInput.type = "password";
    apiKeyInput.value = config.apiKey || "";
    apiKeyInput.placeholder = "sk-...";
    apiKeyInput.addEventListener("input", () => {
      config.apiKey = apiKeyInput.value.trim();
      _saveSummaryConfig(config);
    });
    apiKeyWrap.appendChild(apiKeyLabelRow);
    apiKeyWrap.appendChild(apiKeyInput);
    const apiKeyField = { wrap: apiKeyWrap, input: apiKeyInput };

    // Provider preset dropdown → autofills Base URL + Model on selection.
    const provWrap = document.createElement("div");
    const provLabel = document.createElement("label");
    provLabel.textContent = "Provider";
    const select = document.createElement("select");
    PROVIDER_PRESETS.forEach((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      select.appendChild(opt);
    });
    const matched = PROVIDER_PRESETS.find(
      (p) => p.id !== "custom" && p.baseUrl === (config.baseUrl || "").trim(),
    );
    select.value = config.provider || (matched ? matched.id : DEFAULT_PROVIDER.id);
    select.addEventListener("change", () => {
      const preset = PROVIDER_PRESETS.find((p) => p.id === select.value);
      config.provider = select.value;
      if (preset && preset.id !== "custom") {
        baseUrlField.input.value = preset.baseUrl;
        modelField.input.value = preset.model;
        config.baseUrl = preset.baseUrl;
        config.model = preset.model;
        apiKeyField.input.focus();
      }
      // Update "Get API Key" link for the selected provider.
      const selectedPreset = PROVIDER_PRESETS.find((p) => p.id === select.value);
      if (selectedPreset?.apiKeyUrl) {
        apiKeyLink.href = selectedPreset.apiKeyUrl;
        apiKeyLink.style.display = "";
      } else {
        apiKeyLink.style.display = "none";
      }
      _saveSummaryConfig(config);
    });
    provWrap.appendChild(provLabel);
    provWrap.appendChild(select);

    box.appendChild(provWrap);
    box.appendChild(baseUrlField.wrap);
    box.appendChild(modelField.wrap);
    box.appendChild(apiKeyField.wrap);

    const note = document.createElement("div");
    note.className = "scaler-notes-popnote";
    note.textContent =
      "Your key is stored locally in this browser and used only to call your endpoint. It is never sent to Scaler++ servers.";
    box.appendChild(note);

    anchor.appendChild(box);
  }

  // ── Generate flow ───────────────────────────────────────────────────────
  async function _onGenerate(panel, lecture, btn) {
    const config = await _getSummaryConfig();
    if (!config.baseUrl || !config.apiKey) {
      _renderGenerate(panel, lecture);
      const root = panel.querySelector(".scaler-notes-root");
      const gearWrap = panel.querySelector(".scaler-notes-gearwrap");
      if (gearWrap) _toggleSettings(gearWrap);
      _subText(
        root,
        "⚠ Add your Base URL and API Key in settings (⚙) first, then click Generate again.",
      );
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = "Generating…";
      btn.style.opacity = "0.7";
    }

    // 1. Get the transcript text (cached on the backend).
    let transcript = _transcriptTextCache.get(lecture.slug);
    if (!transcript) {
      const tResp = await _sendMessage({
        action: "checkTranscriptCache",
        slug: lecture.slug,
      });
      if (tResp?.success && tResp.data?.cached && tResp.data.text) {
        transcript = tResp.data.text;
        _transcriptTextCache.set(lecture.slug, transcript);
      }
    }
    if (!transcript) {
      _renderMessage(
        panel,
        "Could not load the transcript for this lecture. It may no longer be cached.",
      );
      return;
    }

    // 2. Generate via the user's LLM (through the background worker).
    const gResp = await _sendMessage({
      action: "generateSummary",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model || "",
      transcript,
    });

    if (!gResp?.success) {
      _renderGenerate(panel, lecture);
      const root = panel.querySelector(".scaler-notes-root");
      const err = gResp?.error || "unknown error";
      if (_isTooLargeError(err)) {
        _renderMessageInline(root, "Bhai, Paid model use kar le 🥲");
        _renderDetail(
          root,
          "This lecture's transcript is larger than your model's context limit. Try a model with a bigger context window (usually a paid model). Recommended : Gemini",
        );
      } else {
        _renderMessageInline(root, `❌ Generation failed: ${err}`);
      }
      return;
    }

    const summary = gResp.summary;
    const email = await _getUserEmail();

    // 3. Render + cache (first-write-wins on the backend).
    _renderSummary(
      panel,
      summary,
      { generatedBy: email, model: config.model || "" },
      lecture,
    );

    _sendMessage({
      action: "saveSummary",
      slug: lecture.slug,
      classId: lecture.classId || "",
      title: lecture.title || lecture.slug,
      summary,
      model: config.model || "",
      generatedBy: email,
    });
  }

  function _renderMessageInline(root, text) {
    const el = document.createElement("div");
    el.className = "scaler-notes-msg";
    el.style.color = "#dc2626";
    el.textContent = text;
    root.appendChild(el);
  }

  function _renderDetail(root, text) {
    const el = document.createElement("div");
    el.className = "scaler-notes-msg";
    el.style.fontSize = "13px";
    el.style.color = "#94a3b8";
    el.style.marginTop = "6px";
    el.textContent = text;
    root.appendChild(el);
  }

  // True when an LLM error indicates the prompt/transcript exceeded the model's
  // context window or request-size limit (across OpenAI/Gemini/Groq/OpenRouter/Claude).
  function _isTooLargeError(msg) {
    return /context[_ ]length|context window|maximum context|too long|too large|reduce the length|request entity too large|payload too large|\b413\b|exceeds? (the )?(maximum|context|token)|input is too long/i.test(
      String(msg || ""),
    );
  }

  // ── Loader (decides what to show when the tab opens) ────────────────────
  async function _loadSummary(panel) {
    _renderMessage(panel, "Loading summary…");

    const lecture = await _resolveLecture();
    if (!lecture.slug) {
      _renderMessage(
        panel,
        "Couldn't identify this lecture, so a summary can't be looked up.",
      );
      return;
    }

    // 1. Cached summary?
    const sResp = await _sendMessage({
      action: "checkSummaryCache",
      slug: lecture.slug,
    });
    if (sResp?.success && sResp.data?.cached && sResp.data.summary) {
      _renderSummary(
        panel,
        sResp.data.summary,
        { generatedBy: sResp.data.generatedBy, model: sResp.data.model },
        lecture,
      );
      return;
    }

    // 2. Transcript cached? → offer Generate.
    const tResp = await _sendMessage({
      action: "checkTranscriptCache",
      slug: lecture.slug,
    });
    if (tResp?.success && tResp.data?.cached) {
      if (tResp.data.text) _transcriptTextCache.set(lecture.slug, tResp.data.text);
      _renderGenerate(panel, lecture);
      return;
    }

    // 3. No transcript → tell the user to make one first.
    _renderNoTranscript(panel);
  }

  function _observeSession() {
    if (!_isSessionPage()) return;

    // Always re-target: a stale observer from a previous (possibly detached)
    // page would otherwise keep us from watching the current DOM.
    if (window._summaryTabObserver) {
      window._summaryTabObserver.disconnect();
      window._summaryTabObserver = null;
    }

    // Leading-edge: add the tab the moment the tab-bar shows up. Acting only
    // while the tab is missing avoids both debounce starvation (slow/busy
    // pages that mutate continuously) and hammering once it exists.
    const observer = new MutationObserver(() => {
      if (_isSessionPage() && !document.getElementById(SUMMARY_TAB_ID)) {
        _ensureSummaryTab();
      }
    });

    const root = document.querySelector(".me-cr-body") || document.body;
    observer.observe(root, { childList: true, subtree: true });
    window._summaryTabObserver = observer;
  }

  // Bounded fallback poll for slow loads: keep trying until the tab exists,
  // the page is no longer a session, or we exhaust the attempt budget (~20s).
  function _scheduleTabRetries() {
    if (window._summaryTabRetry) {
      clearInterval(window._summaryTabRetry);
      window._summaryTabRetry = null;
    }
    let attempts = 0;
    const MAX_ATTEMPTS = 40; // 40 × 500ms ≈ 20s
    window._summaryTabRetry = setInterval(() => {
      attempts += 1;
      if (!_isSessionPage() || _ensureSummaryTab() || attempts >= MAX_ATTEMPTS) {
        clearInterval(window._summaryTabRetry);
        window._summaryTabRetry = null;
      }
    }, 500);
  }

  function _teardownSession() {
    if (window._summaryTabObserver) {
      window._summaryTabObserver.disconnect();
      window._summaryTabObserver = null;
    }
    if (window._summaryTabRetry) {
      clearInterval(window._summaryTabRetry);
      window._summaryTabRetry = null;
    }
    _deactivateSummaryTab(true);
    const tab = document.getElementById(SUMMARY_TAB_ID);
    if (tab) tab.remove();
    const panel = document.getElementById(SUMMARY_PANEL_ID);
    if (panel) panel.remove();
  }

  global.initLectureSummary = function () {
    if (_isSessionPage()) {
      _ensureSummaryTab();
      _observeSession();
      _scheduleTabRetries();
    } else {
      _teardownSession();
    }
  };
})(window);
