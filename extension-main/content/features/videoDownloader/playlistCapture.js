// ============================================================
// playlistCapture.js
// Multi-part (playlist) lectures. A recording split into parts streams each
// part from its own .m3u8, and the player only requests a part's stream once
// that part plays — so the one URL captured on the user's page is just the
// part that happened to play. This file:
//   - finds the parts listed in the player's playlist panel, and
//   - in a capture tab the service worker opened for that purpose (inactive,
//     muted), plays each part once and reports the stream it loaded.
// Selectors are text-based ("Playlist" heading, "15 minutes" durations, a
// control labelled "playlist"), not Scaler's generated class names.
// ============================================================

const PLAYLIST_DURATION_RE = /(\d+(?:\.\d+)?)\s*(?:min|mins|minutes?)\b/i;
const PLAYLIST_POLL_MS = 250;
// Capture-tab budgets. The service worker gives up after
// CAPTURE_TIMEOUT_MS (videoTracker.js), which must stay above their sum.
const PLAYLIST_PLAYER_TIMEOUT_MS = 20000;
const PLAYLIST_STREAM_TIMEOUT_MS = 10000;
const PLAYLIST_PANEL_TIMEOUT_MS = 3000;
// After a stream's first playlist arrives, how long to keep collecting its
// rendition playlists before moving on.
const PLAYLIST_SETTLE_MS = 1500;

/**
 * Text nodes under `root` whose trimmed text satisfies `test`.
 */
function playlistTextNodes(root, test) {
  const doc = root.ownerDocument || root;
  const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  const out = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (test(n.nodeValue.trim())) out.push(n);
  }
  return out;
}

/**
 * The parts listed in the player's playlist panel, in order, or [] when the
 * panel isn't rendered (closed, or a single-video lecture).
 *
 * The panel is found from its "Playlist" heading, then widened until it holds
 * at least one duration ("15 minutes"). Each duration's item is the widest
 * element around it that holds no other duration; the label is the item's
 * text without the duration, and `target` (what gets clicked) is the label's
 * own element, so the click bubbles through whatever element holds the handler.
 * @returns {{label: string, minutes: (number|null), target: Element}[]}
 */
function findPlaylistParts(root = document) {
  const headingNode = playlistTextNodes(
    root.body || root,
    (t) => t.toLowerCase() === "playlist",
  )[0];
  if (!headingNode) return [];

  let panel = headingNode.parentElement;
  let durations = [];
  for (let depth = 0; panel && depth < 8; depth++, panel = panel.parentElement) {
    durations = playlistTextNodes(panel, (t) => t.length < 40 && PLAYLIST_DURATION_RE.test(t));
    if (durations.length) break;
  }
  if (!panel || !durations.length) return [];

  const holds = (el) => durations.filter((d) => el.contains(d)).length;
  return durations.map((durationNode, i) => {
    let item = durationNode.parentElement;
    while (item.parentElement && item.parentElement !== panel && holds(item.parentElement) === 1) {
      item = item.parentElement;
    }
    const durationText = durationNode.nodeValue.trim();
    // Icon fonts render glyphs from ligature text (<i>videocam</i>); skip
    // those, and prefer a "Part N" text when there is one.
    const candidates = playlistTextNodes(item, (t) => t && t !== durationText).filter(
      (n) =>
        n.parentElement.localName !== "i" &&
        !/icon/i.test(n.parentElement.getAttribute("class") || ""),
    );
    const labelNode = candidates.find((n) => /^part\s*\d+/i.test(n.nodeValue.trim())) || candidates[0];
    const label = labelNode ? labelNode.nodeValue.trim().replace(/\s+/g, " ") : `Part ${i + 1}`;
    return {
      label,
      minutes: parseFloat(durationText.match(PLAYLIST_DURATION_RE)[1]),
      target: labelNode ? labelNode.parentElement : item,
    };
  });
}

/**
 * The control that opens/closes the playlist panel ("Toggle playlist (P)"),
 * or null. Looked up by its label attributes inside the player controls.
 */
