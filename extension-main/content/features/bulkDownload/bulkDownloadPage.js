// ============================================================
// features/bulkDownload/bulkDownloadPage.js
// The bulk download page. Works through the job a subject's class list sent
// (bulkDownload.js → START_BULK_DOWNLOAD in videoTracker.js), writing every
// file into one folder the user picks:
//   - transcripts from the shared cache; optionally, lectures nobody has
//     transcribed are generated one at a time in a background
//     transcriptProcessor.html tab (mode=bulk) with the user's saved key;
//   - video / audio: every part's stream via a capture tab
//     (CAPTURE_LECTURE_STREAMS), downloaded by the shared HLS engine.
// ============================================================

// Lectures worked on at once: the user's choice, remembered, clamped to this.
const BULK_PARALLEL_DEFAULT = 2;
const BULK_PARALLEL_MAX = 6;
const BULK_SETTINGS_KEY = "scaler_bulk_settings";
const BULK_KINDS = ["transcript", "video", "audio"];
const BULK_KIND_LABELS = { transcript: "Transcript", video: "Video", audio: "Audio" };

const job = parseBulkJob(location.hash);

const els = {
  subject: document.getElementById("subject"),
  summary: document.getElementById("summary"),
  notice: document.getElementById("notice"),
  start: document.getElementById("start-btn"),
  cancel: document.getElementById("cancel-btn"),
  retry: document.getElementById("retry-btn"),
  headRow: document.getElementById("head-row"),
  rows: document.getElementById("rows"),
  logs: document.getElementById("logs"),
  settings: document.getElementById("settings"),
  parallel: document.getElementById("parallel-input"),
  generateRow: document.getElementById("generate-row"),
  generate: document.getElementById("generate-input"),
  providerBox: document.getElementById("provider-config"),
};

const kinds = job ? BULK_KINDS.filter((k) => job.types[k]) : [];
const cells = new Map(); // `${classId}:${kind}` → <td>
const failed = new Set(); // classIds with a failed task, for "Retry failed"
const slugs = new Map(); // classId → Promise<slug|null>

let outputDir = null; // FileSystemDirectoryHandle; null = browser downloads
let zip = null; // transcripts collected for one .zip when there is no folder
let controller = null;
let running = false;
let generationChain = Promise.resolve(); // generated transcripts run one at a time
let providerConfig = null; // shared provider fields (transcriptProviderConfig.js)
let generateMissing = false; // fixed for a run when it starts

// ── Page ───────────────────────────────────────────────────────────────────

function log(line) {
  els.logs.hidden = false;
  const div = document.createElement("div");
  div.textContent = line;
  els.logs.appendChild(div);
  els.logs.scrollTop = els.logs.scrollHeight;
}

function setStatus(lecture, kind, text, tone = "") {
  const cell = cells.get(`${lecture.classId}:${kind}`);
  if (!cell) return;
  cell.textContent = text;
  cell.className = `status ${tone}`.trim();
}

function showNotice(text) {
  els.notice.textContent = text;
  els.notice.hidden = false;
}

function render() {
  els.subject.textContent = job.subject || "";
  const what = kinds.map((k) => BULK_KIND_LABELS[k].toLowerCase()).join(", ");
  els.summary.textContent = `${job.lectures.length} lecture${job.lectures.length === 1 ? "" : "s"} · ${what}`;

  for (const kind of kinds) {
    const th = document.createElement("th");
    th.textContent = BULK_KIND_LABELS[kind];
    els.headRow.appendChild(th);
  }
  for (const lecture of job.lectures) {
    const tr = document.createElement("tr");
    const num = document.createElement("td");
    num.className = "num";
    num.textContent = lecture.index;
    const when = document.createElement("td");
    when.className = "when";
    when.textContent = lecture.stamp;
    const title = document.createElement("td");
    title.textContent = lecture.title || `Lecture ${lecture.classId}`;
    tr.append(num, when, title);
    for (const kind of kinds) {
      const td = document.createElement("td");
      td.className = "status muted";
      td.textContent = "Waiting";
      cells.set(`${lecture.classId}:${kind}`, td);
      tr.appendChild(td);
    }
    els.rows.appendChild(tr);
  }
}

// ── Plumbing ───────────────────────────────────────────────────────────────

