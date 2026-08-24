/**
 * Transcript versions page.
 *
 * Every transcription of a lecture is kept as its own version, because the old
 * cache overwrote by byte count and that systematically preferred the worst
 * output. This page lists them newest-first and lets people vote, so a bad
 * transcript stops being the copy everyone downloads.
 *
 * Transcript text is deliberately NOT fetched with the list — transcripts are
 * routinely 50 KB+, so text loads only when a row is expanded or downloaded.
 */

const PREVIEW_CHARS = 4000;

const params = new URLSearchParams(window.location.search);
const streamUrl = params.get("url") || "";
const lectureTitle = params.get("title") || "";
const lectureSlug = params.get("lectureSlug") || "";
const classId = params.get("classId") || "";
const sourceTabId = params.get("sourceTabId") || "";

const els = {
  lectureName: document.getElementById("lecture-name"),
  countPill: document.getElementById("count-pill"),
  createBtn: document.getElementById("create-btn"),
  emptyCreateBtn: document.getElementById("empty-create-btn"),
  loading: document.getElementById("loading"),
  list: document.getElementById("list"),
  empty: document.getElementById("empty"),
  error: document.getElementById("error"),
  errorDetail: document.getElementById("error-detail"),
  retryBtn: document.getElementById("retry-btn"),
  toast: document.getElementById("toast"),
  toastText: document.getElementById("toast-text"),
  toastIcon: document.getElementById("toast-icon"),
  template: document.getElementById("version-template"),
};

let userEmail = "";
// versionId -> full text, so collapsing and re-expanding costs nothing.
const textCache = new Map();

// ── Helpers ────────────────────────────────────────────────────────────

function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ success: false, error: chrome.runtime.lastError.message });
        } else {
          resolve(response || { success: false, error: "No response" });
        }
      });
    } catch (err) {
      resolve({ success: false, error: err.message });
    }
  });
}

function getUserEmail() {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(["scaler_user"], (result) => {
        resolve(result?.scaler_user?.email || "");
      });
    } catch (_) {
      resolve("");
    }
  });
}

function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!then || Number.isNaN(then)) return "Unknown date";

  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "Just now";

  const units = [
    ["minute", 60],
    ["hour", 60],
    ["day", 24],
    ["month", 30.4],
    ["year", 12],
  ];
  let value = seconds / 60;
  let label = "minute";
  for (let i = 0; i < units.length; i++) {
    const [name, divisor] = units[i];
    label = name;
    const next = units[i + 1];
    if (!next || value < next[1]) break;
    value /= next[1];
  }
  const rounded = Math.max(1, Math.floor(value));
  return `${rounded} ${label}${rounded === 1 ? "" : "s"} ago`;
}

function exactTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatChars(count) {
  if (!count) return "size unknown";
  if (count < 1000) return `${count} chars`;
  return `${(count / 1000).toFixed(1)}k chars`;
}

/** Filename mirrors the single-transcript download so files stay recognisable. */
function suggestedFilename() {
  const base = (lectureTitle || "Scaler_Lecture")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "_")
    .substring(0, 80)
    .replace(/_+$/, "");
  return base ? `${base}.txt` : "Scaler_Lecture.txt";
}

const TOAST_ICONS = {
  // A check reads as "saved" for an upvote or a withdrawal; a downvote gets its
  // own glyph so the message and the icon agree.
  good: '<polyline points="20 6 9 17 4 12"></polyline>',
  bad: '<path d="M17 14V2"></path><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"></path>',
};