function findPlaylistToggle(root = document) {
  const scope = root.querySelector(".vp-controls") || root;
  const attrs = ["title", "aria-label", "data-tip", "data-tooltip", "data-title"];
  return (
    Array.from(scope.querySelectorAll(attrs.map((a) => `[${a}]`).join(","))).find((el) =>
      attrs.some((a) => /playlist/i.test(el.getAttribute(a) || "")),
    ) || null
  );
}

/**
 * Does this recording look multi-part? Decided by the panel's item count when
 * it's open; when it's closed, by whether the player has a playlist control.
 */
function lectureHasPlaylist(root = document) {
  const parts = findPlaylistParts(root);
  if (parts.length) return parts.length >= 2;
  return !!findPlaylistToggle(root);
}

/**
 * Report every .m3u8 the page requests, using the same PerformanceObserver
 * technique as videoDownloader.js. Returns a function that stops watching.
 */
function watchM3u8Requests(onUrl) {
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      if (entry.name && entry.name.includes(".m3u8")) onUrl(entry.name);
    }
  });
  observer.observe({ type: "resource", buffered: true });
  return () => observer.disconnect();
}

/**
 * Resolve with check()'s first truthy value, or null after `timeoutMs`.
 * Polling, bounded by the deadline: resource entries and a player mounting in
 * a background tab have no single event to wait on.
 */
function playlistWaitFor(check, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      let value = null;
      try {
        value = check();
      } catch (_) {
        /* not there yet */
      }
      if (value) resolve(value);
      else if (Date.now() >= deadline) resolve(null);
      else setTimeout(poll, PLAYLIST_POLL_MS);
    };
    poll();
  });
}

function playlistSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The player's own Play control: labelled "Play", or showing the text "Play"
 * (the big overlay on an unstarted recording).
 */
function findPlayControl(root = document) {
  const labelled = Array.from(root.querySelectorAll("[aria-label],[title]")).find((el) =>
    /^play$/i.test((el.getAttribute("aria-label") || el.getAttribute("title") || "").trim()),
  );
  if (labelled) return labelled;
  const textNode = playlistTextNodes(root.body || root, (t) => t.toLowerCase() === "play")[0];
  return textNode ? textNode.parentElement : null;
}

/**
 * Fetch a playlist's text, or null. Runs in the Scaler page's context, which
 * the CDN already serves (the player fetched the same URL).
 */
async function playlistFetchText(url) {
  try {
    const res = await fetch(url);
    return res.ok ? await res.text() : null;
  } catch (_) {
    return null;
  }
}

/**
 * Capture-tab job: start the player, then play each playlist part once and
 * record the stream it loaded. Without a playlist the single stream is
 * reported as one part with an empty label.
 *
 * A part that was already playing loads nothing new when clicked; it gets the
 * stream requested before the part clicks, when that is unambiguous. A part
 * whose stream never showed up is reported with url: null, so callers can
 * refuse to build an incomplete transcript.
 * @param {object} [deps] injectable for tests: root, watch, fetchText, timing
 * @returns {Promise<{ok: boolean, parts?: {label, minutes, url}[], error?: string}>}
 */