/** chrome.runtime.sendMessage as a promise; null on any failure. */
function sendMessage(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        resolve(chrome.runtime.lastError ? null : response || null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/** The lecture's slug (the transcript cache key), fetched once per lecture. */
function lectureSlug(classId) {
  if (!slugs.has(classId)) {
    slugs.set(
      classId,
      fetch(`https://www.scaler.com/api/v2/classroom/${classId}/meta`, { credentials: "include" })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => json?.data?.attributes?.slug || null)
        .catch(() => null),
    );
  }
  return slugs.get(classId);
}

function trackDownload(type, lecture, slug, attribution = {}) {
  try {
    chrome.storage.sync.get(["scaler_user"], (result) => {
      const email = result?.scaler_user?.email;
      if (!email) return;
      chrome.runtime.sendMessage(
        {
          action: "trackDownload",
          email,
          downloadType: type,
          lecture: lecture.title,
          lectureSlug: slug || "",
          ...attribution,
        },
        () => void chrome.runtime.lastError,
      );
    });
  } catch (_) {
    /* tracking must never break a download */
  }
}

/** Every part's stream for a lecture: [{label, url}] (label "" for one part). */
async function lectureParts(lecture) {
  const result = await sendMessage({
    type: "CAPTURE_LECTURE_STREAMS",
    lectureUrl: lecture.url,
    lectureKey: lecture.classId,
  });
  if (!result || !result.ok) {
    throw new Error(result?.error || "Couldn't find the lecture's stream.");
  }
  const parts = (result.parts || []).map((part, i) => ({
    label: result.parts.length > 1 ? part.label || `Part ${i + 1}` : "",
    url: part.url,
  }));
  if (!parts.length) throw new Error("Couldn't find the lecture's stream.");
  return parts;
}

// ── Output ─────────────────────────────────────────────────────────────────

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function writeTextFile(name, text) {
  if (outputDir) {
    const handle = await outputDir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(text);
      await writable.close();
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
  } else if (zip) {
    zip.file(name, text);
  } else {
    downloadBlob(new Blob([text], { type: "text/plain" }), name);
  }
}

/**
 * Download one stream into `name`. Streams to disk when a folder was picked
 * (RAM stays flat); otherwise buffers in memory and hands over a file.
 */
async function downloadStream(url, kind, name, onPercent, signal) {
  const engine = createHlsEngine({
    sourceTabId: job.sourceTabId ?? undefined,
    // Recordings come from www.scaler.com, which the extension can fetch
    // itself; relaying every chunk through the subject tab caps throughput.
    directFirst: true,
    type: kind,
    signal,
    onLog: (line) => {
      if (line.startsWith("⚠")) log(`${name}: ${line}`);
    },
    onProgress: (done, total) => onPercent(Math.floor((done / total) * 100)),
  });
  const segments = await engine.resolveSegments(url);
  const extractor = kind === "audio" ? new TSAudioExtractor() : null;

  if (!outputDir) {
    const buffer = await engine.downloadToMemory(segments, extractor);
    downloadBlob(new Blob([buffer], { type: kind === "audio" ? "audio/mpeg" : "video/mp4" }), name);
    return;
  }
  const handle = await outputDir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await engine.downloadConcurrently(segments, writable, extractor);
    await writable.close();
  } catch (err) {
    // Leave no half-written file behind.
    await writable.abort().catch(() => {});
    await outputDir.removeEntry(name).catch(() => {});
    throw err;
  }
}

// ── Transcripts ────────────────────────────────────────────────────────────

/**
 * Wait for the background processor tab to report (BULK_TRANSCRIPT_DONE),
 * then close it. Rejects if it fails, is closed, or the run is cancelled.
 */