let toastTimer = null;
function showToast(message, tone = "good") {
  els.toastText.textContent = message;
  els.toastIcon.innerHTML = TOAST_ICONS[tone] || TOAST_ICONS.good;
  els.toast.classList.remove("good", "bad");
  els.toast.classList.add("show", tone);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function showOnly(section) {
  els.loading.hidden = section !== "loading";
  els.list.hidden = section !== "list";
  els.empty.hidden = section !== "empty";
  els.error.hidden = section !== "error";
  // The empty state carries its own call to action, so the header button would
  // just be a second identical primary button on the same screen.
  els.createBtn.hidden = section === "empty";
}

// ── Navigation ─────────────────────────────────────────────────────────

/**
 * "Create a version" hands off to the existing transcription page, carrying the
 * stream URL this tab was opened with — that page needs it to pull the audio.
 */
function openProcessor() {
  if (!streamUrl) {
    showToast("Stream URL missing — reopen from the lecture page.", "bad");
    return;
  }
  const query = new URLSearchParams({
    url: streamUrl,
    type: "transcript",
    title: lectureTitle,
    lectureSlug,
    classId,
    sourceTabId,
  });
  window.location.href = `transcriptProcessor.html?${query.toString()}`;
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderPills(container, version) {
  container.replaceChildren();

  const provider = version.provider || "";
  const model = version.model || "";

  if (!provider && !model) {
    const pill = document.createElement("span");
    pill.className = "pill unknown";
    pill.textContent = "model not recorded";
    container.appendChild(pill);
    return;
  }

  if (provider) {
    const pill = document.createElement("span");
    pill.className = "pill provider";
    pill.textContent = provider;
    container.appendChild(pill);
  }
  if (model) {
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = model;
    container.appendChild(pill);
  }
}

function renderVersion(version, isTop) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  node.dataset.versionId = version.versionId;
  if (isTop) node.classList.add("is-top");

  node.querySelector(".rel").textContent = relativeTime(version.createdAt);
  node.querySelector(".exact").textContent = exactTime(version.createdAt);
  node.querySelector(".top-badge").hidden = !isTop;

  renderPills(node.querySelector(".v-pills"), version);

  const by = node.querySelector(".v-by");
  by.replaceChildren();
  const author = document.createElement("span");
  author.textContent = version.generatedBy
    ? `by ${version.generatedBy}`
    : "author not recorded";
  by.appendChild(author);
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "·";
  by.appendChild(sep);
  const size = document.createElement("span");
  size.textContent = formatChars(version.charCount);
  by.appendChild(size);

  const upBtn = node.querySelector(".act.up");
  const downBtn = node.querySelector(".act.down");
  const dlBtn = node.querySelector(".act.download");
  const chevBtn = node.querySelector(".act.chev");

  node.querySelector(".up-count").textContent = version.upvotes || 0;
  node.querySelector(".down-count").textContent = version.downvotes || 0;
  node.querySelector(".dl-count").textContent = version.downloadCount || 0;

  if (version.myVote === "up") upBtn.classList.add("active");
  if (version.myVote === "down") downBtn.classList.add("active");

  if (!userEmail) {
    upBtn.disabled = true;
    downBtn.disabled = true;
    upBtn.title = "Sign in through the extension popup to vote";
    downBtn.title = upBtn.title;
  }

  upBtn.addEventListener("click", () => castVote(node, version, "up"));
  downBtn.addEventListener("click", () => castVote(node, version, "down"));
  dlBtn.addEventListener("click", () => downloadVersion(node, version));
  chevBtn.addEventListener("click", () => togglePreview(node, version));

  return node;
}

function render(versions) {
  els.lectureName.textContent = lectureTitle || lectureSlug || "This lecture";
  els.lectureName.classList.remove("placeholder");

  if (!versions.length) {
    els.countPill.hidden = true;
    showOnly("empty");
    return;
  }

  els.countPill.hidden = false;
  els.countPill.textContent =
    versions.length === 1 ? "1 version" : `${versions.length} versions`;

  // Highest net votes wins the badge — the same ranking the backend serves to
  // clients that ask for "the" transcript. Ties fall to downloads, then recency.
  const topId = [...versions].sort((a, b) => {
    const scoreA = (a.upvotes || 0) - (a.downvotes || 0);
    const scoreB = (b.upvotes || 0) - (b.downvotes || 0);
    if (scoreA !== scoreB) return scoreB - scoreA;
    const dlA = a.downloadCount || 0;
    const dlB = b.downloadCount || 0;
    if (dlA !== dlB) return dlB - dlA;
    return new Date(b.createdAt) - new Date(a.createdAt);
  })[0]?.versionId;

  // Only badge a clear winner: with a single version, or when nobody has voted
  // and nobody has downloaded, "Top pick" would be meaningless.
  const hasSignal = versions.some(
    (v) => (v.upvotes || 0) || (v.downvotes || 0) || (v.downloadCount || 0),
  );

  const fragment = document.createDocumentFragment();
  for (const version of versions) {
    fragment.appendChild(
      renderVersion(version, hasSignal && versions.length > 1 && version.versionId === topId),
    );
  }
  els.list.replaceChildren(fragment);
  showOnly("list");
}

// ── Actions ────────────────────────────────────────────────────────────

async function castVote(node, version, vote) {
  if (!userEmail) return;

  const upBtn = node.querySelector(".act.up");
  const downBtn = node.querySelector(".act.down");
  // Clicking the vote you already hold withdraws it.
  const nextVote = version.myVote === vote ? null : vote;

  upBtn.disabled = true;
  downBtn.disabled = true;

  const response = await sendMessage({
    action: "voteTranscriptVersion",
    versionId: version.versionId,
    email: userEmail,
    vote: nextVote,
  });

  upBtn.disabled = false;
  downBtn.disabled = false;

  if (!response.success) {
    showToast("Could not save your vote. Try again.", "bad");
    return;
  }

  version.myVote = nextVote;
  version.upvotes = response.data?.upvotes ?? version.upvotes;
  version.downvotes = response.data?.downvotes ?? version.downvotes;

  node.querySelector(".up-count").textContent = version.upvotes || 0;
  node.querySelector(".down-count").textContent = version.downvotes || 0;
  upBtn.classList.toggle("active", nextVote === "up");
  downBtn.classList.toggle("active", nextVote === "down");

  if (nextVote === "up") {
    showToast("Thanks — noted as a good transcript.", "good");
  } else if (nextVote === "down") {
    showToast("Thanks — flagged so others skip it.", "bad");
  } else {
    showToast("Vote withdrawn.", "good");
  }
}

/** Fetch a version's text once and memoise it. */
async function loadText(versionId) {
  if (textCache.has(versionId)) return textCache.get(versionId);

  const response = await sendMessage({
    action: "getTranscriptVersion",
    versionId,
  });
  if (!response.success || !response.data?.text) return null;

  textCache.set(versionId, response.data.text);
  return response.data.text;
}

async function togglePreview(node, version) {
  const preview = node.querySelector(".v-preview");
  const textEl = node.querySelector(".preview-text");
  const moreEl = node.querySelector(".preview-more");
  const chevBtn = node.querySelector(".act.chev");

  if (!preview.hidden) {
    preview.hidden = true;
    node.classList.remove("open");
    chevBtn.setAttribute("aria-expanded", "false");
    return;
  }

  preview.hidden = false;
  node.classList.add("open");
  chevBtn.setAttribute("aria-expanded", "true");

  if (textEl.dataset.loaded === "1") return;

  textEl.textContent = "Loading transcript…";
  const text = await loadText(version.versionId);

  if (!text) {
    textEl.textContent = "Could not load this transcript.";
    return;
  }

  textEl.textContent = text.slice(0, PREVIEW_CHARS);
  textEl.dataset.loaded = "1";

  const total = [...text].length;
  if (text.length > PREVIEW_CHARS) {
    moreEl.hidden = false;
    moreEl.textContent = `Showing the first ${PREVIEW_CHARS.toLocaleString()} of ${total.toLocaleString()} characters — download for the full transcript.`;
  }
}

async function downloadVersion(node, version) {
  const dlBtn = node.querySelector(".act.download");
  dlBtn.disabled = true;

  const text = await loadText(version.versionId);
  if (!text) {
    dlBtn.disabled = false;
    showToast("Could not fetch that transcript.", "bad");
    return;
  }

  let finalText = text;
  try {
    if (classId) {
      const header = await buildMetadataHeader(classId, {
        generatedBy: version.generatedBy,
        provider: version.provider,
        model: version.model,
      });
      finalText = header + finalText;
    }
  } catch (err) {
    console.error("[Scaler++] Could not build metadata header:", err);
  }

  const blob = new Blob([finalText], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = suggestedFilename();
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);

  // Counted here and nowhere else: opening the page or previewing a row must
  // not inflate this, or it stops meaning "someone deliberately chose this".
  const response = await sendMessage({
    action: "recordVersionDownload",
    versionId: version.versionId,
  });
  if (response.success && typeof response.data?.downloadCount === "number") {
    version.downloadCount = response.data.downloadCount;
    node.querySelector(".dl-count").textContent = version.downloadCount;
  }

  if (userEmail) {
    try {
      chrome.runtime.sendMessage({
        action: "trackDownload",
        email: userEmail,
        downloadType: "transcript",
        lecture: lectureTitle,
        lectureSlug,
        source: "cache",
        provider: version.provider || "",
        model: version.model || "",
        versionId: version.versionId,
      });
    } catch (_) {
      /* the file is already downloaded — tracking must not surface an error */
    }
  }

  dlBtn.disabled = false;
  showToast("Downloaded — vote if it was any good.", "good");
}

// ── Metadata header (mirrors the other download paths) ─────────────────

async function buildMetadataHeader(id, attribution = {}) {
  if (!id) return "";

  let courseName = "N/A";
  let title = "N/A";
  let startTime = "N/A";
  let duration = "N/A";

  try {
    const [sessionRes, metaRes] = await Promise.allSettled([
      fetch(`https://www.scaler.com/api/v2/classroom/${id}/session`, { credentials: "include" }),
      fetch(`https://www.scaler.com/api/v2/classroom/${id}/meta`, { credentials: "include" }),
    ]);

    if (sessionRes.status === "fulfilled" && sessionRes.value.ok) {
      const sessionJson = await sessionRes.value.json();
      const batchLesson = sessionJson?.data?.attributes?.batch_lesson;
      if (batchLesson) {
        title = batchLesson.title || "N/A";
        startTime = batchLesson.start_time || "N/A";
        duration = batchLesson.duration || "N/A";
      }
    }

    if (metaRes.status === "fulfilled" && metaRes.value.ok) {
      const metaJson = await metaRes.value.json();
      courseName = metaJson?.data?.attributes?.academy_module?.name || "N/A";
    }
  } catch (err) {
    console.error("[Scaler++] Error fetching classroom metadata:", err);
  }

  let formattedStartTime = startTime;
  if (startTime && startTime !== "N/A") {
    const date = new Date(startTime);
    if (!Number.isNaN(date.getTime())) formattedStartTime = date.toLocaleString();
  }

  const formattedDuration =
    duration && duration !== "N/A" ? `${duration} minutes` : duration;

  const generatedBy = attribution.generatedBy || "N/A";
  const modelUsed =
    [attribution.provider, attribution.model].filter(Boolean).join(", ") || "N/A";

  return (
    `Course Name: ${courseName}\n` +
    `Lecture Title: ${title}\n` +
    `Start Time: ${formattedStartTime}\n` +
    `Duration: ${formattedDuration}\n` +
    `Generated by: ${generatedBy}\n` +
    `Model use: ${modelUsed}\n` +
    `Downloaded via: Scaler++ Chrome Extension\n` +
    `Developer: Ritesh prajapati\n\n` +
    `==================================================\n\n`
  );
}

// ── Boot ───────────────────────────────────────────────────────────────

async function load() {
  showOnly("loading");

  if (!lectureSlug) {
    els.errorDetail.textContent =
      "No lecture was supplied. Open this page from a lecture on Scaler.";
    showOnly("error");
    return;
  }

  const response = await sendMessage({
    action: "getTranscriptVersions",
    slug: lectureSlug,
    email: userEmail,
  });

  if (!response.success) {
    els.errorDetail.textContent =
      response.error || "Something went wrong reaching the transcript cache.";
    showOnly("error");
    return;
  }

  render(response.data?.versions || []);
}

async function init() {
  els.lectureName.textContent = lectureTitle || "This lecture";
  if (lectureTitle) els.lectureName.classList.remove("placeholder");

  els.createBtn.addEventListener("click", openProcessor);
  els.emptyCreateBtn.addEventListener("click", openProcessor);
  els.retryBtn.addEventListener("click", load);

  userEmail = await getUserEmail();
  await load();
}

init();