async function capturePlaylistStreams({
  root = document,
  watch = watchM3u8Requests,
  fetchText = playlistFetchText,
  timing = {},
} = {}) {
  const t = {
    player: PLAYLIST_PLAYER_TIMEOUT_MS,
    stream: PLAYLIST_STREAM_TIMEOUT_MS,
    panel: PLAYLIST_PANEL_TIMEOUT_MS,
    settle: PLAYLIST_SETTLE_MS,
    ...timing,
  };
  // Every playlist request, in order, repeats included: switching back to a
  // part re-requests its playlist, and that has to count as "this part loaded".
  const seen = [];
  const stop = watch((url) => seen.push(url));

  // One stream's requests → its URL. Signed URLs get a new query on every
  // request, so repeats are dropped by path first.
  const pickStream = async (urls) => {
    const keys = new Set();
    const entries = [];
    for (const url of urls) {
      const key = hlsStreamKey(url);
      if (keys.has(key)) continue;
      keys.add(key);
      entries.push({ url, text: await fetchText(url) });
    }
    return hlsChooseTopLevelStream(entries);
  };

  try {
    if (!(await playlistWaitFor(() => root.querySelector(".vp-controls"), t.player))) {
      return { ok: false, error: "The recording player never appeared in the background tab." };
    }

    // The player's own Play control is what makes it request the stream; a
    // muted play() on the element is the fallback.
    const playControl = findPlayControl(root);
    if (playControl) playControl.click();
    if (!(await playlistWaitFor(() => seen.length > 0, t.stream))) {
      const video = root.querySelector("video");
      if (video) {
        video.muted = true;
        try {
          Promise.resolve(video.play()).catch(() => {});
        } catch (_) {
          /* play() unsupported */
        }
      }
      if (!(await playlistWaitFor(() => seen.length > 0, t.stream))) {
        return { ok: false, error: "The player never requested its stream." };
      }
    }
    await playlistSleep(t.settle);
    const initial = seen.slice();

    let parts = findPlaylistParts(root);
    if (parts.length < 2) {
      const toggle = findPlaylistToggle(root);
      if (toggle) {
        toggle.click();
        parts =
          (await playlistWaitFor(() => {
            const found = findPlaylistParts(root);
            return found.length >= 2 ? found : null;
          }, t.panel)) || findPlaylistParts(root);
      }
    }
    if (parts.length < 2) {
      return { ok: true, parts: [{ label: "", minutes: null, url: await pickStream(initial) }] };
    }

    // Last part first: a fresh page plays Part 1, so every click then switches
    // streams. Clicking the part already playing loads nothing and costs a
    // full stream timeout, so it should come up at most once, as late as possible.
    const requested = new Array(parts.length);
    for (let i = parts.length - 1; i >= 0; i--) {
      const before = seen.length;
      parts[i].target.click();
      if (await playlistWaitFor(() => seen.length > before, t.stream)) {
        await playlistSleep(t.settle);
      }
      requested[i] = seen.slice(before);
    }
    const streams = [];
    for (const urls of requested) streams.push(urls.length ? await pickStream(urls) : null);

    // The part that was already playing loaded nothing when clicked: it owns
    // the stream loaded before the clicks — but only if it is the one part
    // left without a stream and no other part turned out to own that stream.
    // Otherwise a part that simply failed to load would be handed another
    // part's video.
    const missing = streams.flatMap((url, i) => (url ? [] : [i]));
    const initialUrl = initial.length ? await pickStream(initial) : null;
    const owned = new Set(streams.filter(Boolean).map(hlsStreamKey));
    if (missing.length === 1 && initialUrl && !owned.has(hlsStreamKey(initialUrl))) {
      streams[missing[0]] = initialUrl;
    }
    return {
      ok: true,
      parts: parts.map((part, i) => ({ label: part.label, minutes: part.minutes, url: streams[i] })),
    };
  } finally {
    stop();
    try {
      const video = root.querySelector("video");
      if (video) video.pause();
    } catch (_) {
      /* the tab is about to close anyway */
    }
  }
}

/**
 * Entry point. Lecture pages ask the service worker whether this tab is one
 * it opened for capture; only then does the capture job run, and its result
 * goes back as CAPTURE_RESULT. Every other tab stops at the question.
 */
async function initPlaylistCapture() {
  if (!/\/class\/\d+/.test(location.pathname)) return;
  let reply = null;
  try {
    reply = await chrome.runtime.sendMessage({ type: "IS_CAPTURE_TAB" });
  } catch (_) {
    return; // extension reloaded or worker unavailable
  }
  if (!reply || !reply.capture) return;

  let result;
  try {
    result = await capturePlaylistStreams();
  } catch (err) {
    result = { ok: false, error: err.message };
  }
  try {
    await chrome.runtime.sendMessage({ type: "CAPTURE_RESULT", ...result });
  } catch (_) {
    /* the worker gave up on this tab already */
  }
}

if (typeof chrome !== "undefined" && chrome.runtime?.id) {
  initPlaylistCapture();
}