function awaitGeneratedTranscript(tabId, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      signal.removeEventListener("abort", onAbort);
    };
    const closeTab = () => chrome.tabs.remove(tabId, () => void chrome.runtime.lastError);
    const onMessage = (msg, sender) => {
      if (msg?.type !== "BULK_TRANSCRIPT_DONE" || sender.tab?.id !== tabId) return;
      cleanup();
      closeTab();
      if (msg.ok && msg.text) resolve({ text: msg.text, partial: !!msg.partial });
      else reject(new Error(msg.error || "Transcription failed."));
    };
    const onRemoved = (id) => {
      if (id !== tabId) return;
      cleanup();
      reject(new Error("The transcription tab was closed."));
    };
    const onAbort = () => {
      cleanup();
      closeTab();
      reject(new DOMException("Cancelled.", "AbortError"));
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.tabs.onRemoved.addListener(onRemoved);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Transcribe a lecture nobody has transcribed: the regular processor page,
 * in a background tab, in bulk mode (starts itself with the saved provider,
 * caches the result as usual, and reports the text back here).
 */
async function generateTranscript(lecture, slug, signal) {
  setStatus(lecture, "transcript", "Finding the stream…", "busy");
  const parts = await lectureParts(lecture);
  const missing = parts.filter((p) => !p.url);
  if (missing.length) {
    throw new Error(`Couldn't find the stream for ${missing.map((p) => p.label).join(", ")}.`);
  }
  const query = new URLSearchParams({
    url: parts[0].url,
    type: "transcript",
    title: lecture.title,
    lectureSlug: slug,
    classId: lecture.classId,
    sourceTabId: job.sourceTabId == null ? "" : String(job.sourceTabId),
    mode: "bulk",
  });
  if (parts.length > 1) query.set("parts", JSON.stringify(parts));

  setStatus(lecture, "transcript", "Transcribing (background tab)…", "busy");
  const tab = await chrome.tabs.create({
    url: chrome.runtime.getURL(`content/features/videoDownloader/transcriptProcessor.html?${query}`),
    active: false,
  });
  return awaitGeneratedTranscript(tab.id, signal);
}

async function doTranscript(lecture, signal) {
  setStatus(lecture, "transcript", "Checking the cache…", "busy");
  const slug = await lectureSlug(lecture.classId);
  if (!slug) throw new Error("Couldn't read the lecture's details from Scaler.");

  const reply = await sendMessage({ action: "checkTranscriptCache", slug });
  const cached = reply?.success ? reply.data : null;
  if (cached?.cached && cached.text) {
    const attribution = {
      provider: cached.provider || "",
      model: cached.model || cached.modelName || "",
    };
    const header = await fetchMetadataHeader(lecture.classId, attribution);
    await writeTextFile(bulkFileName(lecture, "txt"), header + cached.text);
    if (cached.versionId) {
      sendMessage({ action: "recordVersionDownload", versionId: cached.versionId });
    }
    trackDownload("transcript", lecture, slug, {
      source: "cache",
      ...attribution,
      versionId: cached.versionId || "",
    });
    setStatus(lecture, "transcript", "Saved", "good");
    return;
  }

  if (!generateMissing) {
    setStatus(lecture, "transcript", "Not transcribed yet", "muted");
    return;
  }

  setStatus(lecture, "transcript", "Queued to transcribe", "muted");
  const run = generationChain.then(() => {
    if (signal.aborted) throw new DOMException("Cancelled.", "AbortError");
    return generateTranscript(lecture, slug, signal);
  });
  generationChain = run.catch(() => {});
  // The processor tab already prepended the header, cached it and tracked it.
  const generated = await run;
  await writeTextFile(bulkFileName(lecture, "txt"), generated.text);
  if (generated.partial) {
    setStatus(lecture, "transcript", "Saved, with gaps (some audio failed)", "bad");
    log(`#${lecture.index} Transcript: some chunks failed to transcribe; the file has gaps.`);
  } else {
    setStatus(lecture, "transcript", "Saved (new)", "good");
  }
}

// ── Video / audio ──────────────────────────────────────────────────────────

async function doMedia(lecture, mediaKinds, signal) {
  for (const kind of mediaKinds) setStatus(lecture, kind, "Finding the stream…", "busy");
  const parts = await lectureParts(lecture);
  const slug = await lectureSlug(lecture.classId);

  for (const kind of mediaKinds) {
    try {
      const ext = kind === "audio" ? "mp3" : "mp4";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const tag = parts.length > 1 ? `${part.label}: ` : "";
        if (!part.url) throw new Error(`Couldn't find the stream for ${part.label}.`);
        await downloadStream(
          part.url,
          kind,
          bulkFileName(lecture, ext, part.label),
          (pct) => setStatus(lecture, kind, `${tag}${pct}%`, "busy"),
          signal,
        );
      }
      trackDownload(kind, lecture, slug);
      setStatus(lecture, kind, parts.length > 1 ? `Saved (${parts.length} parts)` : "Saved", "good");
    } catch (err) {
      reportFailure(lecture, kind, err);
    }
  }
}

// ── Run ────────────────────────────────────────────────────────────────────

function reportFailure(lecture, kind, err) {
  if (err && err.name === "AbortError") {
    setStatus(lecture, kind, "Cancelled", "muted");
    return;
  }
  failed.add(lecture.classId);
  setStatus(lecture, kind, `Failed: ${err?.message || err}`, "bad");
  log(`#${lecture.index} ${BULK_KIND_LABELS[kind]}: ${err?.message || err}`);
}

async function processLecture(lecture, signal) {
  if (job.types.transcript) {
    try {
      await doTranscript(lecture, signal);
    } catch (err) {
      reportFailure(lecture, "transcript", err);
    }
  }
  const mediaKinds = ["video", "audio"].filter((k) => job.types[k]);
  if (mediaKinds.length && !signal.aborted) {
    try {
      await doMedia(lecture, mediaKinds, signal);
    } catch (err) {
      mediaKinds.forEach((kind) => reportFailure(lecture, kind, err));
    }
  }
}

async function run(lectures) {
  running = true;
  controller = new AbortController();
  const { signal } = controller;
  els.start.hidden = true;
  els.retry.hidden = true;
  els.cancel.hidden = false;
  setSettingsDisabled(true);
  lectures.forEach((lecture) => {
    failed.delete(lecture.classId);
    kinds.forEach((kind) => setStatus(lecture, kind, "Queued", "muted"));
  });

  try {
    await runWithConcurrency(lectures, parallelCount(), (l) => processLecture(l, signal), signal);
    lectures.forEach((lecture) =>
      kinds.forEach((kind) => {
        const cell = cells.get(`${lecture.classId}:${kind}`);
        if (cell && cell.textContent === "Queued") setStatus(lecture, kind, "Cancelled", "muted");
      }),
    );

    if (zip && Object.keys(zip.files).length) {
      const blob = await zip.generateAsync({ type: "blob" });
      downloadBlob(blob, `${bulkSafeName(job.subject) || "Scaler"} transcripts.zip`);
      zip = new JSZip();
    }
  } finally {
    running = false;
    controller = null;
    setSettingsDisabled(false);
    els.cancel.hidden = true;
    els.retry.hidden = failed.size === 0;
    els.summary.textContent = failed.size
      ? `Finished with ${failed.size} lecture${failed.size === 1 ? "" : "s"} failed — see the table.`
      : "Finished.";
  }
}

// ── Settings ───────────────────────────────────────────────────────────────

/** "Lectures at a time" from the field, clamped to 1…BULK_PARALLEL_MAX. */
function parallelCount() {
  const n = parseInt(els.parallel.value, 10);
  return Math.min(BULK_PARALLEL_MAX, Math.max(1, Number.isFinite(n) ? n : BULK_PARALLEL_DEFAULT));
}

function setSettingsDisabled(disabled) {
  els.settings.querySelectorAll("input, select, button").forEach((el) => {
    el.disabled = disabled;
  });
}

function initSettings() {
  els.parallel.max = String(BULK_PARALLEL_MAX);
  chrome.storage.local.get([BULK_SETTINGS_KEY], (result) => {
    const saved = result[BULK_SETTINGS_KEY];
    els.parallel.value = String(saved?.parallel || BULK_PARALLEL_DEFAULT);
  });
  els.parallel.addEventListener("change", () => {
    els.parallel.value = String(parallelCount());
    chrome.storage.local.set({ [BULK_SETTINGS_KEY]: { parallel: parallelCount() } });
  });

  // Generating needs the same provider fields as the transcript page; the
  // background transcript tabs start from what is saved here.
  if (!job.types.transcript) return;
  els.generateRow.hidden = false;
  els.generate.checked = job.generateMissing;
  providerConfig = mountProviderConfig(els.providerBox);
  const syncProvider = () => {
    els.providerBox.hidden = !els.generate.checked;
  };
  els.generate.addEventListener("change", syncProvider);
  syncProvider();
}

// ── Boot ───────────────────────────────────────────────────────────────────

if (!job) {
  els.summary.textContent = "Nothing to download — start again from a subject's class list.";
  els.start.disabled = true;
} else {
  render();
  initSettings();

  els.start.addEventListener("click", async () => {
    els.notice.hidden = true;
    generateMissing = !!(job.types.transcript && els.generate.checked);
    // Checked before the folder picker: a run that would fail on its first
    // untranscribed lecture shouldn't start.
    if (generateMissing && providerConfig) {
      const { baseUrl, apiKey } = providerConfig.values();
      if (!baseUrl || !apiKey) {
        showNotice("Enter the provider's Base URL and API key to transcribe lectures, or untick that option.");
        return;
      }
      providerConfig.save();
    }
    // The folder picker needs the click's user activation, so it must be the
    // first await. Brave blocks the API; Firefox has none.
    if (typeof window.showDirectoryPicker === "function" && !navigator.brave) {
      try {
        outputDir = await window.showDirectoryPicker({ id: "scalerpp-bulk", mode: "readwrite" });
      } catch (err) {
        if (err.name === "AbortError") return;
        outputDir = null;
      }
    }
    if (!outputDir) {
      if (typeof JSZip === "function") zip = new JSZip();
      showNotice(
        "This browser can't save into a folder, so transcripts arrive as one .zip at the end and " +
          "each video/audio file is held in memory until it finishes — keep long lectures to a " +
          "few at a time.",
      );
    }
    run(job.lectures);
  });

  els.cancel.addEventListener("click", () => {
    if (controller) controller.abort();
  });

  els.retry.addEventListener("click", () => {
    run(job.lectures.filter((l) => failed.has(l.classId)));
  });

  window.addEventListener("beforeunload", (e) => {
    if (!running) return;
    e.preventDefault();
    e.returnValue = "";
  });
}
